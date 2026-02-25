const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
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
const REDIS_USERS_KEY = process.env.REDIS_USERS_KEY || "game64x64:users";
const REDIS_SESSION_PREFIX = process.env.REDIS_SESSION_PREFIX || "game64x64:session:";
const REDIS_USER_SESSION_PREFIX = process.env.REDIS_USER_SESSION_PREFIX || "game64x64:user-session:";
const STATS_TOKEN = process.env.STATS_TOKEN || "";
const STARTED_AT = new Date().toISOString();
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "game64x64_session";
const AUTH_COOKIE_SECURE = String(process.env.AUTH_COOKIE_SECURE || "false") === "true";
const AUTH_SESSION_TTL_SEC = Number(process.env.AUTH_SESSION_TTL_SEC || 86400);
const AUTH_REJECT_CONCURRENT = String(process.env.AUTH_REJECT_CONCURRENT || "true") === "true";
const AUTH_SEED_TEST_USERS = String(process.env.AUTH_SEED_TEST_USERS || "true") === "true";
const AUTH_REQUIRED = String(process.env.AUTH_REQUIRED || "true") === "true";
const AUTH_DEFAULT_PASSWORD_MIN = 6;
const AUTH_DEFAULT_NAME_MAX = 24;
const AUTH_DEFAULT_NAME_MIN = 2;

const players = new Map();
const lastMoveAt = new Map();
const VALID_DIRECTIONS = new Set(["up", "down", "left", "right"]);
const usersByEmail = new Map();
const usersById = new Map();
const sessionsByToken = new Map();
const userSessionTokenByUserId = new Map();

const TEST_USERS_SEED = [
  { name: "Tester 01", email: "tester01@example.com", password: "Test123!" },
  { name: "Tester 02", email: "tester02@example.com", password: "Test123!" },
  { name: "Tester 03", email: "tester03@example.com", password: "Test123!" },
  { name: "Tester 04", email: "tester04@example.com", password: "Test123!" },
  { name: "Tester 05", email: "tester05@example.com", password: "Test123!" },
];

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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDisplayName(value) {
  const compact = String(value || "").trim().replace(/\s+/g, " ");
  return compact.slice(0, AUTH_DEFAULT_NAME_MAX);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

function hashPassword(plainPassword) {
  const salt = randomId(16);
  const hashed = crypto.scryptSync(String(plainPassword), salt, 64).toString("hex");
  return `scrypt:${salt}:${hashed}`;
}

function verifyPassword(plainPassword, stored) {
  const raw = String(stored || "");
  const parts = raw.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  const [, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = crypto.scryptSync(String(plainPassword), salt, expected.length);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function cookieSerialize(name, value, maxAgeSec, clear = false) {
  const base = `${name}=${clear ? "" : encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  const secure = AUTH_COOKIE_SECURE ? "; Secure" : "";
  if (clear) {
    return `${base}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
  }
  return `${base}; Max-Age=${maxAgeSec}${secure}`;
}

function parseCookies(cookieHeader) {
  const parsed = {};
  const raw = String(cookieHeader || "");
  if (!raw) {
    return parsed;
  }

  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) {
      continue;
    }
    parsed[name] = decodeURIComponent(rest.join("=") || "");
  }
  return parsed;
}

function getAuthTokenFromRequest(req) {
  const cookies = parseCookies(req?.headers?.cookie);
  return cookies[AUTH_COOKIE_NAME] || null;
}

function getAuthTokenFromSocket(socket) {
  const cookieHeader = socket?.handshake?.headers?.cookie;
  const cookies = parseCookies(cookieHeader);
  return cookies[AUTH_COOKIE_NAME] || null;
}

function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  };
}

function parseAuthUser(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || typeof parsed.id !== "string"
      || typeof parsed.email !== "string"
      || typeof parsed.name !== "string"
      || typeof parsed.passwordHash !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      email: normalizeEmail(parsed.email),
      name: normalizeDisplayName(parsed.name),
      passwordHash: parsed.passwordHash,
      createdAt: parsed.createdAt || new Date().toISOString(),
    };
  } catch (_error) {
    return null;
  }
}

function parseAuthSession(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || typeof parsed.token !== "string"
      || typeof parsed.userId !== "string"
      || typeof parsed.email !== "string"
      || typeof parsed.name !== "string"
      || !Number.isInteger(parsed.expiresAt)
    ) {
      return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
}

function redisSessionKey(token) {
  return `${REDIS_SESSION_PREFIX}${token}`;
}

function redisUserSessionKey(userId) {
  return `${REDIS_USER_SESSION_PREFIX}${userId}`;
}

async function getUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }

  if (!redisDataClient) {
    return usersByEmail.get(normalized) || null;
  }

  const raw = await redisDataClient.hGet(REDIS_USERS_KEY, normalized);
  if (!raw) {
    return null;
  }
  return parseAuthUser(raw);
}

async function getUserById(userId) {
  if (!userId) {
    return null;
  }

  if (!redisDataClient) {
    return usersById.get(userId) || null;
  }

  const entries = await redisDataClient.hVals(REDIS_USERS_KEY);
  for (const entry of entries) {
    const user = parseAuthUser(entry);
    if (user && user.id === userId) {
      return user;
    }
  }
  return null;
}

async function saveUser(user) {
  if (!redisDataClient) {
    usersByEmail.set(user.email, user);
    usersById.set(user.id, user);
    return;
  }

  await redisDataClient.hSet(REDIS_USERS_KEY, user.email, JSON.stringify(user));
}

async function getUserSessionToken(userId) {
  if (!userId) {
    return null;
  }
  if (!redisDataClient) {
    return userSessionTokenByUserId.get(userId) || null;
  }
  return await redisDataClient.get(redisUserSessionKey(userId));
}

async function deleteSession(token, session = null) {
  if (!token) {
    return;
  }

  if (!redisDataClient) {
    const existing = session || sessionsByToken.get(token);
    sessionsByToken.delete(token);
    if (existing && userSessionTokenByUserId.get(existing.userId) === token) {
      userSessionTokenByUserId.delete(existing.userId);
    }
    return;
  }

  const existing = session || (await getSessionByToken(token));
  await redisDataClient.del(redisSessionKey(token));
  if (existing) {
    const key = redisUserSessionKey(existing.userId);
    const current = await redisDataClient.get(key);
    if (current === token) {
      await redisDataClient.del(key);
    }
  }
}

async function getSessionByToken(token) {
  if (!token) {
    return null;
  }

  if (!redisDataClient) {
    const session = sessionsByToken.get(token) || null;
    if (!session) {
      return null;
    }
    if (session.expiresAt <= Date.now()) {
      await deleteSession(token, session);
      return null;
    }
    return session;
  }

  const raw = await redisDataClient.get(redisSessionKey(token));
  if (!raw) {
    return null;
  }

  const session = parseAuthSession(raw);
  if (!session) {
    await redisDataClient.del(redisSessionKey(token));
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    await deleteSession(token, session);
    return null;
  }
  return session;
}

async function saveSession(session) {
  if (!redisDataClient) {
    sessionsByToken.set(session.token, session);
    userSessionTokenByUserId.set(session.userId, session.token);
    return;
  }

  await redisDataClient.setEx(
    redisSessionKey(session.token),
    AUTH_SESSION_TTL_SEC,
    JSON.stringify(session),
  );
  await redisDataClient.setEx(
    redisUserSessionKey(session.userId),
    AUTH_SESSION_TTL_SEC,
    session.token,
  );
}

async function refreshSession(session) {
  const next = {
    ...session,
    lastSeenAt: Date.now(),
    expiresAt: Date.now() + (AUTH_SESSION_TTL_SEC * 1000),
  };
  await saveSession(next);
  return next;
}

async function createSessionForUser(user) {
  const existingToken = await getUserSessionToken(user.id);
  if (existingToken) {
    const existing = await getSessionByToken(existingToken);
    if (existing && AUTH_REJECT_CONCURRENT) {
      return { ok: false, reason: "already_online" };
    }
    if (existing) {
      await deleteSession(existingToken, existing);
    }
  }

  const session = {
    token: randomId(24),
    userId: user.id,
    email: user.email,
    name: user.name,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    expiresAt: Date.now() + (AUTH_SESSION_TTL_SEC * 1000),
  };
  await saveSession(session);
  return { ok: true, session };
}

async function ensureSeedUsers() {
  if (!AUTH_SEED_TEST_USERS) {
    return;
  }

  for (const seed of TEST_USERS_SEED) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await getUserByEmail(seed.email);
    if (existing) {
      continue;
    }
    const user = {
      id: randomId(12),
      email: normalizeEmail(seed.email),
      name: normalizeDisplayName(seed.name),
      passwordHash: hashPassword(seed.password),
      createdAt: new Date().toISOString(),
    };
    // eslint-disable-next-line no-await-in-loop
    await saveUser(user);
  }
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

function setAuthCookie(res, token) {
  res.setHeader("Set-Cookie", cookieSerialize(AUTH_COOKIE_NAME, token, AUTH_SESSION_TTL_SEC, false));
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", cookieSerialize(AUTH_COOKIE_NAME, "", 0, true));
}

async function getAuthenticatedUserFromRequest(req) {
  const token = getAuthTokenFromRequest(req);
  if (!token) {
    return null;
  }

  const session = await getSessionByToken(token);
  if (!session) {
    return null;
  }

  const user = await getUserById(session.userId);
  if (!user) {
    await deleteSession(token, session);
    return null;
  }

  const refreshed = await refreshSession(session);
  return { token, session: refreshed, user };
}

app.use(express.json({ limit: "32kb" }));
app.use(express.static(PUBLIC_DIR));

app.post("/api/auth/register", async (req, res) => {
  const name = normalizeDisplayName(req.body?.name);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (
    !name
    || name.length < AUTH_DEFAULT_NAME_MIN
    || !isValidEmail(email)
    || password.length < AUTH_DEFAULT_PASSWORD_MIN
  ) {
    res.status(400).json({ ok: false, message: "Invalid register payload" });
    return;
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    res.status(409).json({ ok: false, message: "Email already registered" });
    return;
  }

  const user = {
    id: randomId(12),
    email,
    name,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  await saveUser(user);

  const created = await createSessionForUser(user);
  if (!created.ok) {
    res.status(409).json({ ok: false, message: created.reason });
    return;
  }

  setAuthCookie(res, created.session.token);
  res.status(201).json({ ok: true, user: toPublicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!isValidEmail(email) || !password) {
    res.status(400).json({ ok: false, message: "Invalid login payload" });
    return;
  }

  const user = await getUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ ok: false, message: "Invalid credentials" });
    return;
  }

  const created = await createSessionForUser(user);
  if (!created.ok) {
    res.status(409).json({ ok: false, message: created.reason });
    return;
  }

  setAuthCookie(res, created.session.token);
  res.json({ ok: true, user: toPublicUser(user) });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = getAuthTokenFromRequest(req);
  if (token) {
    const session = await getSessionByToken(token);
    await deleteSession(token, session);
  }
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  const auth = await getAuthenticatedUserFromRequest(req);
  if (!auth) {
    clearAuthCookie(res);
    res.status(401).json({ ok: false, message: "Unauthorized" });
    return;
  }

  res.json({
    ok: true,
    user: toPublicUser(auth.user),
  });
});

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

if (AUTH_REQUIRED) {
  io.use((socket, next) => {
    (async () => {
      const token = getAuthTokenFromSocket(socket);
      if (!token) {
        next(new Error("unauthorized"));
        return;
      }

      const session = await getSessionByToken(token);
      if (!session) {
        next(new Error("unauthorized"));
        return;
      }

      const user = await getUserById(session.userId);
      if (!user) {
        await deleteSession(token, session);
        next(new Error("unauthorized"));
        return;
      }

      await refreshSession(session);
      socket.data.auth = {
        userId: user.id,
        email: user.email,
        name: user.name,
      };
      next();
    })().catch((error) => {
      console.error("[socket-auth] failed:", error);
      next(new Error("unauthorized"));
    });
  });
}

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
  await ensureSeedUsers();

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
