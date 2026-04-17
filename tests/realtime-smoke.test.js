const assert = require('assert');
const { io } = require('socket.io-client');
const { startTestServer } = require('./helpers/server-harness.js');

const TEST_PORT = 3101;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const OBSTACLES = [
  { x: 10, y: 10, w: 5, h: 1 },
  { x: 50, y: 10, w: 1, h: 5 },
  { x: 32, y: 32, w: 4, h: 4 },
  { x: 10, y: 50, w: 10, h: 1 },
  { x: 50, y: 50, w: 2, h: 10 },
];

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

function connectClient(extraHeaders = null) {
  return io(BASE_URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 4000,
    extraHeaders: extraHeaders || undefined,
  });
}

function isWall(x, y) {
  return OBSTACLES.some(
    (wall) => x >= wall.x && x < wall.x + wall.w && y >= wall.y && y < wall.y + wall.h
  );
}

function getNextPosition(player, direction) {
  const next = { x: player.x, y: player.y };
  if (direction === 'up') {
    next.y = Math.max(0, player.y - 1);
  } else if (direction === 'down') {
    next.y = Math.min(63, player.y + 1);
  } else if (direction === 'left') {
    next.x = Math.max(0, player.x - 1);
  } else if (direction === 'right') {
    next.x = Math.min(63, player.x + 1);
  }
  if (isWall(next.x, next.y)) {
    return { x: player.x, y: player.y };
  }
  return next;
}

function pickMoveDirection(player) {
  const directions = ['right', 'left', 'down', 'up'];
  for (const direction of directions) {
    const next = getNextPosition(player, direction);
    if (next.x !== player.x || next.y !== player.y) {
      return direction;
    }
  }
  return 'up';
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

async function run() {
  const serverHandle = await startTestServer({
    PORT: String(TEST_PORT),
    NODE_ENV: 'test',
    ENABLE_REDIS: 'false',
    AUTH_REQUIRED: 'false',
    AUTH_REQUIRE_MONGO: 'false',
    STRICT_CLUSTER_CONFIG: 'false',
    MONGO_URL: '',
  });

  let c1 = null;
  let c2 = null;
  let c3 = null;
  let foreignOriginClient = null;

  try {
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

    await waitFor(
      () =>
        state.c1.length === 1 &&
        state.c1[0]?.id === c1.id &&
        state.c2.length === 1 &&
        state.c2[0]?.id === c2.id &&
        state.c3.length === 1 &&
        state.c3[0]?.id === c3.id
    );

    const meBefore = state.c1.find((player) => player.id === c1.id);
    assert(meBefore, 'Client 1 not found in player list');

    const soloDirection = pickMoveDirection(meBefore);
    const expectedSoloPos = getNextPosition(meBefore, soloDirection);
    c1.emit('move', { direction: soloDirection });
    await waitFor(() => {
      const moved = state.c1.find((player) => player.id === c1.id);
      return Boolean(moved && moved.x === expectedSoloPos.x && moved.y === expectedSoloPos.y);
    });
    await delay(120);
    assert.strictEqual(
      state.c2.some((player) => player.id === c1.id),
      false,
      'Players outside rooms should not see each other'
    );

    const room = serverHandle.runtime.game.createRoom(c1.id, { maxPlayers: 4 });
    let c1RoomJoined = null;
    let c2RoomJoined = null;
    c1.once('roomJoined', (payload) => {
      c1RoomJoined = payload;
    });
    c2.once('roomJoined', (payload) => {
      c2RoomJoined = payload;
    });
    c1.emit('joinRoom', { roomId: room.id });
    c2.emit('joinRoom', { roomId: room.id });

    await waitFor(() => c1RoomJoined?.roomId === room.id && c2RoomJoined?.roomId === room.id);
    await waitFor(
      () =>
        state.c1.length === 2 &&
        state.c2.length === 2 &&
        state.c3.length === 1 &&
        state.c1.some((player) => player.id === c1.id) &&
        state.c1.some((player) => player.id === c2.id) &&
        state.c2.some((player) => player.id === c1.id) &&
        state.c2.some((player) => player.id === c2.id) &&
        state.c3[0]?.id === c3.id
    );

    const roomMeBefore = state.c1.find((player) => player.id === c1.id);
    assert(roomMeBefore, 'Client 1 should still exist after joining room');
    const roomDirection = pickMoveDirection(roomMeBefore);
    const expectedRoomPos = getNextPosition(roomMeBefore, roomDirection);
    c1.emit('move', { direction: roomDirection });
    await waitFor(() => {
      const moved = state.c2.find((player) => player.id === c1.id);
      return Boolean(moved && moved.x === expectedRoomPos.x && moved.y === expectedRoomPos.y);
    });

    let invalidMoveAck = null;
    c1.once('moveAck', (payload) => {
      invalidMoveAck = payload;
    });
    c1.emit('move', { x: roomMeBefore.x + 8, y: roomMeBefore.y + 8, seq: 999 });
    await waitFor(() => invalidMoveAck !== null);
    assert.strictEqual(invalidMoveAck?.ok, false, 'Coordinate teleport should be rejected');
    assert.strictEqual(
      invalidMoveAck?.reason,
      'invalid_coords',
      'Coordinate teleport should return invalid_coords'
    );

    foreignOriginClient = connectClient({ Origin: 'https://evil.example' });
    await assert.rejects(
      waitForConnect(foreignOriginClient),
      /forbidden_origin/,
      'Expected foreign Origin websocket to be rejected'
    );
    foreignOriginClient.close();
    foreignOriginClient = null;

    const c2Id = c2.id;
    c2.disconnect();
    c2 = null;

    await waitFor(
      () =>
        state.c1.length === 1 &&
        state.c1[0]?.id === c1.id &&
        !state.c1.some((player) => player.id === c2Id) &&
        state.c3.length === 1 &&
        state.c3[0]?.id === c3.id
    );

    console.log('PASS realtime smoke: solo isolation + room visibility + disconnect');
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
    if (foreignOriginClient) {
      foreignOriginClient.disconnect();
    }

    await serverHandle.stop();
  }
}

run().catch((error) => {
  console.error('FAIL realtime smoke:', error.message);
  process.exit(1);
});
