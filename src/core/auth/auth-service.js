/* eslint-disable no-console */
const crypto = require('crypto');

function createAuthService(options) {
  const {
    config,
    stats,
    TEST_USERS_SEED,
    getRedisDataClient,
    getMongoUsers,
    getMongoSessions,
    getSockets,
  } = options;

  const usersByEmail = new Map();
  const usersById = new Map();
  const sessionsByToken = new Map();
  const userSessionTokenByUserId = new Map();
  const authRateLimitStore = new Map();
  const pendingSessionReleaseTimers = new Map();

  function normalizeEmail(value) {
    return String(value || '')
      .trim()
      .toLowerCase();
  }

  function normalizeDisplayName(value) {
    const compact = String(value || '')
      .trim()
      .replace(/\s+/g, ' ');
    return compact.slice(0, config.AUTH_DEFAULT_NAME_MAX);
  }

  const TEST_USERS_SEED_EMAILS = new Set(TEST_USERS_SEED.map((seed) => normalizeEmail(seed.email)));

  function isSeedTestEmail(email) {
    return TEST_USERS_SEED_EMAILS.has(normalizeEmail(email));
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
    const secure = config.AUTH_COOKIE_SECURE ? '; Secure' : '';
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
    return cookies[config.AUTH_COOKIE_NAME] || null;
  }

  function getAuthTokenFromSocket(socket) {
    const cookieHeader = socket?.handshake?.headers?.cookie;
    const cookies = parseCookies(cookieHeader);
    return cookies[config.AUTH_COOKIE_NAME] || null;
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
    return `${config.REDIS_SESSION_PREFIX}${token}`;
  }

  function redisUserSessionKey(userId) {
    return `${config.REDIS_USER_SESSION_PREFIX}${userId}`;
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
    const redisDataClient = getRedisDataClient();
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
    const redisDataClient = getRedisDataClient();
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
    const redisDataClient = getRedisDataClient();
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

    const mongoUsers = getMongoUsers();
    if (mongoUsers) {
      const doc = await mongoUsers.findOne({ email: normalized });
      return mapMongoUser(doc);
    }

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      return usersByEmail.get(normalized) || null;
    }

    const raw = await redisDataClient.hGet(config.REDIS_USERS_KEY, normalized);
    if (!raw) {
      return null;
    }
    return parseAuthUser(raw);
  }

  async function getUserById(userId) {
    if (!userId) {
      return null;
    }

    const mongoUsers = getMongoUsers();
    if (mongoUsers) {
      const doc = await mongoUsers.findOne({ id: userId });
      return mapMongoUser(doc);
    }

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      return usersById.get(userId) || null;
    }

    const entries = await redisDataClient.hVals(config.REDIS_USERS_KEY);
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

    const mongoUsers = getMongoUsers();
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

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      if (usersByEmail.has(next.email)) {
        return { ok: false, reason: 'exists' };
      }
      usersByEmail.set(next.email, next);
      usersById.set(next.id, next);
      return { ok: true, user: next };
    }

    const saved = await redisDataClient.hSetNX(config.REDIS_USERS_KEY, next.email, JSON.stringify(next));
    if (!saved) {
      return { ok: false, reason: 'exists' };
    }
    return { ok: true, user: next };
  }

  async function getUserSessionToken(userId) {
    if (!userId) {
      return null;
    }

    const mongoSessions = getMongoSessions();
    if (mongoSessions) {
      const doc = await mongoSessions.findOne(
        { userId, expiresAt: { $gt: Date.now() } },
        { sort: { expiresAt: -1 } }
      );
      return doc ? doc.token : null;
    }

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      return userSessionTokenByUserId.get(userId) || null;
    }
    return await redisDataClient.get(redisUserSessionKey(userId));
  }

  async function deleteSession(token, session = null) {
    if (!token) {
      return;
    }

    const mongoSessions = getMongoSessions();
    if (mongoSessions) {
      await mongoSessions.deleteOne({ token });
      return;
    }

    const redisDataClient = getRedisDataClient();
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

    const mongoSessions = getMongoSessions();
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

    const redisDataClient = getRedisDataClient();
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
    const mongoSessions = getMongoSessions();
    if (mongoSessions) {
      const next = {
        ...session,
        expiresAtDate: new Date(session.expiresAt),
      };
      await mongoSessions.updateOne({ token: session.token }, { $set: next }, { upsert: true });
      return;
    }

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      sessionsByToken.set(session.token, session);
      userSessionTokenByUserId.set(session.userId, session.token);
      return;
    }

    await redisDataClient.setEx(
      redisSessionKey(session.token),
      config.AUTH_SESSION_TTL_SEC,
      JSON.stringify(session)
    );
    await redisDataClient.setEx(
      redisUserSessionKey(session.userId),
      config.AUTH_SESSION_TTL_SEC,
      session.token
    );
  }

  async function refreshSession(session) {
    const next = {
      ...session,
      lastSeenAt: Date.now(),
      expiresAt: Date.now() + config.AUTH_SESSION_TTL_SEC * 1000,
    };
    await saveSession(next);
    return next;
  }

  async function hasActiveSocketForUser(userId) {
    if (!config.AUTH_REQUIRED || !userId) {
      return false;
    }

    const sockets = await getSockets();
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
    if (!config.AUTH_REQUIRED || !userId || !token) {
      return;
    }

    const sockets = await getSockets();
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
    if (!config.AUTH_REQUIRED || !userId || !token) {
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

    if (config.AUTH_RELEASE_DELAY_MS <= 0) {
      run();
      return;
    }

    const timer = setTimeout(run, config.AUTH_RELEASE_DELAY_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    pendingSessionReleaseTimers.set(userId, timer);
  }

  async function createSessionForUser(user, options = {}) {
    const forceExistingSession = options.forceExistingSession === true;
    const allowConcurrentSeedSession =
      config.AUTH_ALLOW_CONCURRENT_SEED_USERS && isSeedTestEmail(user?.email);
    const existingToken = allowConcurrentSeedSession ? null : await getUserSessionToken(user.id);
    if (existingToken) {
      const existing = await getSessionByToken(existingToken);
      if (existing) {
        if (config.AUTH_REJECT_CONCURRENT && !forceExistingSession) {
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
      expiresAt: Date.now() + config.AUTH_SESSION_TTL_SEC * 1000,
    };
    await saveSession(session);
    return { ok: true, session };
  }

  async function ensureSeedUsers() {
    if (!config.AUTH_SEED_TEST_USERS) {
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

  function getAuthStorageMode() {
    if (getMongoUsers()) {
      return 'mongo';
    }
    if (getRedisDataClient()) {
      return 'redis';
    }
    return 'memory';
  }

  function isMongoConnected() {
    return Boolean(getMongoUsers());
  }

  function setAuthCookie(res, token) {
    res.setHeader(
      'Set-Cookie',
      cookieSerialize(config.AUTH_COOKIE_NAME, token, config.AUTH_SESSION_TTL_SEC, false)
    );
  }

  function clearAuthCookie(res) {
    res.setHeader('Set-Cookie', cookieSerialize(config.AUTH_COOKIE_NAME, '', 0, true));
  }

  async function getAuthenticatedUserByToken(token) {
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

  async function getAuthenticatedUserFromRequest(req) {
    return await getAuthenticatedUserByToken(getAuthTokenFromRequest(req));
  }

  return {
    TEST_USERS_SEED_EMAILS,
    clearAuthCookie,
    clearAuthRateLimit,
    clearPendingSessionRelease,
    createSessionForUser,
    createUser,
    deleteSession,
    ensureSeedUsers,
    getAuthenticatedUserByToken,
    getAuthenticatedUserFromRequest,
    getAuthRateLimitState,
    getAuthStorageMode,
    getAuthTokenFromRequest,
    getAuthTokenFromSocket,
    getRequestIp,
    getSessionByToken,
    getUserByEmail,
    getUserById,
    hashPassword,
    incrementAuthRateLimit,
    isMongoConnected,
    isSeedTestEmail,
    isValidEmail,
    normalizeDisplayName,
    normalizeEmail,
    randomId,
    refreshSession,
    scheduleSessionRelease,
    setAuthCookie,
    setRetryAfter,
    toPublicUser,
    verifyPassword,
  };
}

module.exports = {
  createAuthService,
};
