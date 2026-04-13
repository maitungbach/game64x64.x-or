/* eslint-disable no-console */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const { MongoClient } = require('mongodb');
const { asyncRoute } = require('./lib/async-route.js');
const { loadEnvFile } = require('./lib/load-env-file.js');
const { createRuntimeConfig } = require('./core/runtime/runtime-config.js');
const { createAuthService } = require('./core/auth/auth-service.js');
const { createGameService } = require('./core/game/game-service.js');
const { TEST_USERS_SEED } = require('./core/auth/test-users-seed.js');
const { registerAppRoutes } = require('./http/app-routes.js');
const { configureRealtime } = require('./socket/realtime.js');

function createServerRuntime(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, '..');
  const publicDir = options.publicDir || path.join(rootDir, 'public');
  const envFilePath = options.envFilePath || path.join(rootDir, '.env');

  if (options.loadEnvFile !== false) {
    loadEnvFile(envFilePath);
  }

  const packageJson = options.packageJson || require(path.join(rootDir, 'package.json'));
  const config = createRuntimeConfig(packageJson);

  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  const server = http.createServer(app);
  const io = new Server(server, {
    transports: ['websocket'],
    pingInterval: Number(process.env.SOCKET_PING_INTERVAL_MS || 10000),
    pingTimeout: Number(process.env.SOCKET_PING_TIMEOUT_MS || 5000),
  });

  let redisPubClient = null;
  let redisSubClient = null;
  let redisDataClient = null;
  let mongoClient = null;
  let mongoUsers = null;
  let mongoSessions = null;
  let sweepTimer = null;
  let snapshotTimer = null;
  let started = false;
  let stopping = false;

  const stats = {
    connectionsTotal: 0,
    disconnectionsTotal: 0,
    movesReceived: 0,
    movesApplied: 0,
    movesRejectedInvalid: 0,
    movesRejectedRateLimit: 0,
    movesRejectedOccupied: 0,
    errorsTotal: 0,
    broadcastRequestsTotal: 0,
    broadcastsEmitted: 0,
    broadcastsCoalesced: 0,
  };

  const auth = createAuthService({
    config,
    stats,
    TEST_USERS_SEED,
    getRedisDataClient: () => redisDataClient,
    getMongoUsers: () => mongoUsers,
    getMongoSessions: () => mongoSessions,
    getSockets: async () => await io.fetchSockets(),
  });

  const game = createGameService({
    io,
    stats,
    config,
    getRedisDataClient: () => redisDataClient,
  });

  async function getAdminAuthContextFromRequest(req) {
    const authContext = await auth.getAuthenticatedUserFromRequest(req);
    if (!authContext || !auth.isAdminUser(authContext.user)) {
      return null;
    }
    return authContext;
  }

  async function isStatsAuthorized(req) {
    if (!config.STATS_TOKEN) {
      return Boolean(await getAdminAuthContextFromRequest(req));
    }
    if (req.get('x-stats-token') === config.STATS_TOKEN) {
      return true;
    }
    return Boolean(await getAdminAuthContextFromRequest(req));
  }

  function getStatsSnapshot(playersCount) {
    return {
      version: config.APP_VERSION,
      nodeId: config.NODE_ID,
      startedAt: config.STARTED_AT,
      uptimeSec: Math.floor(process.uptime()),
      pid: process.pid,
      redisEnabled: config.ENABLE_REDIS,
      authStorage: auth.getAuthStorageMode(),
      mongoConnected: auth.isMongoConnected(),
      configWarnings: config.getConfigWarnings(),
      playersOnline: playersCount,
      socketsOnline: game.getSocketsOnlineCount(),
      counters: { ...stats },
    };
  }

  function attachRedisClientHandlers(client, name) {
    client.on('error', (error) => {
      if (stopping) {
        return;
      }
      console.error(`[redis:${name}]`, error);
    });
  }

  async function connectRedisIfEnabled() {
    if (!config.ENABLE_REDIS) {
      console.log('[startup] Redis disabled. Using in-memory player store.');
      return;
    }

    redisPubClient = createClient({ url: config.REDIS_URL });
    redisSubClient = redisPubClient.duplicate();
    redisDataClient = redisPubClient.duplicate();

    attachRedisClientHandlers(redisPubClient, 'pub');
    attachRedisClientHandlers(redisSubClient, 'sub');
    attachRedisClientHandlers(redisDataClient, 'data');

    await Promise.all([
      redisPubClient.connect(),
      redisSubClient.connect(),
      redisDataClient.connect(),
    ]);

    io.adapter(createAdapter(redisPubClient, redisSubClient));
    console.log(
      `[startup] Redis enabled at ${config.getRedactedRedisUrl()}. Socket.io adapter active.`
    );
    await game.rebuildRedisCellsIndex();
  }

  async function connectMongoIfEnabled() {
    if (!config.MONGO_URL) {
      return;
    }

    mongoClient = new MongoClient(config.MONGO_URL, { maxPoolSize: 10 });
    await mongoClient.connect();
    const mongoDb = mongoClient.db(config.MONGO_DB_NAME);
    mongoUsers = mongoDb.collection('users');
    mongoSessions = mongoDb.collection('sessions');

    await Promise.all([
      mongoUsers.createIndex({ email: 1 }, { unique: true }),
      mongoUsers.createIndex({ id: 1 }, { unique: true }),
      mongoSessions.createIndex({ token: 1 }, { unique: true }),
      mongoSessions.createIndex({ userId: 1 }),
      mongoSessions.createIndex({ expiresAtDate: 1 }, { expireAfterSeconds: 0 }),
    ]);

    console.log('[startup] MongoDB enabled for auth storage.');
  }

  registerAppRoutes({
    app,
    express,
    path,
    PUBLIC_DIR: publicDir,
    asyncRoute,
    stats,
    config,
    auth,
    game,
    getAdminAuthContextFromRequest,
    isStatsAuthorized,
    getStatsSnapshot,
  });

  configureRealtime(io, {
    config,
    stats,
    auth,
    game,
  });

  async function start() {
    if (started) {
      return runtime;
    }

    stopping = false;

    const configWarnings = config.getConfigWarnings();
    for (const warning of configWarnings) {
      console.warn(`[startup-warning] ${warning}`);
    }

    const configFatalErrors = config.getConfigFatalErrors();
    if (configFatalErrors.length > 0) {
      const error = new Error(configFatalErrors.join('\n'));
      error.code = 'STARTUP_CONFIG';
      error.fatalErrors = configFatalErrors;
      throw error;
    }

    await connectMongoIfEnabled();
    if (config.AUTH_REQUIRE_MONGO && !mongoUsers) {
      throw new Error('[startup] MongoDB is required for auth, but it is not enabled.');
    }

    await connectRedisIfEnabled();
    await auth.ensureSeedUsers();

    if (config.ENABLE_REDIS && config.GHOST_SWEEP_INTERVAL_MS > 0) {
      sweepTimer = setInterval(() => {
        game.sweepGhostPlayers();
      }, config.GHOST_SWEEP_INTERVAL_MS);
      if (typeof sweepTimer.unref === 'function') {
        sweepTimer.unref();
      }
    }

    if (config.SNAPSHOT_INTERVAL_MS > 0) {
      snapshotTimer = setInterval(() => {
        game.scheduleEmitPlayers();
      }, config.SNAPSHOT_INTERVAL_MS);
      if (typeof snapshotTimer.unref === 'function') {
        snapshotTimer.unref();
      }
    }

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.PORT);
    });

    console.log(`Server is running at http://localhost:${config.PORT}`);
    if (config.ENABLE_REDIS) {
      await game.sweepGhostPlayers();
    }

    started = true;
    return runtime;
  }

  async function stop() {
    stopping = true;

    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }

    auth.shutdown();
    game.shutdown();

    await new Promise((resolve) => io.close(() => resolve()));
    await new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });

    const redisClients = [redisPubClient, redisSubClient, redisDataClient].filter(Boolean);
    await Promise.all(
      redisClients.map(async (client) => {
        if (!client?.isOpen) {
          return;
        }
        try {
          client.disconnect();
        } catch (_disconnectError) {
          // Ignore shutdown disconnect failures.
        }
      })
    );

    redisPubClient = null;
    redisSubClient = null;
    redisDataClient = null;

    if (mongoClient) {
      await mongoClient.close();
      mongoClient = null;
      mongoUsers = null;
      mongoSessions = null;
    }

    started = false;
    stopping = false;
  }

  const runtime = {
    app,
    auth,
    config,
    game,
    getAdminAuthContextFromRequest,
    getStatsSnapshot,
    io,
    isStatsAuthorized,
    server,
    start,
    stats,
    stop,
  };

  return runtime;
}

module.exports = {
  createServerRuntime,
};
