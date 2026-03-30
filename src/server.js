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

loadEnvFile(path.join(__dirname, '..', '.env'));

const packageJson = require(path.join(__dirname, '..', 'package.json'));
const config = createRuntimeConfig(packageJson);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket'],
  pingInterval: Number(process.env.SOCKET_PING_INTERVAL_MS || 10000),
  pingTimeout: Number(process.env.SOCKET_PING_TIMEOUT_MS || 5000),
});

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

let redisPubClient = null;
let redisSubClient = null;
let redisDataClient = null;
let mongoClient = null;
let mongoUsers = null;
let mongoSessions = null;
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

function isStatsAuthorized(req) {
  if (!config.STATS_TOKEN) {
    return true;
  }
  return req.get('x-stats-token') === config.STATS_TOKEN;
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

async function connectRedisIfEnabled() {
  if (!config.ENABLE_REDIS) {
    console.log('[startup] Redis disabled. Using in-memory player store.');
    return;
  }

  redisPubClient = createClient({ url: config.REDIS_URL });
  redisSubClient = redisPubClient.duplicate();
  redisDataClient = redisPubClient.duplicate();

  await Promise.all([
    redisPubClient.connect(),
    redisSubClient.connect(),
    redisDataClient.connect(),
  ]);

  io.adapter(createAdapter(redisPubClient, redisSubClient));
  console.log(`[startup] Redis enabled at ${config.REDIS_URL}. Socket.io adapter active.`);
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
  PUBLIC_DIR,
  asyncRoute,
  stats,
  config,
  auth,
  game,
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
  const configWarnings = config.getConfigWarnings();
  if (configWarnings.length > 0) {
    for (const warning of configWarnings) {
      console.warn(`[startup-warning] ${warning}`);
    }
  }

  const configFatalErrors = config.getConfigFatalErrors();
  if (configFatalErrors.length > 0) {
    for (const fatalError of configFatalErrors) {
      console.error(`[startup-config] ${fatalError}`);
    }
    process.exit(1);
  }

  await connectMongoIfEnabled();
  if (config.AUTH_REQUIRE_MONGO && !mongoUsers) {
    console.error('[startup] MongoDB is required for auth, but it is not enabled.');
    process.exit(1);
  }

  await connectRedisIfEnabled();
  await auth.ensureSeedUsers();

  if (config.ENABLE_REDIS && config.GHOST_SWEEP_INTERVAL_MS > 0) {
    const sweepTimer = setInterval(() => {
      game.sweepGhostPlayers();
    }, config.GHOST_SWEEP_INTERVAL_MS);
    if (typeof sweepTimer.unref === 'function') {
      sweepTimer.unref();
    }
  }

  if (config.SNAPSHOT_INTERVAL_MS > 0) {
    const snapshotTimer = setInterval(() => {
      game.scheduleEmitPlayers();
    }, config.SNAPSHOT_INTERVAL_MS);
    if (typeof snapshotTimer.unref === 'function') {
      snapshotTimer.unref();
    }
  }

  server.listen(config.PORT, () => {
    console.log(`Server is running at http://localhost:${config.PORT}`);
    if (config.ENABLE_REDIS) {
      game.sweepGhostPlayers();
    }
  });
}

start().catch((error) => {
  console.error('[startup] failed:', error);
  process.exit(1);
});
