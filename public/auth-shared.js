(function bootstrapGame64Auth(global) {
  const SESSION_KEY = 'game64x64:session';
  const TAB_ID_KEY = 'game64x64:tab_id';
  // Test credentials must never be shipped to the browser bundle.
  const TEST_USERS_SEED = [];

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
      id: String(user?.id || '').trim() || null,
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

  function clearSeedAccountLocks() {
    // Client-side tab locks were removed. Server-side auth is now the source of truth.
  }

  function ensureOwnedAccountLock(session) {
    return Boolean(session && session.email && session.sessionToken);
  }

  function isLockedByAnotherTab(_email) {
    return false;
  }

  function releaseOwnedAccountLock(_session) {
    // Client-side tab locks were removed. Session cleanup happens on logout or server expiry.
  }

  function setClientSession(user) {
    const session = buildSession(user);
    writeSession(session);
    return session;
  }

  function clearClientSession(_options = {}) {
    removeStoredSession();
  }

  async function callApi(path, options = {}) {
    const payload = Object.prototype.hasOwnProperty.call(options, 'payload')
      ? options.payload
      : undefined;
    const method = options.method || (payload !== undefined ? 'POST' : 'GET');
    const headers = {
      ...(options.headers || {}),
    };
    if (payload !== undefined && !Object.prototype.hasOwnProperty.call(headers, 'Content-Type')) {
      headers['Content-Type'] = 'application/json';
    }
    if (
      method !== 'GET' &&
      method !== 'HEAD' &&
      !Object.prototype.hasOwnProperty.call(headers, 'x-game64x64-csrf')
    ) {
      headers['x-game64x64-csrf'] = '1';
    }
    const response = await fetch(path, {
      method,
      credentials: 'include',
      headers: Object.keys(headers).length > 0 ? headers : undefined,
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
