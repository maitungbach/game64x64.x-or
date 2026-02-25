const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket"],
});

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const GRID_SIZE = 64;
const MAX_SPAWN_ATTEMPTS = 500;
const MOVE_INTERVAL_MS = Number(process.env.MOVE_INTERVAL_MS || 16);
const BROADCAST_INTERVAL_MS = Number(process.env.BROADCAST_INTERVAL_MS || 33);
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS || 250);

const ENABLE_REDIS = String(process.env.ENABLE_REDIS || "false") === "true";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const REDIS_PLAYERS_KEY = process.env.REDIS_PLAYERS_KEY || "game64x64:players";
const REDIS_CELLS_KEY = process.env.REDIS_CELLS_KEY || "game64x64:cells";
const STATS_TOKEN = process.env.STATS_TOKEN || "";
const STARTED_AT = new Date().toISOString();

const players = new Map();
const lastMoveAt = new Map();
const VALID_DIRECTIONS = new Set(["up", "down", "left", "right"]);

let redisPubClient = null;
let redisSubClient = null;
let redisDataClient = null;
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
let broadcastTimer = null;
let broadcastPending = false;
let broadcastInFlight = false;

function randomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

function randomColor() {
  return `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
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

function parsePlayer(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      x: clamp(Number(parsed.x), 0, GRID_SIZE - 1),
      y: clamp(Number(parsed.y), 0, GRID_SIZE - 1),
      color: typeof parsed.color === "string" ? parsed.color : "#999999",
    };
  } catch (_error) {
    return null;
  }
}

async function connectRedisIfEnabled() {
  if (!ENABLE_REDIS) {
    console.log("[startup] Redis disabled. Using in-memory player store.");
    return;
  }

  redisPubClient = createClient({ url: REDIS_URL });
  redisSubClient = redisPubClient.duplicate();
  redisDataClient = redisPubClient.duplicate();

  await Promise.all([
    redisPubClient.connect(),
    redisSubClient.connect(),
    redisDataClient.connect(),
  ]);

  io.adapter(createAdapter(redisPubClient, redisSubClient));
  console.log(`[startup] Redis enabled at ${REDIS_URL}. Socket.io adapter active.`);
  await rebuildRedisCellsIndex();
}

async function getPlayersList() {
  if (!redisDataClient) {
    return Array.from(players.values());
  }

  const entries = await redisDataClient.hGetAll(REDIS_PLAYERS_KEY);
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
  if (!redisDataClient) {
    return players.get(id) || null;
  }

  const raw = await redisDataClient.hGet(REDIS_PLAYERS_KEY, id);
  if (!raw) {
    return null;
  }

  return parsePlayer(raw);
}

async function savePlayer(player) {
  if (!redisDataClient) {
    players.set(player.id, player);
    return;
  }

  await redisDataClient.hSet(REDIS_PLAYERS_KEY, player.id, JSON.stringify(player));
}

async function removePlayer(id) {
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
    { keys: [REDIS_PLAYERS_KEY, REDIS_CELLS_KEY], arguments: [id] },
  );
}

async function isOccupied(x, y, ignoreId = null) {
  const list = await getPlayersList();
  return list.some((player) => player.id !== ignoreId && player.x === x && player.y === y);
}

async function findSpawnPosition() {
  for (let i = 0; i < MAX_SPAWN_ATTEMPTS; i += 1) {
    const x = randomInt(GRID_SIZE);
    const y = randomInt(GRID_SIZE);

    // eslint-disable-next-line no-await-in-loop
    if (!(await isOccupied(x, y))) {
      return { x, y };
    }
  }

  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await isOccupied(x, y))) {
        return { x, y };
      }
    }
  }

  return null;
}

async function rebuildRedisCellsIndex() {
  if (!redisDataClient) {
    return;
  }

  const entries = await redisDataClient.hGetAll(REDIS_PLAYERS_KEY);
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
  tx.del(REDIS_PLAYERS_KEY);
  tx.del(REDIS_CELLS_KEY);

  for (const player of normalizedPlayers) {
    tx.hSet(REDIS_PLAYERS_KEY, player.id, JSON.stringify(player));
  }

  if (cellsArgs.length > 0) {
    tx.hSet(REDIS_CELLS_KEY, cellsArgs);
  }

  await tx.exec();
}

async function spawnPlayerRedis(playerId) {
  if (!redisDataClient) {
    return null;
  }

  const color = randomColor();
  let fallback = null;

  for (let i = 0; i < MAX_SPAWN_ATTEMPTS; i += 1) {
    const x = randomInt(GRID_SIZE);
    const y = randomInt(GRID_SIZE);
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
        keys: [REDIS_PLAYERS_KEY, REDIS_CELLS_KEY],
        arguments: [playerId, String(x), String(y), color],
      },
    );

    if (claimed === 1) {
      return { id: playerId, x, y, color };
    }
  }

  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      // eslint-disable-next-line no-await-in-loop
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
          keys: [REDIS_PLAYERS_KEY, REDIS_CELLS_KEY],
          arguments: [playerId, String(x), String(y), color],
        },
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

async function movePlayerRedis(playerId, direction) {
  if (!redisDataClient) {
    return { state: "missing" };
  }

  const current = await getPlayerById(playerId);
  if (!current) {
    return { state: "missing" };
  }

  const next = getNextPosition(current, direction);
  if (next.x === current.x && next.y === current.y) {
    return { state: "applied" };
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
      keys: [REDIS_PLAYERS_KEY, REDIS_CELLS_KEY],
      arguments: [playerId, String(next.x), String(next.y)],
    },
  );

  if (moved === 1 || moved === 2) {
    const updated = await getPlayerById(playerId);
    if (!updated) {
      return { state: "missing" };
    }
    return { state: "applied", player: updated };
  }
  if (moved === 0) {
    return { state: "occupied" };
  }
  return { state: "missing" };
}

function getNextPosition(player, direction) {
  let nextX = player.x;
  let nextY = player.y;

  if (direction === "up") {
    nextY = clamp(player.y - 1, 0, GRID_SIZE - 1);
  } else if (direction === "down") {
    nextY = clamp(player.y + 1, 0, GRID_SIZE - 1);
  } else if (direction === "left") {
    nextX = clamp(player.x - 1, 0, GRID_SIZE - 1);
  } else if (direction === "right") {
    nextX = clamp(player.x + 1, 0, GRID_SIZE - 1);
  }

  return { x: nextX, y: nextY };
}

async function emitPlayersNow() {
  const list = await getPlayersList();
  io.emit("updatePlayers", list);
  stats.broadcastsEmitted += 1;
}

function emitMoveAck(socket, seq, ok, reason, player = null) {
  socket.emit("moveAck", {
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

  io.emit("playerMoved", {
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

  io.emit("playerJoined", player);
}

function emitPlayerLeft(playerId) {
  io.emit("playerLeft", { id: playerId });
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
      console.error("[broadcast] failed:", error);
    } finally {
      broadcastInFlight = false;
      if (broadcastPending) {
        broadcastPending = false;
        scheduleEmitPlayers();
      }
    }
  }, BROADCAST_INTERVAL_MS);
}

function getStatsSnapshot(playersCount) {
  return {
    startedAt: STARTED_AT,
    uptimeSec: Math.floor(process.uptime()),
    pid: process.pid,
    redisEnabled: ENABLE_REDIS,
    playersOnline: playersCount,
    socketsOnline: io.of("/").sockets.size,
    counters: { ...stats },
  };
}

function isStatsAuthorized(req) {
  if (!STATS_TOKEN) {
    return true;
  }
  return req.get("x-stats-token") === STATS_TOKEN;
}

app.use(express.static(PUBLIC_DIR));

async function handleHealth(_req, res) {
  const list = await getPlayersList();
  res.json({
    ok: true,
    players: list.length,
    redisEnabled: ENABLE_REDIS,
  });
}

async function handleStats(req, res) {
  if (!isStatsAuthorized(req)) {
    res.status(401).json({ ok: false, message: "Unauthorized" });
    return;
  }

  const list = await getPlayersList();
  res.json({
    ok: true,
    ...getStatsSnapshot(list.length),
  });
}

app.get("/health", handleHealth);
app.get("/api/health", handleHealth);
app.get("/stats", handleStats);
app.get("/api/stats", handleStats);

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

io.on("connection", (socket) => {
  stats.connectionsTotal += 1;

  (async () => {
    let createdPlayer = null;

    if (redisDataClient) {
      const created = await spawnPlayerRedis(socket.id);
      if (!created) {
        socket.disconnect(true);
        return;
      }
      createdPlayer = created;
    } else {
      const spawn = await findSpawnPosition();
      if (!spawn) {
        socket.disconnect(true);
        return;
      }

      createdPlayer = {
        id: socket.id,
        x: spawn.x,
        y: spawn.y,
        color: randomColor(),
      };
      await savePlayer(createdPlayer);
    }

    scheduleEmitPlayers();
    emitPlayerJoined(createdPlayer);
  })().catch((error) => {
    stats.errorsTotal += 1;
    console.error("[connection] failed:", error);
    socket.disconnect(true);
  });

  socket.on("move", (payload) => {
    stats.movesReceived += 1;

    (async () => {
      const seq = normalizeSeq(payload?.seq);
      const direction = payload?.direction;
      if (typeof direction !== "string" || !VALID_DIRECTIONS.has(direction)) {
        stats.movesRejectedInvalid += 1;
        emitMoveAck(socket, seq, false, "invalid_direction");
        return;
      }

      const player = await getPlayerById(socket.id);
      if (!player) {
        emitMoveAck(socket, seq, false, "missing_player");
        return;
      }

      const now = Date.now();
      const last = lastMoveAt.get(socket.id) || 0;
      if (now - last < MOVE_INTERVAL_MS) {
        stats.movesRejectedRateLimit += 1;
        emitMoveAck(socket, seq, false, "rate_limited", player);
        return;
      }
      lastMoveAt.set(socket.id, now);

      if (redisDataClient) {
        const moved = await movePlayerRedis(socket.id, direction);
        if (moved.state === "occupied") {
          stats.movesRejectedOccupied += 1;
          emitMoveAck(socket, seq, false, "occupied", player);
          return;
        }
        if (moved.state !== "applied") {
          emitMoveAck(socket, seq, false, "missing_player");
          return;
        }
        const updatedPlayer = moved.player || player;
        emitPlayerMoved(updatedPlayer, seq);
        emitMoveAck(socket, seq, true, null, updatedPlayer);
        stats.movesApplied += 1;
      } else {
        const next = getNextPosition(player, direction);
        if (await isOccupied(next.x, next.y, socket.id)) {
          stats.movesRejectedOccupied += 1;
          emitMoveAck(socket, seq, false, "occupied", player);
          return;
        }

        player.x = next.x;
        player.y = next.y;
        await savePlayer(player);
        emitPlayerMoved(player, seq);
        emitMoveAck(socket, seq, true, null, player);
        stats.movesApplied += 1;
      }
    })().catch((error) => {
      stats.errorsTotal += 1;
      console.error("[move] failed:", error);
    });
  });

  socket.on("disconnect", () => {
    stats.disconnectionsTotal += 1;

    (async () => {
      const disconnectedId = socket.id;
      await removePlayer(disconnectedId);
      lastMoveAt.delete(disconnectedId);
      scheduleEmitPlayers();
      emitPlayerLeft(disconnectedId);
    })().catch((error) => {
      stats.errorsTotal += 1;
      console.error("[disconnect] failed:", error);
    });
  });
});

async function start() {
  await connectRedisIfEnabled();

  if (SNAPSHOT_INTERVAL_MS > 0) {
    const snapshotTimer = setInterval(() => {
      scheduleEmitPlayers();
    }, SNAPSHOT_INTERVAL_MS);
    if (typeof snapshotTimer.unref === "function") {
      snapshotTimer.unref();
    }
  }

  server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("[startup] failed:", error);
  process.exit(1);
});
