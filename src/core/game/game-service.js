/* eslint-disable no-console */
function createGameService(options) {
  const { io, stats, config, getRedisDataClient } = options;

  const players = new Map();
  const lastMoveAt = new Map();
  const rooms = new Map();
  const roomEndTimers = new Map();
  const VALID_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
  const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const DEFAULT_ROOM_SIZE = 4;
  const DEFAULT_GAME_DURATION_SEC = 300;
  let broadcastTimer = null;
  let broadcastPending = false;
  let broadcastInFlight = false;
  let shuttingDown = false;
  let roomIdCounter = 0;

  function normalizeRoomId(roomId) {
    const normalized = String(roomId || '').trim().toUpperCase();
    return normalized || null;
  }

  function getCellScope(roomId, playerId = '') {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (normalizedRoomId) {
      return `room:${normalizedRoomId}`;
    }
    return `solo:${playerId}`;
  }

  function generateRoomId() {
    roomIdCounter += 1;
    let id = '';
    const charsLen = ROOM_ID_CHARS.length;
    for (let i = 0; i < 4; i += 1) {
      id += ROOM_ID_CHARS.charAt(Math.floor(Math.random() * charsLen));
    }
    return id + String(roomIdCounter % 100).padStart(2, '0');
  }

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
        roomId: normalizeRoomId(parsed.roomId),
      };
    } catch (_error) {
      return null;
    }
  }

  function usesRedisStorage() {
    return Boolean(getRedisDataClient());
  }

  async function getPlayersList() {
    if (shuttingDown) {
      return [];
    }

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient || !redisDataClient.isOpen) {
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

  async function getPlayersInRoom(roomId) {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId) {
      return [];
    }
    const list = await getPlayersList();
    return list.filter((player) => normalizeRoomId(player.roomId) === normalizedRoomId);
  }

  async function getPlayerById(id) {
    if (shuttingDown) {
      return null;
    }

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient || !redisDataClient.isOpen) {
      return players.get(id) || null;
    }

    const raw = await redisDataClient.hGet(config.REDIS_PLAYERS_KEY, id);
    if (!raw) {
      return null;
    }

    return parsePlayer(raw);
  }

  async function savePlayer(player) {
    if (shuttingDown) {
      return;
    }

    const next = {
      ...player,
      roomId: normalizeRoomId(player.roomId),
    };

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient || !redisDataClient.isOpen) {
      players.set(next.id, next);
      return;
    }

    const previous = await getPlayerById(next.id);
    const previousCell = previous
      ? toCellKey(previous.x, previous.y)
      : null;
    const previousScope = previous ? getCellScope(previous.roomId, previous.id) : null;
    const nextCell = toCellKey(next.x, next.y);
    const nextScope = getCellScope(next.roomId, next.id);

    const tx = redisDataClient.multi();
    if (previous && (previousCell !== nextCell || previousScope !== nextScope)) {
      tx.hDel(config.REDIS_CELLS_KEY, `${previousScope}:${previousCell}`);
    }
    tx.hSet(config.REDIS_CELLS_KEY, `${nextScope}:${nextCell}`, next.id);
    tx.hSet(config.REDIS_PLAYERS_KEY, next.id, JSON.stringify(next));
    await tx.exec();
  }

  async function removePlayer(id) {
    if (shuttingDown) {
      return;
    }

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient || !redisDataClient.isOpen) {
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
            local roomId = ''
            if player.roomId ~= nil and player.roomId ~= cjson.null then
              roomId = tostring(player.roomId)
            end
            local soloScope = 'solo:' .. tostring(player.id)
            local scope = (roomId ~= '' and ('room:' .. roomId)) or soloScope
            local cell = scope .. ':' .. tostring(player.x) .. ':' .. tostring(player.y)
            redis.call('HDEL', cellsKey, cell)
            if roomId == '' then
              redis.call('HDEL', cellsKey, 'global:' .. tostring(player.x) .. ':' .. tostring(player.y))
              redis.call('HDEL', cellsKey, soloScope .. ':' .. tostring(player.x) .. ':' .. tostring(player.y))
              redis.call('HDEL', cellsKey, tostring(player.x) .. ':' .. tostring(player.y))
            end
          end
        end
        redis.call('HDEL', playersKey, playerId)
        return 1
      `,
      { keys: [config.REDIS_PLAYERS_KEY, config.REDIS_CELLS_KEY], arguments: [id] }
    );
  }

  async function isOccupied(x, y, ignoreId = null, roomId = null) {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId) {
      return false;
    }
    const list = await getPlayersList();
    return list.some(
      (player) =>
        player.id !== ignoreId &&
        normalizeRoomId(player.roomId) === normalizedRoomId &&
        player.x === x &&
        player.y === y
    );
  }

  async function findSpawnPosition(roomId = null) {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId) {
      return {
        x: randomInt(config.GRID_SIZE),
        y: randomInt(config.GRID_SIZE),
      };
    }
    for (let i = 0; i < config.MAX_SPAWN_ATTEMPTS; i += 1) {
      const x = randomInt(config.GRID_SIZE);
      const y = randomInt(config.GRID_SIZE);

      if (!(await isOccupied(x, y, null, normalizedRoomId))) {
        return { x, y };
      }
    }

    for (let y = 0; y < config.GRID_SIZE; y += 1) {
      for (let x = 0; x < config.GRID_SIZE; x += 1) {
        if (!(await isOccupied(x, y, null, normalizedRoomId))) {
          return { x, y };
        }
      }
    }

    return null;
  }

  async function rebuildRedisCellsIndex() {
    const redisDataClient = getRedisDataClient();
    if (shuttingDown || !redisDataClient || !redisDataClient.isOpen) {
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

      const scope = getCellScope(player.roomId, player.id);
      const cell = `${scope}:${toCellKey(player.x, player.y)}`;
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

  function emitPlayerLeft(playerId, roomId) {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId) {
      return;
    }
    io.to(normalizedRoomId).emit('playerLeft', { id: playerId });
  }

  function scheduleEmitPlayers() {
    if (shuttingDown) {
      return;
    }

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
    if (shuttingDown || !redisDataClient || !redisDataClient.isOpen) {
      return;
    }

    try {
      const sockets = await io.fetchSockets();
      const activeSocketIds = new Set(sockets.map((socket) => socket.id));
      const list = await getPlayersList();
      let removed = 0;

      for (const player of list) {
        if (!activeSocketIds.has(player.id)) {
          const roomId = normalizeRoomId(player.roomId);
          await removePlayer(player.id);
          lastMoveAt.delete(player.id);
          emitPlayerLeft(player.id, roomId);
          if (roomId) {
            await emitPlayersNow({ roomId });
          }
          removed += 1;
        }
      }

      if (removed > 0) {
        scheduleEmitPlayers();
        console.log(`[reconcile] Removed ${removed} stale players from Redis.`);
      }
    } catch (error) {
      stats.errorsTotal += 1;
      console.error('[reconcile] failed:', error);
    }
  }

  async function spawnPlayerRedis(playerId, roomId = null) {
    const redisDataClient = getRedisDataClient();
    if (shuttingDown || !redisDataClient || !redisDataClient.isOpen) {
      return null;
    }

    const normalizedRoomId = normalizeRoomId(roomId);
    const color = randomColor();
    if (!normalizedRoomId) {
      const x = randomInt(config.GRID_SIZE);
      const y = randomInt(config.GRID_SIZE);
      const player = { id: playerId, x, y, color, roomId: null };
      await redisDataClient.hSet(
        config.REDIS_CELLS_KEY,
        `${getCellScope(null, playerId)}:${toCellKey(x, y)}`,
        playerId
      );
      await redisDataClient.hSet(config.REDIS_PLAYERS_KEY, playerId, JSON.stringify(player));
      return player;
    }

    let fallback = null;

    for (let i = 0; i < config.MAX_SPAWN_ATTEMPTS; i += 1) {
      const x = randomInt(config.GRID_SIZE);
      const y = randomInt(config.GRID_SIZE);
      const scope = getCellScope(normalizedRoomId, playerId);
      const claimed = await redisDataClient.eval(
        `
          local playersKey = KEYS[1]
          local cellsKey = KEYS[2]
          local playerId = ARGV[1]
          local x = tonumber(ARGV[2])
          local y = tonumber(ARGV[3])
          local color = ARGV[4]
          local roomId = ARGV[5]
          local scope = ARGV[6]
          local cell = scope .. ':' .. tostring(x) .. ':' .. tostring(y)

          if redis.call('HEXISTS', cellsKey, cell) == 1 then
            return 0
          end

          redis.call('HSET', cellsKey, cell, playerId)
          redis.call('HSET', playersKey, playerId, cjson.encode({
            id = playerId,
            x = x,
            y = y,
            color = color,
            roomId = roomId
          }))
          return 1
        `,
        {
          keys: [config.REDIS_PLAYERS_KEY, config.REDIS_CELLS_KEY],
          arguments: [playerId, String(x), String(y), color, normalizedRoomId || '', scope],
        }
      );

      if (claimed === 1) {
        return { id: playerId, x, y, color, roomId: normalizedRoomId };
      }
    }

    for (let y = 0; y < config.GRID_SIZE; y += 1) {
      for (let x = 0; x < config.GRID_SIZE; x += 1) {
        const scope = getCellScope(normalizedRoomId, playerId);
        const claimed = await redisDataClient.eval(
          `
            local playersKey = KEYS[1]
            local cellsKey = KEYS[2]
            local playerId = ARGV[1]
            local x = tonumber(ARGV[2])
            local y = tonumber(ARGV[3])
            local color = ARGV[4]
            local roomId = ARGV[5]
            local scope = ARGV[6]
            local cell = scope .. ':' .. tostring(x) .. ':' .. tostring(y)

            if redis.call('HEXISTS', cellsKey, cell) == 1 then
              return 0
            end

            redis.call('HSET', cellsKey, cell, playerId)
            redis.call('HSET', playersKey, playerId, cjson.encode({
              id = playerId,
              x = x,
              y = y,
              color = color,
              roomId = roomId
            }))
            return 1
          `,
          {
            keys: [config.REDIS_PLAYERS_KEY, config.REDIS_CELLS_KEY],
            arguments: [playerId, String(x), String(y), color, normalizedRoomId || '', scope],
          }
        );

        if (claimed === 1) {
          fallback = { id: playerId, x, y, color, roomId: normalizedRoomId };
          break;
        }
      }
      if (fallback) {
        break;
      }
    }

    return fallback;
  }

  async function createPlayer(playerId, roomId = null) {
    if (shuttingDown) {
      return null;
    }

    if (usesRedisStorage()) {
      return await spawnPlayerRedis(playerId, roomId);
    }

    const normalizedRoomId = normalizeRoomId(roomId);
    const spawn = await findSpawnPosition(normalizedRoomId);
    if (!spawn) {
      return null;
    }

    const createdPlayer = {
      id: playerId,
      x: spawn.x,
      y: spawn.y,
      color: randomColor(),
      roomId: normalizedRoomId,
    };
    await savePlayer(createdPlayer);
    return createdPlayer;
  }

  async function connectPlayer(playerId) {
    if (shuttingDown) {
      return null;
    }

    const player = await createPlayer(playerId, null);
    if (!player) {
      return null;
    }
    return player;
  }

  async function movePlayerRedis(playerId, direction, roomId = null) {
    const redisDataClient = getRedisDataClient();
    if (shuttingDown || !redisDataClient || !redisDataClient.isOpen) {
      return { state: 'missing' };
    }

    const current = await getPlayerById(playerId);
    if (!current) {
      return { state: 'missing' };
    }

    const normalizedRoomId = normalizeRoomId(roomId);
    if (normalizeRoomId(current.roomId) !== normalizedRoomId) {
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
        local expectedRoomId = ARGV[4]
        local raw = redis.call('HGET', playersKey, playerId)

        if not raw then
          return -1
        end

        local ok, player = pcall(cjson.decode, raw)
        if not ok or not player then
          return -1
        end

        local currentRoomId = ''
        if player.roomId ~= nil and player.roomId ~= cjson.null then
          currentRoomId = tostring(player.roomId)
        end
        local expected = expectedRoomId and tostring(expectedRoomId) or ''
        if currentRoomId ~= expected then
          return -1
        end

        local scope = (currentRoomId ~= '' and ('room:' .. currentRoomId)) or ('solo:' .. tostring(player.id))
        local toCell = scope .. ':' .. tostring(toX) .. ':' .. tostring(toY)

        local fromCell = scope .. ':' .. tostring(player.x) .. ':' .. tostring(player.y)
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
        arguments: [playerId, String(next.x), String(next.y), normalizedRoomId || ''],
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

  async function movePlayerTo(playerId, x, y, roomId = null) {
    if (shuttingDown) {
      return { ok: false, reason: 'missing_player' };
    }

    const player = await getPlayerById(playerId);
    if (!player) {
      return { ok: false, reason: 'missing_player' };
    }

    const normalizedRoomId = normalizeRoomId(roomId);
    if (normalizeRoomId(player.roomId) !== normalizedRoomId) {
      return { ok: false, reason: 'missing_player' };
    }

    if (await isOccupied(x, y, playerId, normalizedRoomId)) {
      return { ok: false, reason: 'occupied', player };
    }

    const next = {
      ...player,
      x,
      y,
    };

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient || !redisDataClient.isOpen) {
      await savePlayer(next);
      return { ok: true, player: next };
    }

    const fromScope = getCellScope(player.roomId, player.id);
    const toScope = getCellScope(next.roomId, next.id);
    const fromCell = `${fromScope}:${toCellKey(player.x, player.y)}`;
    const toCell = `${toScope}:${toCellKey(x, y)}`;
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

  async function emitPlayersNow(options = {}) {
    if (shuttingDown) {
      return;
    }

    const normalizedRoomId = normalizeRoomId(options.roomId);
    if (normalizedRoomId) {
      const list = await getPlayersInRoom(normalizedRoomId);
      io.to(normalizedRoomId).emit('updatePlayers', list);
      stats.broadcastsEmitted += 1;
      return;
    }

    if (options.socket && options.playerId) {
      const player = await getPlayerById(options.playerId);
      if (!player) {
        options.socket.emit('updatePlayers', []);
        stats.broadcastsEmitted += 1;
        return;
      }

      const playerRoomId = normalizeRoomId(player.roomId);
      if (playerRoomId) {
        const list = await getPlayersInRoom(playerRoomId);
        options.socket.emit('updatePlayers', list);
        stats.broadcastsEmitted += 1;
        return;
      }

      options.socket.emit('updatePlayers', [player]);
      stats.broadcastsEmitted += 1;
      return;
    }

    const sockets = await io.fetchSockets();
    if (sockets.length === 0) {
      return;
    }

    const list = await getPlayersList();
    const playersById = new Map(list.map((player) => [player.id, player]));
    const playersByRoomId = new Map();

    for (const player of list) {
      const playerRoomId = normalizeRoomId(player.roomId);
      if (!playerRoomId) {
        continue;
      }
      const roomPlayers = playersByRoomId.get(playerRoomId) || [];
      roomPlayers.push(player);
      playersByRoomId.set(playerRoomId, roomPlayers);
    }

    for (const socket of sockets) {
      const socketRoomId = normalizeRoomId(socket?.data?.roomId);
      if (socketRoomId) {
        socket.emit('updatePlayers', playersByRoomId.get(socketRoomId) || []);
      } else {
        const player = playersById.get(socket.id);
        socket.emit('updatePlayers', player ? [player] : []);
      }
    }

    stats.broadcastsEmitted += sockets.length;
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

  function emitPlayerMoved(player, seq, roomId = null) {
    if (!player) {
      return;
    }

    const payload = {
      id: player.id,
      x: player.x,
      y: player.y,
      color: player.color,
      seq,
      at: Date.now(),
    };
    const normalizedRoomId = normalizeRoomId(roomId || player.roomId);
    if (normalizedRoomId) {
      io.to(normalizedRoomId).emit('playerMoved', payload);
    }
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

  async function disconnectPlayer(playerId, roomId = null) {
    if (shuttingDown) {
      return;
    }

    await removePlayer(playerId);
    lastMoveAt.delete(playerId);
    if (normalizeRoomId(roomId)) {
      emitPlayerLeft(playerId, roomId);
    }
  }

  function getSocketsOnlineCount() {
    return io.of('/').sockets.size;
  }

  function clearRoomEndTimer(roomId) {
    const timer = roomEndTimers.get(roomId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    roomEndTimers.delete(roomId);
  }

  function endRoomGame(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') {
      return null;
    }

    room.status = 'ended';
    clearRoomEndTimer(roomId);

    return {
      room,
      leaderboard: getRoomLeaderboard(roomId),
    };
  }

  function scheduleRoomEnd(roomId) {
    clearRoomEndTimer(roomId);

    const room = rooms.get(roomId);
    if (!room || !Number.isFinite(room.endsAt)) {
      return;
    }

    const delayMs = Math.max(0, room.endsAt - Date.now());
    const timer = setTimeout(() => {
      roomEndTimers.delete(roomId);

      try {
        const result = endRoomGame(roomId);
        if (!result) {
          return;
        }
        io.to(roomId).emit('roomEnded', {
          roomId,
          leaderboard: result.leaderboard,
        });
      } catch (error) {
        stats.errorsTotal += 1;
        console.error('[room-end] failed:', error);
      }
    }, delayMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    roomEndTimers.set(roomId, timer);
  }

  function shutdown() {
    shuttingDown = true;
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    for (const roomId of roomEndTimers.keys()) {
      clearRoomEndTimer(roomId);
    }
    broadcastPending = false;
    broadcastInFlight = false;
    players.clear();
    lastMoveAt.clear();
  }

  function createRoom(hostId, options = {}) {
    const id = generateRoomId();
    const room = {
      id,
      hostId,
      name: options.name || `Room ${id}`,
      maxPlayers: Math.max(2, Math.min(Number(options.maxPlayers) || DEFAULT_ROOM_SIZE, 16)),
      gameDurationSec: Number(options.gameDurationSec) || DEFAULT_GAME_DURATION_SEC,
      status: 'waiting',
      players: new Set([hostId]),
      scores: new Map(),
      createdAt: Date.now(),
      startedAt: null,
      endsAt: null,
    };
    room.scores.set(hostId, 0);
    rooms.set(id, room);
    return room;
  }

  function getRoomById(roomId) {
    return rooms.get(roomId) || null;
  }

  function getRoomPlayers(roomId) {
    const room = rooms.get(roomId);
    if (!room) {
      return [];
    }
    return Array.from(room.players);
  }

  function joinRoom(roomId, playerId) {
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, reason: 'room_not_found' };
    }
    if (room.status !== 'waiting') {
      return { ok: false, reason: 'room_already_started' };
    }
    if (room.players.size >= room.maxPlayers) {
      return { ok: false, reason: 'room_full' };
    }
    if (room.players.has(playerId)) {
      return { ok: true, room };
    }
    room.players.add(playerId);
    room.scores.set(playerId, 0);
    return { ok: true, room };
  }

  function leaveRoom(roomId, playerId) {
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, reason: 'room_not_found' };
    }
    room.players.delete(playerId);
    room.scores.delete(playerId);
    if (room.players.size === 0 || playerId === room.hostId) {
      clearRoomEndTimer(roomId);
      rooms.delete(roomId);
      return { ok: true, closed: true };
    }
    return { ok: true, closed: false };
  }

  function startRoomGame(roomId) {
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, reason: 'room_not_found' };
    }
    if (room.status !== 'waiting') {
      return { ok: false, reason: 'room_already_started' };
    }
    if (room.players.size < 2) {
      return { ok: false, reason: 'need_more_players' };
    }
    room.status = 'playing';
    room.startedAt = Date.now();
    room.endsAt = room.startedAt + room.gameDurationSec * 1000;
    scheduleRoomEnd(roomId);
    return { ok: true, room };
  }

  function addRoomScore(roomId, playerId, points) {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') {
      return null;
    }
    const current = room.scores.get(playerId) || 0;
    room.scores.set(playerId, current + points);
    return room.scores.get(playerId);
  }

  function getRoomLeaderboard(roomId) {
    const room = rooms.get(roomId);
    if (!room) {
      return [];
    }
    const entries = Array.from(room.scores.entries());
    entries.sort((a, b) => b[1] - a[1]);
    return entries.map(([id, score], index) => ({
      rank: index + 1,
      playerId: id,
      score,
    }));
  }

  function listRooms() {
    const result = [];
    for (const room of rooms.values()) {
      result.push({
        id: room.id,
        name: room.name,
        hostId: room.hostId,
        maxPlayers: room.maxPlayers,
        currentPlayers: room.players.size,
        status: room.status,
        createdAt: room.createdAt,
      });
    }
    return result;
  }

  async function assignPlayerToRoom(playerId, roomId) {
    const player = await getPlayerById(playerId);
    if (!player) {
      return null;
    }

    const normalizedRoomId = normalizeRoomId(roomId);
    let nextX = player.x;
    let nextY = player.y;
    if (normalizedRoomId && (await isOccupied(nextX, nextY, playerId, normalizedRoomId))) {
      const spawn = await findSpawnPosition(normalizedRoomId);
      if (!spawn) {
        return null;
      }
      nextX = spawn.x;
      nextY = spawn.y;
    }

    const next = {
      ...player,
      roomId: normalizedRoomId,
      x: nextX,
      y: nextY,
    };
    await savePlayer(next);
    return next;
  }

  return {
    VALID_DIRECTIONS,
    addRoomScore,
    assignPlayerToRoom,
    connectPlayer,
    consumeMoveRateLimit,
    createRoom,
    disconnectPlayer,
    endRoomGame,
    emitMoveAck,
    emitPlayerMoved,
    emitPlayersNow,
    getNextPosition,
    getPlayerById,
    getPlayersList,
    getPlayersInRoom,
    getRoomById,
    getRoomLeaderboard,
    getRoomPlayers,
    getSocketsOnlineCount,
    isOccupied,
    joinRoom,
    leaveRoom,
    listRooms,
    movePlayerRedis,
    movePlayerTo,
    normalizeCoord,
    normalizeSeq,
    rebuildRedisCellsIndex,
    savePlayer,
    scheduleEmitPlayers,
    shutdown,
    startRoomGame,
    sweepGhostPlayers,
    usesRedisStorage,
  };
}

module.exports = {
  createGameService,
};
