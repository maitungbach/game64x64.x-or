const assert = require('assert');
const { createGameService } = require('../src/core/game/game-service.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const emitted = [];
  const io = {
    emit() {},
    fetchSockets: async () => [],
    of() {
      return { sockets: new Map() };
    },
    to(roomId) {
      return {
        emit(event, payload) {
          emitted.push({ roomId, event, payload });
        },
      };
    },
  };

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

  const game = createGameService({
    io,
    stats,
    config: {
      GRID_SIZE: 64,
      MAX_SPAWN_ATTEMPTS: 8,
      BROADCAST_INTERVAL_MS: 5,
      REDIS_PLAYERS_KEY: 'test:players',
      REDIS_CELLS_KEY: 'test:cells',
    },
    getRedisDataClient: () => null,
  });

  try {
    assert.strictEqual(typeof game.addRoomScore, 'function', 'addRoomScore should be exported');
    assert.strictEqual(typeof game.endRoomGame, 'function', 'endRoomGame should be exported');

    const room = game.createRoom('host-user', { gameDurationSec: 0.05 });
    assert.strictEqual(game.joinRoom(room.id, 'guest-user').ok, true, 'guest should join room');

    const started = game.startRoomGame(room.id);
    assert.strictEqual(started.ok, true, 'room should start once two players are present');

    assert.strictEqual(game.addRoomScore(room.id, 'host-user', 2), 2, 'host score should update');
    assert.strictEqual(game.addRoomScore(room.id, 'guest-user', 1), 1, 'guest score should update');

    await delay(120);

    const roomEndedEvent = emitted.find(
      (entry) => entry.roomId === room.id && entry.event === 'roomEnded'
    );
    assert(roomEndedEvent, 'roomEnded event should be emitted after timer expires');
    assert.deepStrictEqual(roomEndedEvent.payload.leaderboard, [
      { rank: 1, playerId: 'host-user', score: 2 },
      { rank: 2, playerId: 'guest-user', score: 1 },
    ]);

    const endedRoom = game.getRoomById(room.id);
    assert(endedRoom, 'room should still exist after ending');
    assert.strictEqual(endedRoom.status, 'ended', 'room status should be ended');

    const leaveResult = game.leaveRoom(room.id, 'host-user');
    assert.strictEqual(leaveResult.closed, true, 'host leaving should close the room');
    assert.strictEqual(game.getRoomById(room.id), null, 'closed room should be removed');

    console.log('PASS room service: scoring + timed room end + host close');
  } finally {
    game.shutdown();
  }
}

run().catch((error) => {
  console.error('FAIL room service:', error.message);
  process.exit(1);
});
