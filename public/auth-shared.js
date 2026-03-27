(function bootstrapGame64Auth(global) {
  const SESSION_KEY = 'game64x64:session';
  const ACTIVE_SESSIONS_KEY = 'game64x64:active_sessions';
  const TAB_ID_KEY = 'game64x64:tab_id';
  const ACTIVE_SESSION_TTL_MS = 15_000;
  const TEST_USERS_SEED = [
    { name: 'Tài khoản kiểm thử 01', email: 'tester01@example.com', password: 'Test123!' },
    { name: 'Tài khoản kiểm thử 02', email: 'tester02@example.com', password: 'Test123!' },
    { name: 'Tài khoản kiểm thử 03', email: 'tester03@example.com', password: 'Test123!' },
    { name: 'Tài khoản kiểm thử 04', email: 'tester04@example.com', password: 'Test123!' },
    { name: 'Tài khoản kiểm thử 05', email: 'tester05@example.com', password: 'Test123!' },
  ];

  function normalizeEmail(value) {
    return String(value || '')
      .trim()
      .toLowerCase();
  }

  const SEED_TEST_EMAILS = new Set(TEST_USERS_SEED.map((seed) => normalizeEmail(seed.email)));

  function isSeedTestEmail(email) {
    return SEED_TEST_EMAILS.has(normalizeEmail(email));
  }

  function mapLegacySeedEmail(email) {
    const match = /^tester(0[1-5])@game\.local$/.exec(normalizeEmail(email));
    if (!match) {
      return normalizeEmail(email);
    }
    return `tester${match[1]}@example.com`;
  }

  function createTabId() {
    return `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  }

  function getTabId() {
    try {
      const current = sessionStorage.getItem(TAB_ID_KEY);
      if (current) {
        return current;
      }
      const created = createTabId();
      sessionStorage.setItem(TAB_ID_KEY, created);
      return created;
    } catch {
      return `fallback_${Math.random().toString(16).slice(2, 10)}`;
    }
  }

  const TAB_ID = getTabId();

  function buildSession(user) {
    return {
      name: String(user?.name || user?.email || '').trim(),
      email: normalizeEmail(user?.email),
      tabId: TAB_ID,
      sessionToken: createTabId(),
      loggedAt: new Date().toISOString(),
    };
  }

  function readSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed.email !== 'string' ||
        typeof parsed.tabId !== 'string' ||
        typeof parsed.sessionToken !== 'string'
      ) {
        return null;
      }

      if (parsed.tabId !== TAB_ID) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  function writeSession(session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  function removeStoredSession() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  function pruneExpiredLocks(locks) {
    const now = Date.now();
    for (const [email, lock] of Object.entries(locks)) {
      if (
        !lock ||
        typeof lock.tabId !== 'string' ||
        typeof lock.sessionToken !== 'string' ||
        !Number.isFinite(Number(lock.updatedAt)) ||
        now - Number(lock.updatedAt) > ACTIVE_SESSION_TTL_MS
      ) {
        delete locks[email];
      }
    }
  }

  function readActiveSessions() {
    try {
      const raw = localStorage.getItem(ACTIVE_SESSIONS_KEY);
      if (!raw) {
        return {};
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }

      pruneExpiredLocks(parsed);
      return parsed;
    } catch {
      return {};
    }
  }

  function writeActiveSessions(locks) {
    localStorage.setItem(ACTIVE_SESSIONS_KEY, JSON.stringify(locks));
  }

  function clearSeedAccountLocks() {
    const locks = readActiveSessions();
    let changed = false;
    for (const email of SEED_TEST_EMAILS) {
      if (locks[email]) {
        delete locks[email];
        changed = true;
      }
    }
    if (changed) {
      writeActiveSessions(locks);
    }
  }

  function ensureOwnedAccountLock(session) {
    if (!session || !session.email || !session.sessionToken) {
      return false;
    }

    const email = normalizeEmail(session.email);
    if (isSeedTestEmail(email)) {
      return true;
    }

    const locks = readActiveSessions();
    const lock = locks[email];
    if (lock && (lock.tabId !== TAB_ID || lock.sessionToken !== session.sessionToken)) {
      return false;
    }

    locks[email] = {
      tabId: TAB_ID,
      sessionToken: session.sessionToken,
      updatedAt: Date.now(),
    };
    writeActiveSessions(locks);
    return true;
  }

  function isLockedByAnotherTab(email) {
    const normalizedEmail = normalizeEmail(email);
    if (isSeedTestEmail(normalizedEmail)) {
      return false;
    }

    const lock = readActiveSessions()[normalizedEmail];
    if (!lock) {
      return false;
    }

    return lock.tabId !== TAB_ID;
  }

  function releaseOwnedAccountLock(session) {
    if (!session || !session.email) {
      return;
    }

    const email = normalizeEmail(session.email);
    if (isSeedTestEmail(email)) {
      return;
    }

    const locks = readActiveSessions();
    const lock = locks[email];
    if (!lock) {
      return;
    }
    if (lock.tabId !== TAB_ID || lock.sessionToken !== session.sessionToken) {
      return;
    }

    delete locks[email];
    writeActiveSessions(locks);
  }

  function setClientSession(user) {
    const existing = readSession();
    if (existing && normalizeEmail(existing.email) !== normalizeEmail(user?.email)) {
      releaseOwnedAccountLock(existing);
    }

    const session = buildSession(user);
    writeSession(session);
    ensureOwnedAccountLock(session);
    return session;
  }

  function clearClientSession(options = {}) {
    const existing = readSession();
    if (options.releaseLock !== false) {
      releaseOwnedAccountLock(existing);
    }
    removeStoredSession();
  }

  async function callApi(path, options = {}) {
    const payload = Object.prototype.hasOwnProperty.call(options, 'payload')
      ? options.payload
      : undefined;
    const method = options.method || (payload !== undefined ? 'POST' : 'GET');
    const response = await fetch(path, {
      method,
      credentials: 'include',
      headers: payload !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    const retryAfterRaw = response.headers.get('Retry-After');
    const retryAfterSec = Number.parseInt(retryAfterRaw || '', 10);

    return {
      ok: response.ok,
      status: response.status,
      data,
      retryAfterSec: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : null,
    };
  }

  async function fetchAuthMe() {
    const result = await callApi('/api/auth/me');
    if (!result.ok) {
      return null;
    }
    return result.data?.user || null;
  }

  async function logoutFromServer() {
    try {
      await callApi('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore network failures during logout.
    }
  }

  function getLoginUrl(nextPath = '/game.html') {
    return `/auth.html?next=${encodeURIComponent(nextPath)}`;
  }

  global.Game64Auth = Object.freeze({
    ACTIVE_SESSIONS_KEY,
    SESSION_KEY,
    TAB_ID,
    TEST_USERS_SEED,
    callApi,
    clearClientSession,
    clearSeedAccountLocks,
    ensureOwnedAccountLock,
    fetchAuthMe,
    getLoginUrl,
    isLockedByAnotherTab,
    isSeedTestEmail,
    logoutFromServer,
    mapLegacySeedEmail,
    normalizeEmail,
    readSession,
    releaseOwnedAccountLock,
    setClientSession,
  });
})(window);
