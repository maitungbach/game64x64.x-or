/* eslint-disable no-console */
function createGameService(options) {
  const { io, stats, config, getRedisDataClient } = options;

  const players = new Map();
  const lastMoveAt = new Map();
  const VALID_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
  let broadcastTimer = null;
  let broadcastPending = false;
  let broadcastInFlight = false;

  function randomInt(maxExclusive) {
    return Math.floor(Math.random() * maxExclusive);
  }

  function randomColor() {
    return `#${Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, '0')}`;
  }

  function toCellKey(x, y) {
    return `${x}:${y}`;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeSeq(value) {
    if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      return null;
    }
    return value;
  }

  function normalizeCoord(value, max) {
    if (!Number.isFinite(value)) {
      return null;
    }
    return clamp(Math.floor(value), 0, max);
  }

  function parsePlayer(raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.id !== 'string') {
        return null;
      }
      return {
        id: parsed.id,
        x: clamp(Number(parsed.x), 0, config.GRID_SIZE - 1),
        y: clamp(Number(parsed.y), 0, config.GRID_SIZE - 1),
        color: typeof parsed.color === 'string' ? parsed.color : '#999999',
      };
    } catch (_error) {
      return null;
    }
  }

  function usesRedisStorage() {
    return Boolean(getRedisDataClient());
  }

  async function getPlayersList() {
    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      return Array.from(players.values());
    }

    const entries = await redisDataClient.hGetAll(config.REDIS_PLAYERS_KEY);
    const list = [];

    for (const value of Object.values(entries)) {
      const player = parsePlayer(value);
      if (player) {
        list.push(player);
      }
    }

    return list;
  }

  async function getPlayerById(id) {
    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      return players.get(id) || null;
    }

    const raw = await redisDataClient.hGet(config.REDIS_PLAYERS_KEY, id);
    if (!raw) {
      return null;
    }

    return parsePlayer(raw);
  }

  async function savePlayer(player) {
    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      players.set(player.id, player);
      return;
    }

    await redisDataClient.hSet(config.REDIS_PLAYERS_KEY, player.id, JSON.stringify(player));
  }

  async function removePlayer(id) {
    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      players.delete(id);
      return;
    }

    await redisDataClient.eval(
      `
        local playersKey = KEYS[1]
        local cellsKey = KEYS[2]
        local playerId = ARGV[1]
        local raw = redis.call('HGET', playersKey, playerId)
        if raw then
          local ok, player = pcall(cjson.decode, raw)
          if ok and player and player.x ~= nil and player.y ~= nil then
            local cell = tostring(player.x) .. ':' .. tostring(player.y)
            redis.call('HDEL', cellsKey, cell)
          end
        end
        redis.call('HDEL', playersKey, playerId)
        return 1
      `,
      { keys: [config.REDIS_PLAYERS_KEY, config.REDIS_CELLS_KEY], arguments: [id] }
    );
  }

  async function isOccupied(x, y, ignoreId = null) {
    const list = await getPlayersList();
    return list.some((player) => player.id !== ignoreId && player.x === x && player.y === y);
  }

  async function findSpawnPosition() {
    for (let i = 0; i < config.MAX_SPAWN_ATTEMPTS; i += 1) {
      const x = randomInt(config.GRID_SIZE);
      const y = randomInt(config.GRID_SIZE);

      if (!(await isOccupied(x, y))) {
        return { x, y };
      }
    }

    for (let y = 0; y < config.GRID_SIZE; y += 1) {
      for (let x = 0; x < config.GRID_SIZE; x += 1) {
        if (!(await isOccupied(x, y))) {
          return { x, y };
        }
      }
    }

    return null;
  }

  async function rebuildRedisCellsIndex() {
    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      return;
    }

    const entries = await redisDataClient.hGetAll(config.REDIS_PLAYERS_KEY);
    const seen = new Set();
    const normalizedPlayers = [];
    const cellsArgs = [];

    for (const [id, value] of Object.entries(entries)) {
      const player = parsePlayer(value);
      if (!player) {
        continue;
      }

      const cell = toCellKey(player.x, player.y);
      if (seen.has(cell)) {
        continue;
      }

      seen.add(cell);
      normalizedPlayers.push(player);
      cellsArgs.push(cell, id);
    }

    const tx = redisDataClient.multi();
    tx.del(config.REDIS_PLAYERS_KEY);
    tx.del(config.REDIS_CELLS_KEY);

    for (const player of normalizedPlayers) {
      tx.hSet(config.REDIS_PLAYERS_KEY, player.id, JSON.stringify(player));
    }

    if (cellsArgs.length > 0) {
      tx.hSet(config.REDIS_CELLS_KEY, cellsArgs);
    }

    await tx.exec();
  }

  function emitPlayerLeft(playerId) {
    io.emit('playerLeft', { id: playerId });
  }

  function scheduleEmitPlayers() {
    stats.broadcastRequestsTotal += 1;

    if (broadcastTimer || broadcastInFlight) {
      stats.broadcastsCoalesced += 1;
      broadcastPending = true;
      return;
    }

    broadcastTimer = setTimeout(async () => {
      broadcastTimer = null;
      broadcastInFlight = true;

      try {
        await emitPlayersNow();
      } catch (error) {
        stats.errorsTotal += 1;
        console.error('[broadcast] failed:', error);
      } finally {
        broadcastInFlight = false;
        if (broadcastPending) {
          broadcastPending = false;
          scheduleEmitPlayers();
        }
      }
    }, config.BROADCAST_INTERVAL_MS);
  }

  async function sweepGhostPlayers() {
    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      return;
    }

    try {
      const sockets = await io.fetchSockets();
      const activeSocketIds = new Set(sockets.map((socket) => socket.id));
      const list = await getPlayersList();
      let removed = 0;

      for (const player of list) {
        if (!activeSocketIds.has(player.id)) {
          await removePlayer(player.id);
          lastMoveAt.delete(player.id);
          emitPlayerLeft(player.id);
          removed += 1;
        }
      }

      if (removed > 0) {
        console.log(`[reconcile] Removed ${removed} stale players from Redis.`);
        scheduleEmitPlayers();
      }
    } catch (error) {
      stats.errorsTotal += 1;
      console.error('[reconcile] failed:', error);
    }
  }

  async function spawnPlayerRedis(playerId) {
    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      return null;
    }

    const color = randomColor();
    let fallback = null;

    for (let i = 0; i < config.MAX_SPAWN_ATTEMPTS; i += 1) {
      const x = randomInt(config.GRID_SIZE);
      const y = randomInt(config.GRID_SIZE);
      const claimed = await redisDataClient.eval(
        `
          local playersKey = KEYS[1]
          local cellsKey = KEYS[2]
          local playerId = ARGV[1]
          local x = tonumber(ARGV[2])
          local y = tonumber(ARGV[3])
          local color = ARGV[4]
          local cell = tostring(x) .. ':' .. tostring(y)

          if redis.call('HEXISTS', cellsKey, cell) == 1 then
            return 0
          end

          redis.call('HSET', cellsKey, cell, playerId)
          redis.call('HSET', playersKey, playerId, cjson.encode({
            id = playerId,
            x = x,
            y = y,
            color = color
          }))
          return 1
        `,
        {
          keys: [config.REDIS_PLAYERS_KEY, config.REDIS_CELLS_KEY],
          arguments: [playerId, String(x), String(y), color],
        }
      );

      if (claimed === 1) {
        return { id: playerId, x, y, color };
      }
    }

    for (let y = 0; y < config.GRID_SIZE; y += 1) {
      for (let x = 0; x < config.GRID_SIZE; x += 1) {
        const claimed = await redisDataClient.eval(
          `
            local playersKey = KEYS[1]
            local cellsKey = KEYS[2]
            local playerId = ARGV[1]
            local x = tonumber(ARGV[2])
            local y = tonumber(ARGV[3])
            local color = ARGV[4]
            local cell = tostring(x) .. ':' .. tostring(y)

            if redis.call('HEXISTS', cellsKey, cell) == 1 then
              return 0
            end

            redis.call('HSET', cellsKey, cell, playerId)
            redis.call('HSET', playersKey, playerId, cjson.encode({
              id = playerId,
              x = x,
              y = y,
              color = color
            }))
            return 1
          `,
          {
            keys: [config.REDIS_PLAYERS_KEY, config.REDIS_CELLS_KEY],
            arguments: [playerId, String(x), String(y), color],
          }
        );

        if (claimed === 1) {
          fallback = { id: playerId, x, y, color };
          break;
        }
      }
      if (fallback) {
        break;
      }
    }

    return fallback;
  }

  async function createPlayer(playerId) {
    if (usesRedisStorage()) {
      return await spawnPlayerRedis(playerId);
    }

    const spawn = await findSpawnPosition();
    if (!spawn) {
      return null;
    }

    const createdPlayer = {
      id: playerId,
      x: spawn.x,
      y: spawn.y,
      color: randomColor(),
    };
    await savePlayer(createdPlayer);
    return createdPlayer;
  }

  async function connectPlayer(playerId) {
    const player = await createPlayer(playerId);
    if (!player) {
      return null;
    }
    scheduleEmitPlayers();
    emitPlayerJoined(player);
    return player;
  }

  async function movePlayerRedis(playerId, direction) {
    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      return { state: 'missing' };
    }

    const current = await getPlayerById(playerId);
    if (!current) {
      return { state: 'missing' };
    }

    const next = getNextPosition(current, direction);
    if (next.x === current.x && next.y === current.y) {
      return { state: 'applied' };
    }

    const moved = await redisDataClient.eval(
      `
        local playersKey = KEYS[1]
        local cellsKey = KEYS[2]
        local playerId = ARGV[1]
        local toX = tonumber(ARGV[2])
        local toY = tonumber(ARGV[3])
        local toCell = tostring(toX) .. ':' .. tostring(toY)
        local raw = redis.call('HGET', playersKey, playerId)

        if not raw then
          return -1
        end

        local ok, player = pcall(cjson.decode, raw)
        if not ok or not player then
          return -1
        end

        local fromCell = tostring(player.x) .. ':' .. tostring(player.y)
        if fromCell == toCell then
          return 2
        end

        if redis.call('HEXISTS', cellsKey, toCell) == 1 then
          return 0
        end

        redis.call('HDEL', cellsKey, fromCell)
        redis.call('HSET', cellsKey, toCell, playerId)
        player.x = toX
        player.y = toY
        redis.call('HSET', playersKey, playerId, cjson.encode(player))
        return 1
      `,
      {
        keys: [config.REDIS_PLAYERS_KEY, config.REDIS_CELLS_KEY],
        arguments: [playerId, String(next.x), String(next.y)],
      }
    );

    if (moved === 1 || moved === 2) {
      const updated = await getPlayerById(playerId);
      if (!updated) {
        return { state: 'missing' };
      }
      return { state: 'applied', player: updated };
    }
    if (moved === 0) {
      return { state: 'occupied' };
    }
    return { state: 'missing' };
  }

  async function movePlayerTo(playerId, x, y) {
    const player = await getPlayerById(playerId);
    if (!player) {
      return { ok: false, reason: 'missing_player' };
    }

    if (await isOccupied(x, y, playerId)) {
      return { ok: false, reason: 'occupied', player };
    }

    const next = {
      ...player,
      x,
      y,
    };

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      await savePlayer(next);
      return { ok: true, player: next };
    }

    const fromCell = toCellKey(player.x, player.y);
    const toCell = toCellKey(x, y);
    const tx = redisDataClient.multi();
    if (fromCell !== toCell) {
      tx.hDel(config.REDIS_CELLS_KEY, fromCell);
    }
    tx.hSet(config.REDIS_CELLS_KEY, toCell, playerId);
    tx.hSet(config.REDIS_PLAYERS_KEY, playerId, JSON.stringify(next));
    await tx.exec();
    return { ok: true, player: next };
  }

  function getNextPosition(player, direction) {
    let nextX = player.x;
    let nextY = player.y;

    if (direction === 'up') {
      nextY = clamp(player.y - 1, 0, config.GRID_SIZE - 1);
    } else if (direction === 'down') {
      nextY = clamp(player.y + 1, 0, config.GRID_SIZE - 1);
    } else if (direction === 'left') {
      nextX = clamp(player.x - 1, 0, config.GRID_SIZE - 1);
    } else if (direction === 'right') {
      nextX = clamp(player.x + 1, 0, config.GRID_SIZE - 1);
    }

    return { x: nextX, y: nextY };
  }

  async function emitPlayersNow() {
    const list = await getPlayersList();
    io.emit('updatePlayers', list);
    stats.broadcastsEmitted += 1;
  }

  function emitMoveAck(socket, seq, ok, reason, player = null) {
    socket.emit('moveAck', {
      seq,
      ok,
      reason: reason || null,
      x: player ? player.x : null,
      y: player ? player.y : null,
    });
  }

  function emitPlayerMoved(player, seq) {
    if (!player) {
      return;
    }

    io.emit('playerMoved', {
      id: player.id,
      x: player.x,
      y: player.y,
      color: player.color,
      seq,
      at: Date.now(),
    });
  }

  function emitPlayerJoined(player) {
    if (!player) {
      return;
    }

    io.emit('playerJoined', player);
  }

  function consumeMoveRateLimit(playerId, moveIntervalMs) {
    const now = Date.now();
    const last = lastMoveAt.get(playerId) || 0;
    if (now - last < moveIntervalMs) {
      return true;
    }
    lastMoveAt.set(playerId, now);
    return false;
  }

  async function disconnectPlayer(playerId) {
    await removePlayer(playerId);
    lastMoveAt.delete(playerId);
    scheduleEmitPlayers();
    emitPlayerLeft(playerId);
  }

  function getSocketsOnlineCount() {
    return io.of('/').sockets.size;
  }

  return {
    VALID_DIRECTIONS,
    connectPlayer,
    consumeMoveRateLimit,
    disconnectPlayer,
    emitMoveAck,
    emitPlayerMoved,
    emitPlayersNow,
    getNextPosition,
    getPlayerById,
    getPlayersList,
    getSocketsOnlineCount,
    isOccupied,
    movePlayerRedis,
    movePlayerTo,
    normalizeCoord,
    normalizeSeq,
    rebuildRedisCellsIndex,
    savePlayer,
    scheduleEmitPlayers,
    sweepGhostPlayers,
    usesRedisStorage,
  };
}

module.exports = {
  createGameService,
};
