const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const GRID_SIZE = 64;
const MAX_SPAWN_ATTEMPTS = 500;
const MOVE_INTERVAL_MS = 50;

const ENABLE_REDIS = String(process.env.ENABLE_REDIS || "false") === "true";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const REDIS_PLAYERS_KEY = process.env.REDIS_PLAYERS_KEY || "game64x64:players";
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
};

function randomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

function randomColor() {
  return `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

  await redisDataClient.hDel(REDIS_PLAYERS_KEY, id);
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

async function emitPlayers() {
  const list = await getPlayersList();
  io.emit("updatePlayers", list);
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
    const spawn = await findSpawnPosition();

    if (!spawn) {
      socket.disconnect(true);
      return;
    }

    await savePlayer({
      id: socket.id,
      x: spawn.x,
      y: spawn.y,
      color: randomColor(),
    });

    await emitPlayers();
  })().catch((error) => {
    stats.errorsTotal += 1;
    console.error("[connection] failed:", error);
    socket.disconnect(true);
  });

  socket.on("move", (payload) => {
    stats.movesReceived += 1;

    (async () => {
      const direction = payload?.direction;
      if (typeof direction !== "string" || !VALID_DIRECTIONS.has(direction)) {
        stats.movesRejectedInvalid += 1;
        return;
      }

      const now = Date.now();
      const last = lastMoveAt.get(socket.id) || 0;
      if (now - last < MOVE_INTERVAL_MS) {
        stats.movesRejectedRateLimit += 1;
        return;
      }
      lastMoveAt.set(socket.id, now);

      const player = await getPlayerById(socket.id);
      if (!player) {
        return;
      }

      const next = getNextPosition(player, direction);
      if (await isOccupied(next.x, next.y, socket.id)) {
        stats.movesRejectedOccupied += 1;
        return;
      }

      player.x = next.x;
      player.y = next.y;
      await savePlayer(player);
      await emitPlayers();
      stats.movesApplied += 1;
    })().catch((error) => {
      stats.errorsTotal += 1;
      console.error("[move] failed:", error);
    });
  });

  socket.on("disconnect", () => {
    stats.disconnectionsTotal += 1;

    (async () => {
      await removePlayer(socket.id);
      lastMoveAt.delete(socket.id);
      await emitPlayers();
    })().catch((error) => {
      stats.errorsTotal += 1;
      console.error("[disconnect] failed:", error);
    });
  });
});

async function start() {
  await connectRedisIfEnabled();

  server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("[startup] failed:", error);
  process.exit(1);
});
