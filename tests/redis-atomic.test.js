const assert = require('assert');
const { createClient } = require('redis');
const { io } = require('socket.io-client');
const { startTestServer } = require('./helpers/server-harness.js');

const TEST_PORT = 3103;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REDIS_PLAYERS_KEY = `test:game64x64:players:${Date.now()}`;
const REDIS_CELLS_KEY = `test:game64x64:cells:${Date.now()}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectClient() {
  return io(BASE_URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 4000,
  });
}

async function main() {
  const redis = createClient({ url: REDIS_URL });
  const ghostPlayer = {
    id: 'ghost-player',
    x: 0,
    y: 0,
    color: '#123456',
  };

  try {
    await redis.connect();
    await redis.ping();
    await redis.hSet(REDIS_PLAYERS_KEY, ghostPlayer.id, JSON.stringify(ghostPlayer));
    await redis.hSet(REDIS_CELLS_KEY, `${ghostPlayer.x}:${ghostPlayer.y}`, ghostPlayer.id);
  } catch (_error) {
    console.log('SKIP redis atomic: Redis is not available on', REDIS_URL);
    process.exit(0);
  } finally {
    try {
      await redis.disconnect();
    } catch (_error) {
      // ignore
    }
  }

  const serverHandle = await startTestServer({
    PORT: String(TEST_PORT),
    NODE_ENV: 'test',
    ENABLE_REDIS: 'true',
    AUTH_REQUIRED: 'false',
    AUTH_REQUIRE_MONGO: 'false',
    STRICT_CLUSTER_CONFIG: 'false',
    MONGO_URL: '',
    REDIS_URL,
    REDIS_PLAYERS_KEY,
    REDIS_CELLS_KEY,
    GHOST_SWEEP_INTERVAL_MS: '200',
  });

  const sockets = [];
  let foreignVisibilityDetected = false;

  try {
    await delay(500);

    for (let i = 0; i < 30; i += 1) {
      const socket = connectClient();
      socket.on('updatePlayers', (players) => {
        const list = Array.isArray(players) ? players : [];
        if (list.some((player) => player.id !== socket.id)) {
          foreignVisibilityDetected = true;
        }
      });
      sockets.push(socket);
    }

    await delay(2000);

    const directions = ['up', 'down', 'left', 'right'];
    for (let tick = 0; tick < 40; tick += 1) {
      for (const socket of sockets) {
        if (!socket.connected) {
          continue;
        }
        const direction = directions[Math.floor(Math.random() * directions.length)];
        socket.emit('move', { direction });
      }
      await delay(35);
    }

    await delay(1000);

    assert.strictEqual(
      foreignVisibilityDetected,
      false,
      'Players outside rooms should not see squares from other solo players'
    );

    const verifyRedis = createClient({ url: REDIS_URL });
    await verifyRedis.connect();
    const ghostRaw = await verifyRedis.hGet(REDIS_PLAYERS_KEY, ghostPlayer.id);
    const playersCount = await verifyRedis.hLen(REDIS_PLAYERS_KEY);
    const cellsCount = await verifyRedis.hLen(REDIS_CELLS_KEY);
    await verifyRedis.del(REDIS_PLAYERS_KEY, REDIS_CELLS_KEY);
    await verifyRedis.disconnect();

    assert.strictEqual(ghostRaw, null, 'Expected stale ghost player to be swept');
    assert.strictEqual(playersCount, cellsCount, 'Redis players/cells index mismatch');
    console.log('PASS redis atomic: solo isolation + consistent redis indexes');
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }

    await serverHandle.stop();
  }
}

main().catch((error) => {
  console.error('FAIL redis atomic:', error.message);
  process.exit(1);
});
