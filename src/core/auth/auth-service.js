/* eslint-disable no-console */
const crypto = require('crypto');

const REQUEST_AUTH_CONTEXT_KEY = Symbol('game64x64.requestAuthContext');

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

  function normalizeUserRole(value) {
    return String(value || '').trim().toLowerCase() === 'admin' ? 'admin' : 'user';
  }

  const ADMIN_EMAILS = new Set((config.AUTH_ADMIN_EMAILS || []).map((email) => normalizeEmail(email)));

  function isAdminUser(user) {
    if (!user) {
      return false;
    }
    return normalizeUserRole(user.role) === 'admin' || ADMIN_EMAILS.has(normalizeEmail(user.email));
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
    return normalizeIp(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress);
  }

  function readHeader(source, name) {
    const normalized = String(name || '').toLowerCase();
    if (!normalized || !source) {
      return '';
    }
    if (typeof source.get === 'function') {
      return String(source.get(normalized) || source.get(name) || '');
    }
    const headers = source.headers || {};
    return String(headers[normalized] || headers[name] || '');
  }

  function normalizeHost(value) {
    return String(value || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .find(Boolean);
  }

  function isTrustedOriginRequest(source) {
    const sourceOrigin = readHeader(source, 'origin').trim();
    if (!sourceOrigin) {
      return true;
    }

    const expectedHost = normalizeHost(
      readHeader(source, 'x-forwarded-host') || readHeader(source, 'host')
    );
    if (!expectedHost) {
      return false;
    }

    try {
      const parsed = new URL(sourceOrigin);
      return normalizeHost(parsed.host) === expectedHost;
    } catch (_error) {
      return false;
    }
  }

  function isTrustedCsrfRequest(req) {
    const csrfHeader = readHeader(req, 'x-game64x64-csrf').trim();
    if (csrfHeader === '1') {
      return true;
    }

    const source = (readHeader(req, 'origin') || readHeader(req, 'referer')).trim();
    if (!source) {
      return false;
    }

    const expectedHost = normalizeHost(
      readHeader(req, 'x-forwarded-host') || readHeader(req, 'host')
    );
    if (!expectedHost) {
      return false;
    }

    try {
      const parsed = new URL(source);
      return normalizeHost(parsed.host) === expectedHost;
    } catch (_error) {
      return false;
    }
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
    const role = isAdminUser(user) ? 'admin' : 'user';
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
      role,
      isAdmin: role === 'admin',
    };
  }

  function toPublicSession(session) {
    return {
      tokenSuffix: String(session?.token || '').slice(-8) || 'unknown',
      createdAt: new Date(Number(session?.createdAt) || Date.now()).toISOString(),
      lastSeenAt: new Date(Number(session?.lastSeenAt) || Date.now()).toISOString(),
      expiresAt: new Date(Number(session?.expiresAt) || Date.now()).toISOString(),
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
        role: normalizeUserRole(parsed.role),
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
      email: normalizeEmail(doc.email),
      name: normalizeDisplayName(doc.name),
      passwordHash: doc.passwordHash,
      createdAt: doc.createdAt || new Date().toISOString(),
      role: normalizeUserRole(doc.role),
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
      role: normalizeUserRole(user.role),
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

  async function updateUser(user) {
    const next = {
      ...user,
      email: normalizeEmail(user.email),
      name: normalizeDisplayName(user.name),
      role: normalizeUserRole(user.role),
    };

    const mongoUsers = getMongoUsers();
    if (mongoUsers) {
      await mongoUsers.updateOne(
        { id: next.id },
        {
          $set: {
            email: next.email,
            name: next.name,
            passwordHash: next.passwordHash,
            role: next.role,
          },
        }
      );
      return next;
    }

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      const previous = usersById.get(next.id) || null;
      if (previous && previous.email !== next.email) {
        usersByEmail.delete(previous.email);
      }
      usersByEmail.set(next.email, next);
      usersById.set(next.id, next);
      return next;
    }

    await redisDataClient.hSet(config.REDIS_USERS_KEY, next.email, JSON.stringify(next));
    return next;
  }

  async function ensureSeedUser(seed) {
    const existing = await getUserByEmail(seed.email);
    if (!existing) {
      const created = await createUser({
        id: randomId(12),
        email: normalizeEmail(seed.email),
        name: normalizeDisplayName(seed.name),
        passwordHash: hashPassword(seed.password),
        createdAt: new Date().toISOString(),
        role: normalizeUserRole(seed.role),
      });
      if (!created.ok) {
        throw new Error(`Failed to seed auth user for ${seed.email}`);
      }
      return;
    }

    const nextRole = normalizeUserRole(seed.role);
    const nextName = normalizeDisplayName(seed.name);
    const hasExpectedPassword = verifyPassword(seed.password, existing.passwordHash);
    const requiresUpdate =
      existing.name !== nextName || existing.role !== nextRole || !hasExpectedPassword;

    if (!requiresUpdate) {
      return;
    }

    await updateUser({
      ...existing,
      name: nextName,
      passwordHash: hasExpectedPassword ? existing.passwordHash : hashPassword(seed.password),
      role: nextRole,
    });
  }

  function sortSessionsByRecent(a, b) {
    return Number(b?.lastSeenAt || 0) - Number(a?.lastSeenAt || 0);
  }

  async function listActiveSessionsForUser(userId) {
    if (!userId) {
      return [];
    }

    const now = Date.now();
    const mongoSessions = getMongoSessions();
    if (mongoSessions) {
      const docs = await mongoSessions
        .find({ userId, expiresAt: { $gt: now } })
        .sort({ lastSeenAt: -1, expiresAt: -1 })
        .toArray();
      return docs
        .map(mapMongoSession)
        .filter((session) => session && session.expiresAt > now)
        .sort(sortSessionsByRecent);
    }

    const redisDataClient = getRedisDataClient();
    if (!redisDataClient) {
      const matches = [];
      for (const session of sessionsByToken.values()) {
        if (!session) {
          continue;
        }
        if (session.expiresAt <= now) {
          await deleteSession(session.token, session);
          continue;
        }
        if (session.userId === userId) {
          matches.push(session);
        }
      }
      return matches.sort(sortSessionsByRecent);
    }

    const sessionKeys = await redisDataClient.keys(`${config.REDIS_SESSION_PREFIX}*`);
    if (sessionKeys.length === 0) {
      return [];
    }

    const raws = await Promise.all(sessionKeys.map((key) => redisDataClient.get(key)));
    const matches = [];
    for (let index = 0; index < raws.length; index += 1) {
      const raw = raws[index];
      if (!raw) {
        continue;
      }

      const session = parseAuthSession(raw);
      if (!session) {
        await redisDataClient.del(sessionKeys[index]);
        continue;
      }
      if (session.expiresAt <= now) {
        await deleteSession(session.token, session);
        continue;
      }
      if (session.userId === userId) {
        matches.push(session);
      }
    }

    return matches.sort(sortSessionsByRecent);
  }

  async function disconnectSocketsForUser(userId) {
    if (!userId) {
      return 0;
    }

    clearPendingSessionRelease(userId);
    const sockets = await getSockets();
    const ownedSockets = sockets.filter((socket) => socket?.data?.auth?.userId === userId);
    await Promise.all(
      ownedSockets.map(async (socket) => {
        try {
          socket.disconnect(true);
        } catch (_error) {
          // Ignore disconnect failures during admin revocation.
        }
      })
    );
    return ownedSockets.length;
  }

  async function revokeSessionsForUser(userId, options = {}) {
    if (!userId) {
      return { revokedCount: 0, disconnectedSockets: 0 };
    }

    const sessions = await listActiveSessionsForUser(userId);
    for (const session of sessions) {
      await deleteSession(session.token, session);
    }

    const disconnectedSockets =
      options.disconnectSockets === false ? 0 : await disconnectSocketsForUser(userId);

    return {
      revokedCount: sessions.length,
      disconnectedSockets,
    };
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

  function shutdown() {
    for (const timer of pendingSessionReleaseTimers.values()) {
      clearTimeout(timer);
    }
    pendingSessionReleaseTimers.clear();
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
      await ensureSeedUser(seed);
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
    if (req && Object.prototype.hasOwnProperty.call(req, REQUEST_AUTH_CONTEXT_KEY)) {
      return req[REQUEST_AUTH_CONTEXT_KEY];
    }

    const authContext = await getAuthenticatedUserByToken(getAuthTokenFromRequest(req));
    if (req) {
      req[REQUEST_AUTH_CONTEXT_KEY] = authContext;
    }
    return authContext;
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
    isAdminUser,
    isMongoConnected,
    isSeedTestEmail,
    isTrustedCsrfRequest,
    isTrustedOriginRequest,
    isValidEmail,
    listActiveSessionsForUser,
    normalizeDisplayName,
    normalizeEmail,
    randomId,
    refreshSession,
    revokeSessionsForUser,
    scheduleSessionRelease,
    setAuthCookie,
    setRetryAfter,
    shutdown,
    toPublicSession,
    toPublicUser,
    verifyPassword,
  };
}

module.exports = {
  createAuthService,
};
