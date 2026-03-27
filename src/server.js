const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const { MongoClient } = require('mongodb');
const fs = require('fs');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));

const packageJson = require(path.join(__dirname, '..', 'package.json'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket'],
  pingInterval: Number(process.env.SOCKET_PING_INTERVAL_MS || 10000),
  pingTimeout: Number(process.env.SOCKET_PING_TIMEOUT_MS || 5000),
});

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const GRID_SIZE = 64;
const MAX_SPAWN_ATTEMPTS = 500;
const MOVE_INTERVAL_MS = Number(process.env.MOVE_INTERVAL_MS || 16);
const BROADCAST_INTERVAL_MS = Number(process.env.BROADCAST_INTERVAL_MS || 33);
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS || 250);
const GHOST_SWEEP_INTERVAL_MS = Number(process.env.GHOST_SWEEP_INTERVAL_MS || 15000);
const AUTH_RELEASE_DELAY_MS = Number(process.env.AUTH_RELEASE_DELAY_MS || 12000);

const ENABLE_REDIS = String(process.env.ENABLE_REDIS || 'false') === 'true';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REDIS_PLAYERS_KEY = process.env.REDIS_PLAYERS_KEY || 'game64x64:players';
const REDIS_CELLS_KEY = process.env.REDIS_CELLS_KEY || 'game64x64:cells';
const REDIS_USERS_KEY = process.env.REDIS_USERS_KEY || 'game64x64:users';
const REDIS_SESSION_PREFIX = process.env.REDIS_SESSION_PREFIX || 'game64x64:session:';
const REDIS_USER_SESSION_PREFIX =
  process.env.REDIS_USER_SESSION_PREFIX || 'game64x64:user-session:';
const MONGO_URL = process.env.MONGO_URL || '';
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'game64x64';
const STATS_TOKEN = process.env.STATS_TOKEN || '';
const STARTED_AT = new Date().toISOString();
const APP_VERSION = String(process.env.APP_VERSION || packageJson.version || '0.0.0');
const NODE_ID = String(process.env.NODE_ID || os.hostname() || `node-${process.pid}`);
const STRICT_CLUSTER_CONFIG = String(process.env.STRICT_CLUSTER_CONFIG || 'true') === 'true';
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'game64x64_session';
const AUTH_COOKIE_SECURE = String(process.env.AUTH_COOKIE_SECURE || 'false') === 'true';
const AUTH_SESSION_TTL_SEC = Number(process.env.AUTH_SESSION_TTL_SEC || 86400);
const AUTH_LOGIN_FAIL_RATE_LIMIT_MAX = Number(process.env.AUTH_LOGIN_FAIL_RATE_LIMIT_MAX || 10);
const AUTH_LOGIN_FAIL_RATE_LIMIT_WINDOW_SEC = Number(
  process.env.AUTH_LOGIN_FAIL_RATE_LIMIT_WINDOW_SEC || 300
);
const AUTH_REGISTER_RATE_LIMIT_MAX = Number(process.env.AUTH_REGISTER_RATE_LIMIT_MAX || 15);
const AUTH_REGISTER_RATE_LIMIT_WINDOW_SEC = Number(
  process.env.AUTH_REGISTER_RATE_LIMIT_WINDOW_SEC || 600
);
const AUTH_REQUIRE_MONGO = String(process.env.AUTH_REQUIRE_MONGO || 'false') === 'true';
const AUTH_REJECT_CONCURRENT = String(process.env.AUTH_REJECT_CONCURRENT || 'true') === 'true';
const AUTH_SEED_TEST_USERS = String(process.env.AUTH_SEED_TEST_USERS || 'true') === 'true';
const AUTH_ALLOW_CONCURRENT_SEED_USERS =
  String(process.env.AUTH_ALLOW_CONCURRENT_SEED_USERS || 'true') === 'true';
const AUTH_REQUIRED = String(process.env.AUTH_REQUIRED || 'true') === 'true';
const AUTH_DEFAULT_PASSWORD_MIN = 6;
const AUTH_DEFAULT_NAME_MAX = 24;
const AUTH_DEFAULT_NAME_MIN = 2;

const players = new Map();
const lastMoveAt = new Map();
const VALID_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const usersByEmail = new Map();
const usersById = new Map();
const sessionsByToken = new Map();
const userSessionTokenByUserId = new Map();
const authRateLimitStore = new Map();
const pendingSessionReleaseTimers = new Map();

const TEST_USERS_SEED = [
  { name: 'Tài khoản kiểm thử 01', email: 'tester01@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 02', email: 'tester02@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 03', email: 'tester03@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 04', email: 'tester04@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 05', email: 'tester05@example.com', password: 'Test123!' },
];
const TEST_USERS_SEED_EMAILS = new Set(TEST_USERS_SEED.map((seed) => normalizeEmail(seed.email)));

let redisPubClient = null;
let redisSubClient = null;
let redisDataClient = null;
let mongoClient = null;
let mongoDb = null;
let mongoUsers = null;
let mongoSessions = null;
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

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function normalizeDisplayName(value) {
  const compact = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  return compact.slice(0, AUTH_DEFAULT_NAME_MAX);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashPassword(plainPassword) {
  const salt = randomId(16);
  const hashed = crypto.scryptSync(String(plainPassword), salt, 64).toString('hex');
  return `scrypt:${salt}:${hashed}`;
}

function verifyPassword(plainPassword, stored) {
  const raw = String(stored || '');
  const parts = raw.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(String(plainPassword), salt, expected.length);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function cookieSerialize(name, value, maxAgeSec, clear = false) {
  const base = `${name}=${clear ? '' : encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  const secure = AUTH_COOKIE_SECURE ? '; Secure' : '';
  if (clear) {
    return `${base}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
  }
  return `${base}; Max-Age=${maxAgeSec}${secure}`;
}

function parseCookies(cookieHeader) {
  const parsed = {};
  const raw = String(cookieHeader || '');
  if (!raw) {
    return parsed;
  }

  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name) {
      continue;
    }
    parsed[name] = decodeURIComponent(rest.join('=') || '');
  }
  return parsed;
}

function normalizeIp(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return 'unknown';
  }
  if (raw.startsWith('::ffff:')) {
    return raw.slice(7);
  }
  return raw;
}

function getRequestIp(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').trim();
  if (forwarded) {
    const first = forwarded.split(',')[0];
    return normalizeIp(first);
  }
  return normalizeIp(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress);
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
      !parsed ||
      typeof parsed.id !== 'string' ||
      typeof parsed.email !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.passwordHash !== 'string'
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
      !parsed ||
      typeof parsed.token !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.email !== 'string' ||
      typeof parsed.name !== 'string' ||
      !Number.isInteger(parsed.expiresAt)
    ) {
      return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
}

function isMongoEnabled() {
  return Boolean(MONGO_URL);
}

function isLoopbackHost(hostname) {
  const raw = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!raw) {
    return false;
  }
  return (
    raw === 'localhost' ||
    raw === '::1' ||
    raw === '[::1]' ||
    raw === '127.0.0.1' ||
    raw.startsWith('127.')
  );
}

function getMongoHosts(mongoUrl) {
  const raw = String(mongoUrl || '').trim();
  if (!raw) {
    return [];
  }

  const match = raw.match(/^mongodb(?:\+srv)?:\/\/([^/?]+)/i);
  if (!match) {
    return [];
  }

  const authority = match[1];
  const hostList = authority.includes('@') ? authority.split('@').slice(-1)[0] : authority;

  return hostList
    .split(',')
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.startsWith('[')) {
        const closingIndex = entry.indexOf(']');
        return closingIndex >= 0 ? entry.slice(1, closingIndex) : entry;
      }
      return entry.split(':')[0];
    });
}

function isLoopbackMongoUrl(mongoUrl) {
  return getMongoHosts(mongoUrl).some(isLoopbackHost);
}

function isLoopbackRedisUrl(redisUrl) {
  try {
    const parsed = new URL(redisUrl);
    return isLoopbackHost(parsed.hostname);
  } catch (_error) {
    return false;
  }
}

function getConfigWarnings() {
  const warnings = [];
  if (ENABLE_REDIS && isLoopbackRedisUrl(REDIS_URL)) {
    warnings.push('Redis is enabled but REDIS_URL points to a loopback host.');
  }
  if (ENABLE_REDIS && AUTH_REQUIRE_MONGO && isLoopbackMongoUrl(MONGO_URL)) {
    warnings.push('Cluster mode is enabled but MONGO_URL points to a loopback host.');
  }
  if (AUTH_REQUIRE_MONGO && !MONGO_URL) {
    warnings.push('AUTH_REQUIRE_MONGO is true but MONGO_URL is empty.');
  }
  return warnings;
}

function getConfigFatalErrors() {
  if (!STRICT_CLUSTER_CONFIG || process.env.NODE_ENV !== 'production') {
    return [];
  }

  const errors = [];
  if (ENABLE_REDIS && isLoopbackRedisUrl(REDIS_URL)) {
    errors.push('Cluster mode in production cannot use a loopback REDIS_URL.');
  }
  if (ENABLE_REDIS && AUTH_REQUIRE_MONGO && isLoopbackMongoUrl(MONGO_URL)) {
    errors.push('Cluster mode in production cannot use a loopback MONGO_URL.');
  }
  if (AUTH_REQUIRE_MONGO && !MONGO_URL) {
    errors.push('Production auth requires MONGO_URL when AUTH_REQUIRE_MONGO=true.');
  }
  return errors;
}

function getAuthStorageMode() {
  if (mongoUsers) {
    return 'mongo';
  }
  if (redisDataClient) {
    return 'redis';
  }
  return 'memory';
}

function isDuplicateAuthUserError(error) {
  return Number(error?.code) === 11000;
}

function mapMongoUser(doc) {
  if (!doc) {
    return null;
  }
  return {
    id: doc.id,
    email: doc.email,
    name: doc.name,
    passwordHash: doc.passwordHash,
    createdAt: doc.createdAt,
  };
}

function mapMongoSession(doc) {
  if (!doc) {
    return null;
  }
  const expiresAt = Number.isInteger(doc.expiresAt)
    ? doc.expiresAt
    : doc.expiresAtDate instanceof Date
      ? doc.expiresAtDate.getTime()
      : null;
  if (!expiresAt) {
    return null;
  }
  return {
    token: doc.token,
    userId: doc.userId,
    email: doc.email,
    name: doc.name,
    createdAt: Number.isInteger(doc.createdAt) ? doc.createdAt : Date.parse(doc.createdAt),
    lastSeenAt: Number.isInteger(doc.lastSeenAt) ? doc.lastSeenAt : Date.parse(doc.lastSeenAt),
    expiresAt,
  };
}

function redisSessionKey(token) {
  return `${REDIS_SESSION_PREFIX}${token}`;
}

function redisUserSessionKey(userId) {
  return `${REDIS_USER_SESSION_PREFIX}${userId}`;
}

function authRateLimitKey(scope, key) {
  return `game64x64:auth-rate:${scope}:${key}`;
}

function getAuthRateLimitMemoryState(cacheKey, windowSec) {
  const now = Date.now();
  const current = authRateLimitStore.get(cacheKey);
  if (!current || current.resetAt <= now) {
    if (current) {
      authRateLimitStore.delete(cacheKey);
    }
    return {
      count: 0,
      resetAt: now + windowSec * 1000,
    };
  }
  return current;
}

async function getAuthRateLimitState(scope, key, windowSec) {
  const cacheKey = authRateLimitKey(scope, key);
  if (!redisDataClient) {
    const state = getAuthRateLimitMemoryState(cacheKey, windowSec);
    return {
      count: state.count,
      retryAfterSec: Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000)),
    };
  }

  const raw = await redisDataClient.get(cacheKey);
  const ttl = await redisDataClient.ttl(cacheKey);
  return {
    count: raw ? Number(raw) || 0 : 0,
    retryAfterSec: ttl > 0 ? ttl : windowSec,
  };
}

async function incrementAuthRateLimit(scope, key, windowSec) {
  const cacheKey = authRateLimitKey(scope, key);
  if (!redisDataClient) {
    const state = getAuthRateLimitMemoryState(cacheKey, windowSec);
    const next = {
      count: state.count + 1,
      resetAt: state.resetAt,
    };
    authRateLimitStore.set(cacheKey, next);
    return {
      count: next.count,
      retryAfterSec: Math.max(1, Math.ceil((next.resetAt - Date.now()) / 1000)),
    };
  }

  const nextCount = await redisDataClient.incr(cacheKey);
  if (nextCount === 1) {
    await redisDataClient.expire(cacheKey, windowSec);
  }
  const ttl = await redisDataClient.ttl(cacheKey);
  return {
    count: nextCount,
    retryAfterSec: ttl > 0 ? ttl : windowSec,
  };
}

async function clearAuthRateLimit(scope, key) {
  const cacheKey = authRateLimitKey(scope, key);
  if (!redisDataClient) {
    authRateLimitStore.delete(cacheKey);
    return;
  }
  await redisDataClient.del(cacheKey);
}

function setRetryAfter(res, retryAfterSec) {
  res.setHeader('Retry-After', String(Math.max(1, Number(retryAfterSec) || 1)));
}

async function getUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }

  if (mongoUsers) {
    const doc = await mongoUsers.findOne({ email: normalized });
    return mapMongoUser(doc);
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

  if (mongoUsers) {
    const doc = await mongoUsers.findOne({ id: userId });
    return mapMongoUser(doc);
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

async function createUser(user) {
  const next = {
    ...user,
    email: normalizeEmail(user.email),
    name: normalizeDisplayName(user.name),
  };

  if (mongoUsers) {
    try {
      await mongoUsers.insertOne(next);
      return { ok: true, user: next };
    } catch (error) {
      if (isDuplicateAuthUserError(error)) {
        return { ok: false, reason: 'exists' };
      }
      throw error;
    }
  }

  if (!redisDataClient) {
    if (usersByEmail.has(next.email)) {
      return { ok: false, reason: 'exists' };
    }
    usersByEmail.set(next.email, next);
    usersById.set(next.id, next);
    return { ok: true, user: next };
  }

  const saved = await redisDataClient.hSetNX(REDIS_USERS_KEY, next.email, JSON.stringify(next));
  if (!saved) {
    return { ok: false, reason: 'exists' };
  }
  return { ok: true, user: next };
}

async function getUserSessionToken(userId) {
  if (!userId) {
    return null;
  }
  if (mongoSessions) {
    const doc = await mongoSessions.findOne(
      { userId, expiresAt: { $gt: Date.now() } },
      { sort: { expiresAt: -1 } }
    );
    return doc ? doc.token : null;
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

  if (mongoSessions) {
    await mongoSessions.deleteOne({ token });
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

  if (mongoSessions) {
    const doc = await mongoSessions.findOne({ token });
    const session = mapMongoSession(doc);
    if (!session) {
      if (doc) {
        await mongoSessions.deleteOne({ token });
      }
      return null;
    }
    if (session.expiresAt <= Date.now()) {
      await mongoSessions.deleteOne({ token });
      return null;
    }
    return session;
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
  if (mongoSessions) {
    const next = {
      ...session,
      expiresAtDate: new Date(session.expiresAt),
    };
    await mongoSessions.updateOne({ token: session.token }, { $set: next }, { upsert: true });
    return;
  }

  if (!redisDataClient) {
    sessionsByToken.set(session.token, session);
    userSessionTokenByUserId.set(session.userId, session.token);
    return;
  }

  await redisDataClient.setEx(
    redisSessionKey(session.token),
    AUTH_SESSION_TTL_SEC,
    JSON.stringify(session)
  );
  await redisDataClient.setEx(
    redisUserSessionKey(session.userId),
    AUTH_SESSION_TTL_SEC,
    session.token
  );
}

async function refreshSession(session) {
  const next = {
    ...session,
    lastSeenAt: Date.now(),
    expiresAt: Date.now() + AUTH_SESSION_TTL_SEC * 1000,
  };
  await saveSession(next);
  return next;
}

async function hasActiveSocketForUser(userId) {
  if (!AUTH_REQUIRED || !userId) {
    return false;
  }

  const sockets = await io.fetchSockets();
  return sockets.some((socket) => socket?.data?.auth?.userId === userId);
}

function clearPendingSessionRelease(userId) {
  if (!userId) {
    return;
  }
  const timer = pendingSessionReleaseTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    pendingSessionReleaseTimers.delete(userId);
  }
}

async function releaseSessionIfOffline(userId, token) {
  if (!AUTH_REQUIRED || !userId || !token) {
    return;
  }

  const sockets = await io.fetchSockets();
  const stillOnline = sockets.some((socket) => socket?.data?.auth?.userId === userId);
  if (stillOnline) {
    return;
  }

  const session = await getSessionByToken(token);
  if (!session || session.userId !== userId) {
    return;
  }

  await deleteSession(token, session);
  console.log(`[auth] Released idle session for user=${userId} after disconnect.`);
}

function scheduleSessionRelease(userId, token) {
  if (!AUTH_REQUIRED || !userId || !token) {
    return;
  }

  clearPendingSessionRelease(userId);

  const run = async () => {
    try {
      await releaseSessionIfOffline(userId, token);
    } catch (error) {
      stats.errorsTotal += 1;
      console.error('[auth-release] failed:', error);
    } finally {
      pendingSessionReleaseTimers.delete(userId);
    }
  };

  if (AUTH_RELEASE_DELAY_MS <= 0) {
    run();
    return;
  }

  const timer = setTimeout(run, AUTH_RELEASE_DELAY_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  pendingSessionReleaseTimers.set(userId, timer);
}

async function createSessionForUser(user, options = {}) {
  const forceExistingSession = options.forceExistingSession === true;
  const allowConcurrentSeedSession =
    AUTH_ALLOW_CONCURRENT_SEED_USERS && TEST_USERS_SEED_EMAILS.has(normalizeEmail(user?.email));
  const existingToken = allowConcurrentSeedSession ? null : await getUserSessionToken(user.id);
  if (existingToken) {
    const existing = await getSessionByToken(existingToken);
    if (existing) {
      if (AUTH_REJECT_CONCURRENT && !forceExistingSession) {
        const active = await hasActiveSocketForUser(existing.userId);
        if (active) {
          return { ok: false, reason: 'already_online' };
        }
      }
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
    expiresAt: Date.now() + AUTH_SESSION_TTL_SEC * 1000,
  };
  await saveSession(session);
  return { ok: true, session };
}

async function ensureSeedUsers() {
  if (!AUTH_SEED_TEST_USERS) {
    return;
  }

  for (const seed of TEST_USERS_SEED) {
    const user = {
      id: randomId(12),
      email: normalizeEmail(seed.email),
      name: normalizeDisplayName(seed.name),
      passwordHash: hashPassword(seed.password),
      createdAt: new Date().toISOString(),
    };
    const created = await createUser(user);
    if (!created.ok && created.reason !== 'exists') {
      throw new Error(`Failed to seed auth user for ${seed.email}`);
    }
  }
}

function parsePlayer(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== 'string') {
      return null;
    }
    return {
      id: parsed.id,
      x: clamp(Number(parsed.x), 0, GRID_SIZE - 1),
      y: clamp(Number(parsed.y), 0, GRID_SIZE - 1),
      color: typeof parsed.color === 'string' ? parsed.color : '#999999',
    };
  } catch (_error) {
    return null;
  }
}

async function connectRedisIfEnabled() {
  if (!ENABLE_REDIS) {
    console.log('[startup] Redis disabled. Using in-memory player store.');
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

async function connectMongoIfEnabled() {
  if (!isMongoEnabled()) {
    return;
  }

  mongoClient = new MongoClient(MONGO_URL, { maxPoolSize: 10 });
  await mongoClient.connect();
  mongoDb = mongoClient.db(MONGO_DB_NAME);
  mongoUsers = mongoDb.collection('users');
  mongoSessions = mongoDb.collection('sessions');

  await Promise.all([
    mongoUsers.createIndex({ email: 1 }, { unique: true }),
    mongoUsers.createIndex({ id: 1 }, { unique: true }),
    mongoSessions.createIndex({ token: 1 }, { unique: true }),
    mongoSessions.createIndex({ userId: 1 }),
    mongoSessions.createIndex({ expiresAtDate: 1 }, { expireAfterSeconds: 0 }),
  ]);

  console.log('[startup] MongoDB enabled for auth storage.');
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
    { keys: [REDIS_PLAYERS_KEY, REDIS_CELLS_KEY], arguments: [id] }
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

    if (!(await isOccupied(x, y))) {
      return { x, y };
    }
  }

  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
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

async function sweepGhostPlayers() {
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
      }
    );

    if (claimed === 1) {
      return { id: playerId, x, y, color };
    }
  }

  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
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

async function movePlayerRedis(playerId, direction) {
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
      keys: [REDIS_PLAYERS_KEY, REDIS_CELLS_KEY],
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

  if (!redisDataClient) {
    await savePlayer(next);
    return { ok: true, player: next };
  }

  const fromCell = toCellKey(player.x, player.y);
  const toCell = toCellKey(x, y);
  const tx = redisDataClient.multi();
  if (fromCell !== toCell) {
    tx.hDel(REDIS_CELLS_KEY, fromCell);
  }
  tx.hSet(REDIS_CELLS_KEY, toCell, playerId);
  tx.hSet(REDIS_PLAYERS_KEY, playerId, JSON.stringify(next));
  await tx.exec();
  return { ok: true, player: next };
}

function getNextPosition(player, direction) {
  let nextX = player.x;
  let nextY = player.y;

  if (direction === 'up') {
    nextY = clamp(player.y - 1, 0, GRID_SIZE - 1);
  } else if (direction === 'down') {
    nextY = clamp(player.y + 1, 0, GRID_SIZE - 1);
  } else if (direction === 'left') {
    nextX = clamp(player.x - 1, 0, GRID_SIZE - 1);
  } else if (direction === 'right') {
    nextX = clamp(player.x + 1, 0, GRID_SIZE - 1);
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
  }, BROADCAST_INTERVAL_MS);
}

function getStatsSnapshot(playersCount) {
  return {
    version: APP_VERSION,
    nodeId: NODE_ID,
    startedAt: STARTED_AT,
    uptimeSec: Math.floor(process.uptime()),
    pid: process.pid,
    redisEnabled: ENABLE_REDIS,
    authStorage: getAuthStorageMode(),
    mongoConnected: Boolean(mongoUsers),
    configWarnings: getConfigWarnings(),
    playersOnline: playersCount,
    socketsOnline: io.of('/').sockets.size,
    counters: { ...stats },
  };
}

function isStatsAuthorized(req) {
  if (!STATS_TOKEN) {
    return true;
  }
  return req.get('x-stats-token') === STATS_TOKEN;
}

function getRedactedMongoUrl() {
  if (!MONGO_URL) {
    return '';
  }

  try {
    const parsed = new URL(MONGO_URL);
    const authPrefix = parsed.username ? `${parsed.username}:***@` : '';
    const pathname = parsed.pathname || '';
    return `${parsed.protocol}//${authPrefix}${parsed.host}${pathname}`;
  } catch (_error) {
    return MONGO_URL;
  }
}

function setAuthCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    cookieSerialize(AUTH_COOKIE_NAME, token, AUTH_SESSION_TTL_SEC, false)
  );
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', cookieSerialize(AUTH_COOKIE_NAME, '', 0, true));
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

app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  const route = String(req.path || '').toLowerCase();
  if (route.endsWith('.html') || route === '/' || route === '/auth' || route === '/game') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.get('/', (_req, res) => {
  res.redirect(302, '/auth.html');
});
app.get('/index.html', (_req, res) => {
  res.redirect(302, '/auth.html');
});
app.use(express.static(PUBLIC_DIR));

app.post('/api/auth/register', async (req, res) => {
  const clientIp = getRequestIp(req);
  const registerRateKey = clientIp;
  if (AUTH_REGISTER_RATE_LIMIT_MAX > 0) {
    const currentLimit = await getAuthRateLimitState(
      'register',
      registerRateKey,
      AUTH_REGISTER_RATE_LIMIT_WINDOW_SEC
    );
    if (currentLimit.count >= AUTH_REGISTER_RATE_LIMIT_MAX) {
      console.warn(
        `[auth-register] rate_limited ip=${clientIp} retryAfter=${currentLimit.retryAfterSec}s stage=precheck`
      );
      setRetryAfter(res, currentLimit.retryAfterSec);
      res.status(429).json({ ok: false, message: 'Too many register attempts' });
      return;
    }
  }

  const name = normalizeDisplayName(req.body?.name);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (
    !name ||
    name.length < AUTH_DEFAULT_NAME_MIN ||
    !isValidEmail(email) ||
    password.length < AUTH_DEFAULT_PASSWORD_MIN
  ) {
    console.warn(
      `[auth-register] invalid_payload ip=${clientIp} email=${email || 'missing'} nameLength=${name.length} passwordLength=${password.length}`
    );
    res.status(400).json({ ok: false, message: 'Invalid register payload' });
    return;
  }

  if (AUTH_REGISTER_RATE_LIMIT_MAX > 0) {
    const nextLimit = await incrementAuthRateLimit(
      'register',
      registerRateKey,
      AUTH_REGISTER_RATE_LIMIT_WINDOW_SEC
    );
    if (nextLimit.count > AUTH_REGISTER_RATE_LIMIT_MAX) {
      console.warn(
        `[auth-register] rate_limited ip=${clientIp} email=${email} retryAfter=${nextLimit.retryAfterSec}s stage=post-increment`
      );
      setRetryAfter(res, nextLimit.retryAfterSec);
      res.status(429).json({ ok: false, message: 'Too many register attempts' });
      return;
    }
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    console.warn(`[auth-register] duplicate_email ip=${clientIp} email=${email}`);
    res.status(409).json({ ok: false, message: 'Email already registered' });
    return;
  }

  const user = {
    id: randomId(12),
    email,
    name,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  const createdUser = await createUser(user);
  if (!createdUser.ok) {
    console.warn(`[auth-register] create_user_conflict ip=${clientIp} email=${email}`);
    res.status(409).json({ ok: false, message: 'Email already registered' });
    return;
  }

  const created = await createSessionForUser(createdUser.user);
  if (!created.ok) {
    console.warn(`[auth-register] session_conflict ip=${clientIp} email=${email} reason=${created.reason}`);
    res.status(409).json({ ok: false, message: created.reason });
    return;
  }

  setAuthCookie(res, created.session.token);
  console.log(
    `[auth-register] success ip=${clientIp} email=${email} userId=${createdUser.user.id} authStorage=${getAuthStorageMode()}`
  );
  res.status(201).json({ ok: true, user: toPublicUser(createdUser.user) });
});

app.post('/api/auth/login', async (req, res) => {
  const clientIp = getRequestIp(req);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const forceFromClient = req.body?.force === true;
  const loginRateKey = `${clientIp}:${email || 'unknown'}`;
  if (!isValidEmail(email) || !password) {
    res.status(400).json({ ok: false, message: 'Invalid login payload' });
    return;
  }

  if (AUTH_LOGIN_FAIL_RATE_LIMIT_MAX > 0) {
    const currentLimit = await getAuthRateLimitState(
      'login-fail',
      loginRateKey,
      AUTH_LOGIN_FAIL_RATE_LIMIT_WINDOW_SEC
    );
    if (currentLimit.count >= AUTH_LOGIN_FAIL_RATE_LIMIT_MAX) {
      setRetryAfter(res, currentLimit.retryAfterSec);
      res.status(429).json({ ok: false, message: 'Too many login attempts' });
      return;
    }
  }

  const user = await getUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    if (AUTH_LOGIN_FAIL_RATE_LIMIT_MAX > 0) {
      const nextLimit = await incrementAuthRateLimit(
        'login-fail',
        loginRateKey,
        AUTH_LOGIN_FAIL_RATE_LIMIT_WINDOW_SEC
      );
      if (nextLimit.count >= AUTH_LOGIN_FAIL_RATE_LIMIT_MAX) {
        setRetryAfter(res, nextLimit.retryAfterSec);
        res.status(429).json({ ok: false, message: 'Too many login attempts' });
        return;
      }
    }
    res.status(401).json({ ok: false, message: 'Invalid credentials' });
    return;
  }

  await clearAuthRateLimit('login-fail', loginRateKey);

  const forceExistingSession = forceFromClient || TEST_USERS_SEED_EMAILS.has(email);
  const created = await createSessionForUser(user, { forceExistingSession });
  if (!created.ok) {
    res.status(409).json({ ok: false, message: created.reason });
    return;
  }

  setAuthCookie(res, created.session.token);
  res.json({ ok: true, user: toPublicUser(user) });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = getAuthTokenFromRequest(req);
  if (token) {
    const session = await getSessionByToken(token);
    await deleteSession(token, session);
  }
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const auth = await getAuthenticatedUserFromRequest(req);
  if (!auth) {
    clearAuthCookie(res);
    res.status(401).json({ ok: false, message: 'Unauthorized' });
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
    version: APP_VERSION,
    nodeId: NODE_ID,
    startedAt: STARTED_AT,
    players: list.length,
    redisEnabled: ENABLE_REDIS,
    authStorage: getAuthStorageMode(),
    mongoConnected: Boolean(mongoUsers),
    configWarnings: getConfigWarnings(),
  });
}

async function handleStats(req, res) {
  if (!isStatsAuthorized(req)) {
    res.status(401).json({ ok: false, message: 'Unauthorized' });
    return;
  }

  const list = await getPlayersList();
  res.json({
    ok: true,
    ...getStatsSnapshot(list.length),
  });
}

async function handleDebugUserLookup(req, res) {
  if (!isStatsAuthorized(req)) {
    res.status(401).json({ ok: false, message: 'Unauthorized' });
    return;
  }

  const email = normalizeEmail(req.query?.email);
  if (!email) {
    res.status(400).json({ ok: false, message: 'Missing email query param' });
    return;
  }

  const user = await getUserByEmail(email);
  res.json({
    ok: true,
    lookupEmail: email,
    nodeId: NODE_ID,
    authStorage: getAuthStorageMode(),
    mongoConnected: Boolean(mongoUsers),
    mongoUrl: getRedactedMongoUrl(),
    found: Boolean(user),
    user: user ? toPublicUser(user) : null,
  });
}

app.get('/health', handleHealth);
app.get('/api/health', handleHealth);
app.get('/stats', handleStats);
app.get('/api/stats', handleStats);
app.get('/api/debug/user-by-email', handleDebugUserLookup);

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

if (AUTH_REQUIRED) {
  io.use((socket, next) => {
    (async () => {
      const token = getAuthTokenFromSocket(socket);
      if (!token) {
        next(new Error('unauthorized'));
        return;
      }

      const session = await getSessionByToken(token);
      if (!session) {
        next(new Error('unauthorized'));
        return;
      }

      const user = await getUserById(session.userId);
      if (!user) {
        await deleteSession(token, session);
        next(new Error('unauthorized'));
        return;
      }

      await refreshSession(session);
      socket.data.auth = {
        userId: user.id,
        email: user.email,
        name: user.name,
      };
      socket.data.authToken = token;
      clearPendingSessionRelease(user.id);
      next();
    })().catch((error) => {
      console.error('[socket-auth] failed:', error);
      next(new Error('unauthorized'));
    });
  });
}

io.on('connection', (socket) => {
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
    console.error('[connection] failed:', error);
    socket.disconnect(true);
  });

  socket.on('move', (payload) => {
    stats.movesReceived += 1;

    (async () => {
      const seq = normalizeSeq(payload?.seq);
      const coordX = normalizeCoord(payload?.x, GRID_SIZE - 1);
      const coordY = normalizeCoord(payload?.y, GRID_SIZE - 1);
      const hasCoordFields = payload && ('x' in payload || 'y' in payload);
      const hasCoords = coordX !== null && coordY !== null;
      const direction = payload?.direction;

      if (hasCoordFields && !hasCoords) {
        stats.movesRejectedInvalid += 1;
        emitMoveAck(socket, seq, false, 'invalid_coords');
        return;
      }

      if (hasCoords) {
        const moved = await movePlayerTo(socket.id, coordX, coordY);
        if (!moved.ok) {
          emitMoveAck(socket, seq, false, moved.reason || 'missing_player');
          return;
        }
        emitPlayerMoved(moved.player, seq);
        emitMoveAck(socket, seq, true, null, moved.player);
        await emitPlayersNow();
        stats.movesApplied += 1;
        return;
      }

      if (typeof direction !== 'string' || !VALID_DIRECTIONS.has(direction)) {
        stats.movesRejectedInvalid += 1;
        emitMoveAck(socket, seq, false, 'invalid_direction');
        return;
      }

      const player = await getPlayerById(socket.id);
      if (!player) {
        emitMoveAck(socket, seq, false, 'missing_player');
        return;
      }

      const now = Date.now();
      const last = lastMoveAt.get(socket.id) || 0;
      if (now - last < MOVE_INTERVAL_MS) {
        stats.movesRejectedRateLimit += 1;
        emitMoveAck(socket, seq, false, 'rate_limited', player);
        return;
      }
      lastMoveAt.set(socket.id, now);

      if (redisDataClient) {
        const moved = await movePlayerRedis(socket.id, direction);
        if (moved.state === 'occupied') {
          stats.movesRejectedOccupied += 1;
          emitMoveAck(socket, seq, false, 'occupied', player);
          return;
        }
        if (moved.state !== 'applied') {
          emitMoveAck(socket, seq, false, 'missing_player');
          return;
        }
        const updatedPlayer = moved.player || player;
        emitPlayerMoved(updatedPlayer, seq);
        emitMoveAck(socket, seq, true, null, updatedPlayer);
        await emitPlayersNow();
        stats.movesApplied += 1;
      } else {
        const next = getNextPosition(player, direction);
        if (await isOccupied(next.x, next.y, socket.id)) {
          stats.movesRejectedOccupied += 1;
          emitMoveAck(socket, seq, false, 'occupied', player);
          return;
        }

        player.x = next.x;
        player.y = next.y;
        await savePlayer(player);
        emitPlayerMoved(player, seq);
        emitMoveAck(socket, seq, true, null, player);
        await emitPlayersNow();
        stats.movesApplied += 1;
      }
    })().catch((error) => {
      stats.errorsTotal += 1;
      console.error('[move] failed:', error);
    });
  });

  socket.on('disconnect', () => {
    stats.disconnectionsTotal += 1;

    (async () => {
      const disconnectedId = socket.id;
      const userId = socket?.data?.auth?.userId || null;
      const authToken = socket?.data?.authToken || null;
      await removePlayer(disconnectedId);
      lastMoveAt.delete(disconnectedId);
      scheduleSessionRelease(userId, authToken);
      scheduleEmitPlayers();
      emitPlayerLeft(disconnectedId);
    })().catch((error) => {
      stats.errorsTotal += 1;
      console.error('[disconnect] failed:', error);
    });
  });
});

async function start() {
  const configWarnings = getConfigWarnings();
  if (configWarnings.length > 0) {
    for (const warning of configWarnings) {
      console.warn(`[startup-warning] ${warning}`);
    }
  }

  const configFatalErrors = getConfigFatalErrors();
  if (configFatalErrors.length > 0) {
    for (const fatalError of configFatalErrors) {
      console.error(`[startup-config] ${fatalError}`);
    }
    process.exit(1);
  }

  await connectMongoIfEnabled();
  if (AUTH_REQUIRE_MONGO && !mongoUsers) {
    console.error('[startup] MongoDB is required for auth, but it is not enabled.');
    process.exit(1);
  }

  await connectRedisIfEnabled();
  await ensureSeedUsers();

  if (ENABLE_REDIS && GHOST_SWEEP_INTERVAL_MS > 0) {
    const sweepTimer = setInterval(() => {
      sweepGhostPlayers();
    }, GHOST_SWEEP_INTERVAL_MS);
    if (typeof sweepTimer.unref === 'function') {
      sweepTimer.unref();
    }
  }

  if (SNAPSHOT_INTERVAL_MS > 0) {
    const snapshotTimer = setInterval(() => {
      scheduleEmitPlayers();
    }, SNAPSHOT_INTERVAL_MS);
    if (typeof snapshotTimer.unref === 'function') {
      snapshotTimer.unref();
    }
  }

  server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
    if (ENABLE_REDIS) {
      sweepGhostPlayers();
    }
  });
}

start().catch((error) => {
  console.error('[startup] failed:', error);
  process.exit(1);
});
