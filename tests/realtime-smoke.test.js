const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const assert = require('assert');
const { io } = require('socket.io-client');

const TEST_PORT = 3101;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, timeoutMs = 4000, intervalMs = 30) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await delay(intervalMs);
  }
  throw new Error('Timeout waiting for condition');
}

function waitForServerReady(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function probe() {
      const req = http.get(`${BASE_URL}/health`, (res) => {
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });

      req.on('error', retry);
    }

    function retry() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Server healthcheck timeout'));
        return;
      }
      setTimeout(probe, 100);
    }

    probe();
  });
}

function connectClient() {
  return io(BASE_URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 4000,
  });
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connect timeout')), 4000);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });

    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.killed) {
    return;
  }

  const exited = new Promise((resolve) => {
    server.once('exit', resolve);
  });

  server.kill();
  await Promise.race([exited, delay(600)]);
}

async function run() {
  const server = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      NODE_ENV: 'test',
      ENABLE_REDIS: 'false',
      AUTH_REQUIRED: 'false',
      AUTH_REQUIRE_MONGO: 'false',
      STRICT_CLUSTER_CONFIG: 'false',
      MONGO_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';

  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  let c1 = null;
  let c2 = null;
  let c3 = null;

  try {
    await waitForServerReady();

    c1 = connectClient();
    c2 = connectClient();
    c3 = connectClient();

    const state = {
      c1: [],
      c2: [],
      c3: [],
    };

    c1.on('updatePlayers', (players) => {
      state.c1 = Array.isArray(players) ? players : [];
    });

    c2.on('updatePlayers', (players) => {
      state.c2 = Array.isArray(players) ? players : [];
    });

    c3.on('updatePlayers', (players) => {
      state.c3 = Array.isArray(players) ? players : [];
    });

    await Promise.all([waitForConnect(c1), waitForConnect(c2), waitForConnect(c3)]);

    await waitFor(() => state.c1.length >= 3);

    const meBefore = state.c1.find((p) => p.id === c1.id);
    assert(meBefore, 'Client 1 not found in player list');

    c1.emit('move', { direction: 'right' });
    await waitFor(() => {
      const p = state.c2.find((player) => player.id === c1.id);
      return Boolean(p && p.x >= meBefore.x);
    });

    const c3Id = c3.id;
    c3.disconnect();

    await waitFor(() => !state.c1.some((p) => p.id === c3Id));

    console.log('PASS realtime smoke: connect/move/disconnect');
  } finally {
    if (c1) {
      c1.disconnect();
    }
    if (c2) {
      c2.disconnect();
    }
    if (c3) {
      c3.disconnect();
    }

    await stopServer(server);

    if (stderr.trim()) {
      console.error(stderr.trim());
    }
  }
}

run().catch((error) => {
  console.error('FAIL realtime smoke:', error.message);
  process.exit(1);
});
