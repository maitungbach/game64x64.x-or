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
    assert.strictEqual(
      typeof game.scheduleCollectibleSpawning,
      'function',
      'scheduleCollectibleSpawning should be exported'
    );

    const room = game.createRoom('host-user', { gameDurationSec: 0.05 });
    assert.strictEqual(game.joinRoom(room.id, 'guest-user').ok, true, 'guest should join room');

    const started = game.startRoomGame(room.id);
    assert.strictEqual(started.ok, true, 'room should start once two players are present');

    const spawned = await game.scheduleCollectibleSpawning(room.id);
    assert.strictEqual(spawned, true, 'room should spawn collectibles after starting');

    const collectibles = game.getCollectiblesForRoom(room.id);
    assert(collectibles.length >= 1, 'playing room should expose collectible tiles');

    const firstCollectible = collectibles[0];
    const picked = game.checkCollectiblePickup(firstCollectible.x, firstCollectible.y, 'host-socket', room.id);
    assert.deepStrictEqual(
      picked && {
        id: picked.id,
        x: picked.x,
        y: picked.y,
        points: picked.points,
      },
      {
        id: firstCollectible.id,
        x: firstCollectible.x,
        y: firstCollectible.y,
        points: firstCollectible.points,
      },
      'pickup should return the collectible that was on the cell'
    );
    assert.strictEqual(
      game.addRoomScore(room.id, 'host-user', picked.points),
      picked.points,
      'host score should update from collected tile'
    );

    await delay(120);

    const roomEndedEvent = emitted.find(
      (entry) => entry.roomId === room.id && entry.event === 'roomEnded'
    );
    assert(roomEndedEvent, 'roomEnded event should be emitted after timer expires');
    assert.deepStrictEqual(roomEndedEvent.payload.leaderboard, [
      { rank: 1, playerId: 'host-user', score: picked.points },
      { rank: 2, playerId: 'guest-user', score: 0 },
    ]);
    assert.strictEqual(roomEndedEvent.payload.winningScore, picked.points, 'winning score should be exposed');
    assert.deepStrictEqual(
      roomEndedEvent.payload.winnerIds,
      ['host-user'],
      'winnerIds should identify the winning player'
    );

    const endedRoom = game.getRoomById(room.id);
    assert(endedRoom, 'room should still exist after ending');
    assert.strictEqual(endedRoom.status, 'ended', 'room status should be ended');
    assert.deepStrictEqual(game.getCollectiblesForRoom(room.id), [], 'collectibles should clear when room ends');

    const leaveResult = game.leaveRoom(room.id, 'host-user');
    assert.strictEqual(leaveResult.closed, true, 'host leaving should close the room');
    assert.strictEqual(game.getRoomById(room.id), null, 'closed room should be removed');

    console.log('PASS room service: collectibles + timed room end + winner');
  } finally {
    game.shutdown();
  }
}

run().catch((error) => {
  console.error('FAIL room service:', error.message);
  process.exit(1);
});
