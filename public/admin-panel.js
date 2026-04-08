const {
  callApi,
  clearClientSession,
  fetchAuthMe,
  getLoginUrl,
  logoutFromServer,
  normalizeEmail,
  readSession,
  setClientSession,
} = window.Game64Auth;

const LOGIN_URL = getLoginUrl('/admin');
const REFRESH_INTERVAL_MS = 5000;
const HIDDEN_REFRESH_INTERVAL_MS = 15000;
const MAX_REFRESH_INTERVAL_MS = 30000;

const el = {
  token: document.getElementById('token'),
  applyToken: document.getElementById('applyToken'),
  logoutBtn: document.getElementById('logoutBtn'),
  adminWelcome: document.getElementById('adminWelcome'),
  authStatus: document.getElementById('authStatus'),
  lookupForm: document.getElementById('lookupForm'),
  lookupEmail: document.getElementById('lookupEmail'),
  refreshLookup: document.getElementById('refreshLookup'),
  lookupMessage: document.getElementById('lookupMessage'),
  lookupEmpty: document.getElementById('lookupEmpty'),
  lookupResult: document.getElementById('lookupResult'),
  lookupName: document.getElementById('lookupName'),
  lookupResultEmail: document.getElementById('lookupResultEmail'),
  lookupUserId: document.getElementById('lookupUserId'),
  lookupRole: document.getElementById('lookupRole'),
  lookupCreatedAt: document.getElementById('lookupCreatedAt'),
  lookupSessionCount: document.getElementById('lookupSessionCount'),
  lookupNodeId: document.getElementById('lookupNodeId'),
  lookupAuthStorage: document.getElementById('lookupAuthStorage'),
  lookupMongoConnected: document.getElementById('lookupMongoConnected'),
  lookupSessions: document.getElementById('lookupSessions'),
  revokeSessions: document.getElementById('revokeSessions'),
  healthOk: document.getElementById('healthOk'),
  healthPlayers: document.getElementById('healthPlayers'),
  healthRedis: document.getElementById('healthRedis'),
  healthVersion: document.getElementById('healthVersion'),
  healthNodeId: document.getElementById('healthNodeId'),
  healthAuthStorage: document.getElementById('healthAuthStorage'),
  healthMongoConnected: document.getElementById('healthMongoConnected'),
  healthWarnings: document.getElementById('healthWarnings'),
  uptime: document.getElementById('uptime'),
  pid: document.getElementById('pid'),
  playersOnline: document.getElementById('playersOnline'),
  socketsOnline: document.getElementById('socketsOnline'),
  statsVersion: document.getElementById('statsVersion'),
  statsNodeId: document.getElementById('statsNodeId'),
  counters: document.getElementById('counters'),
  lastUpdate: document.getElementById('lastUpdate'),
  error: document.getElementById('error'),
};

const state = {
  token: '',
  currentAdmin: null,
  lookupUser: null,
  lookupEmail: '',
  refreshInFlight: false,
  refreshTimer: null,
  refreshDelayMs: REFRESH_INTERVAL_MS,
  signatures: {
    counters: '',
    warnings: '',
    lookupSessions: '',
  },
};

function setText(node, value) {
  if (!node) {
    return;
  }

  const next = String(value ?? '-');
  if (node.textContent !== next) {
    node.textContent = next;
  }
  if (node.title !== next) {
    node.title = next;
  }
}

function redirectToLogin() {
  window.location.replace(LOGIN_URL);
}

function redirectToGame() {
  window.location.replace('/game.html');
}

function setLookupMessage(text, type = '') {
  setText(el.lookupMessage, text);
  const nextClassName = `subtle${type ? ` ${type}` : ''}`;
  if (el.lookupMessage.className !== nextClassName) {
    el.lookupMessage.className = nextClassName;
  }
}

function formatDate(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function createCounterNode(key, value) {
  const box = document.createElement('div');
  box.className = 'counter';

  const keyNode = document.createElement('div');
  keyNode.className = 'k';
  keyNode.textContent = key;

  const valueNode = document.createElement('div');
  valueNode.className = 'v';
  valueNode.textContent = String(value);

  box.append(keyNode, valueNode);
  return box;
}

function createSessionLabel(label, value, addBreak = true) {
  const fragment = document.createDocumentFragment();
  const strong = document.createElement('strong');
  strong.textContent = `${label}:`;
  fragment.append(strong, ` ${value}`);
  if (addBreak) {
    fragment.append(document.createElement('br'));
  }
  return fragment;
}

function renderCounters(counters) {
  const entries = Object.entries(counters || {});
  const signature = JSON.stringify(entries);
  if (signature === state.signatures.counters) {
    return;
  }

  state.signatures.counters = signature;
  const fragment = document.createDocumentFragment();
  for (const [key, value] of entries) {
    fragment.appendChild(createCounterNode(key, value));
  }
  el.counters.replaceChildren(fragment);
}

function renderWarnings(warnings) {
  const items = Array.isArray(warnings) ? warnings : [];
  const signature = JSON.stringify(items);
  if (signature === state.signatures.warnings) {
    return;
  }

  state.signatures.warnings = signature;
  const fragment = document.createDocumentFragment();

  if (items.length === 0) {
    const item = document.createElement('li');
    item.className = 'warning-item is-ok';
    item.textContent = 'Khong co canh bao cau hinh.';
    fragment.appendChild(item);
    el.healthWarnings.replaceChildren(fragment);
    return;
  }

  for (const warning of items) {
    const item = document.createElement('li');
    item.className = 'warning-item';
    item.textContent = warning;
    fragment.appendChild(item);
  }

  el.healthWarnings.replaceChildren(fragment);
}

function renderLookupSessions(activeSessions) {
  const sessions = Array.isArray(activeSessions) ? activeSessions : [];
  const signature = JSON.stringify(
    sessions.map((session) => [
      session?.tokenSuffix || '',
      session?.createdAt || '',
      session?.lastSeenAt || '',
      session?.expiresAt || '',
    ])
  );
  if (signature === state.signatures.lookupSessions) {
    return;
  }

  state.signatures.lookupSessions = signature;
  const fragment = document.createDocumentFragment();

  if (sessions.length === 0) {
    const item = document.createElement('li');
    item.className = 'session-item empty';
    item.textContent = 'Chua co session nao.';
    fragment.appendChild(item);
    el.lookupSessions.replaceChildren(fragment);
    return;
  }

  for (const session of sessions) {
    const item = document.createElement('li');
    item.className = 'session-item';
    item.append(
      createSessionLabel('token', `...${session.tokenSuffix}`),
      createSessionLabel('created', formatDate(session.createdAt)),
      createSessionLabel('last seen', formatDate(session.lastSeenAt)),
      createSessionLabel('expires', formatDate(session.expiresAt), false)
    );
    fragment.appendChild(item);
  }

  el.lookupSessions.replaceChildren(fragment);
}

function resetLookupResult() {
  state.lookupUser = null;
  state.lookupEmail = '';
  state.signatures.lookupSessions = '';
  el.lookupResult.classList.add('is-hidden');
  el.lookupEmpty.hidden = false;
  el.revokeSessions.disabled = true;
  renderLookupSessions([]);
}

function renderLookupResult(payload) {
  if (!payload?.found || !payload.user) {
    resetLookupResult();
    setLookupMessage(`Khong tim thay tai khoan ${payload?.lookupEmail || ''}.`, 'error');
    return;
  }

  state.lookupUser = payload.user;
  state.lookupEmail = payload.lookupEmail || payload.user.email;
  el.lookupResult.classList.remove('is-hidden');
  el.lookupEmpty.hidden = true;
  el.revokeSessions.disabled = false;

  setText(el.lookupName, payload.user.name || '-');
  setText(el.lookupResultEmail, payload.user.email || '-');
  setText(el.lookupUserId, payload.user.id || '-');
  setText(el.lookupRole, payload.user.role || 'user');
  setText(el.lookupCreatedAt, formatDate(payload.user.createdAt));
  setText(el.lookupSessionCount, payload.sessionSummary?.count || 0);
  setText(el.lookupNodeId, payload.nodeId || '-');
  setText(el.lookupAuthStorage, payload.authStorage || '-');
  setText(el.lookupMongoConnected, payload.mongoConnected);
  renderLookupSessions(payload.activeSessions);
  setLookupMessage(`Da tai thong tin ${payload.user.email}.`);
}

async function ensureAccess(result) {
  if (!result || result.ok) {
    return true;
  }

  if (result.status === 401) {
    clearClientSession();
    redirectToLogin();
    return false;
  }

  if (result.status === 403) {
    clearClientSession();
    setText(el.error, 'Tai khoan hien tai khong co quyen admin.');
    setText(el.adminWelcome, 'Khong du quyen truy cap trang quan tri.');
    window.setTimeout(redirectToGame, 700);
    return false;
  }

  return true;
}

function renderHealth(health) {
  setText(el.healthOk, health?.ok);
  setText(el.healthPlayers, health?.players);
  setText(el.healthRedis, health?.redisEnabled);
  setText(el.healthVersion, health?.version || '-');
  setText(el.healthNodeId, health?.nodeId || '-');
  setText(el.healthAuthStorage, health?.authStorage || '-');
  setText(el.healthMongoConnected, health?.mongoConnected);
  renderWarnings(health?.configWarnings);
}

function renderStats(stats) {
  const uptimeSec = Number.isFinite(stats?.uptimeSec) ? `${stats.uptimeSec}s` : '-';
  setText(el.uptime, uptimeSec);
  setText(el.pid, stats?.pid);
  setText(el.statsVersion, stats?.version || '-');
  setText(el.statsNodeId, stats?.nodeId || '-');
  setText(el.playersOnline, stats?.playersOnline);
  setText(el.socketsOnline, stats?.socketsOnline);
  renderCounters(stats?.counters);
}

function getScheduledRefreshDelay(preferredDelayMs = null) {
  if (document.hidden) {
    return HIDDEN_REFRESH_INTERVAL_MS;
  }
  if (typeof preferredDelayMs === 'number') {
    return Math.max(0, preferredDelayMs);
  }
  return state.refreshDelayMs;
}

async function refreshDashboard() {
  if (state.refreshInFlight) {
    return false;
  }

  state.refreshInFlight = true;

  try {
    const dashboard = await callApi('/api/admin/dashboard');
    if (!(await ensureAccess(dashboard))) {
      return false;
    }

    if (!dashboard.ok || !dashboard.data?.health || !dashboard.data?.stats) {
      setText(el.error, `Loi dashboard ${dashboard.status}.`);
      state.refreshDelayMs = Math.min(state.refreshDelayMs * 2, MAX_REFRESH_INTERVAL_MS);
      return false;
    }

    renderHealth(dashboard.data.health);
    renderStats(dashboard.data.stats);
    setText(el.error, '-');
    setText(el.lastUpdate, new Date().toLocaleString());
    state.refreshDelayMs = REFRESH_INTERVAL_MS;
    return true;
  } catch (_error) {
    setText(el.error, 'Khong the cap nhat dashboard.');
    state.refreshDelayMs = Math.min(state.refreshDelayMs * 2, MAX_REFRESH_INTERVAL_MS);
    return false;
  } finally {
    state.refreshInFlight = false;
  }
}

function scheduleDashboardRefresh(delayMs = null) {
  if (state.refreshTimer) {
    window.clearTimeout(state.refreshTimer);
  }

  const nextDelayMs = getScheduledRefreshDelay(delayMs);
  state.refreshTimer = window.setTimeout(async () => {
    state.refreshTimer = null;
    await refreshDashboard();
    scheduleDashboardRefresh();
  }, nextDelayMs);
}

async function lookupUser(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    setLookupMessage('Hay nhap email hop le de tra cuu.', 'error');
    return;
  }

  const result = await callApi(`/api/admin/user-by-email?email=${encodeURIComponent(normalized)}`);
  if (!(await ensureAccess(result))) {
    return;
  }
  if (!result.ok) {
    setLookupMessage(`Tra cuu that bai (${result.status}).`, 'error');
    return;
  }

  renderLookupResult(result.data);
}

async function handleLookupSubmit(event) {
  event.preventDefault();
  await lookupUser(el.lookupEmail.value);
}

async function handleLookupRefresh() {
  if (!state.lookupEmail) {
    setLookupMessage('Chua co nguoi dung nao de tai lai.', 'error');
    return;
  }
  await lookupUser(state.lookupEmail);
}

async function handleRevokeSessions() {
  if (!state.lookupUser?.id) {
    return;
  }

  el.revokeSessions.disabled = true;
  const result = await callApi('/api/admin/user/revoke-sessions', {
    payload: { userId: state.lookupUser.id },
  });

  if (!(await ensureAccess(result))) {
    return;
  }

  if (!result.ok) {
    el.revokeSessions.disabled = false;
    setLookupMessage(`Thu hoi session that bai (${result.status}).`, 'error');
    return;
  }

  setLookupMessage(
    `Da thu hoi ${result.data?.revokedCount || 0} session va ngat ${result.data?.disconnectedSockets || 0} socket.`,
    'success'
  );

  if (result.data?.revokedSelf) {
    clearClientSession();
    await logoutFromServer();
    redirectToLogin();
    return;
  }

  await lookupUser(state.lookupEmail);
}

function applyTokenState() {
  state.token = el.token.value.trim();
  if (state.token) {
    setText(el.authStatus, 'Dashboard dang dung snapshot admin. Dang kiem tra STATS_TOKEN cho /api/stats.');
  } else {
    setText(el.authStatus, 'Dashboard dang dung snapshot admin gom health va stats trong mot request.');
  }
}

async function verifyStatsToken() {
  if (!state.token) {
    return;
  }

  const result = await callApi('/api/stats', {
    headers: {
      'x-stats-token': state.token,
    },
  });
  if (!(await ensureAccess(result))) {
    return;
  }

  if (result.ok) {
    setText(el.authStatus, 'Dashboard dang dung snapshot admin. STATS_TOKEN hop le cho /api/stats.');
    return;
  }

  setText(el.authStatus, `Dashboard dang dung snapshot admin. STATS_TOKEN tra ve ${result.status}.`);
}

async function handleLogout() {
  clearClientSession();
  await logoutFromServer();
  redirectToLogin();
}

async function bootstrap() {
  const currentSession = readSession();
  const me = await fetchAuthMe();
  if (!me) {
    clearClientSession();
    redirectToLogin();
    return;
  }
  if (!currentSession || normalizeEmail(currentSession.email) !== normalizeEmail(me.email)) {
    setClientSession(me);
  }
  if (!me.isAdmin) {
    clearClientSession();
    setText(el.adminWelcome, 'Tai khoan hien tai khong co quyen admin.');
    window.setTimeout(redirectToGame, 700);
    return;
  }

  state.currentAdmin = me;
  applyTokenState();
  setText(el.adminWelcome, `${me.name || me.email} (${me.email})`);
  await refreshDashboard();
  scheduleDashboardRefresh();
}

el.applyToken.addEventListener('click', async () => {
  applyTokenState();
  await verifyStatsToken();
  await refreshDashboard();
  scheduleDashboardRefresh();
});
el.lookupForm.addEventListener('submit', handleLookupSubmit);
el.refreshLookup.addEventListener('click', handleLookupRefresh);
el.revokeSessions.addEventListener('click', handleRevokeSessions);
el.logoutBtn.addEventListener('click', handleLogout);
document.addEventListener('visibilitychange', () => {
  scheduleDashboardRefresh(document.hidden ? HIDDEN_REFRESH_INTERVAL_MS : 0);
});

bootstrap();
