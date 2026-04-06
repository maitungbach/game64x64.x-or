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
const REFRESH_INTERVAL_MS = 2000;

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
};

function setText(node, value) {
  if (node) {
    const next = String(value ?? '-');
    node.textContent = next;
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
  el.lookupMessage.className = `subtle${type ? ` ${type}` : ''}`;
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

function renderCounters(counters) {
  const entries = Object.entries(counters || {});
  el.counters.innerHTML = '';

  for (const [key, value] of entries) {
    const box = document.createElement('div');
    box.className = 'counter';
    box.innerHTML = `<div class="k">${key}</div><div class="v">${value}</div>`;
    el.counters.appendChild(box);
  }
}

function renderWarnings(warnings) {
  const items = Array.isArray(warnings) ? warnings : [];
  el.healthWarnings.innerHTML = '';

  if (items.length === 0) {
    const item = document.createElement('li');
    item.className = 'warning-item is-ok';
    item.textContent = 'Khong co canh bao cau hinh.';
    el.healthWarnings.appendChild(item);
    return;
  }

  for (const warning of items) {
    const item = document.createElement('li');
    item.className = 'warning-item';
    item.textContent = warning;
    el.healthWarnings.appendChild(item);
  }
}

function renderLookupSessions(activeSessions) {
  const sessions = Array.isArray(activeSessions) ? activeSessions : [];
  el.lookupSessions.innerHTML = '';

  if (sessions.length === 0) {
    const item = document.createElement('li');
    item.className = 'session-item empty';
    item.textContent = 'Chua co session nao.';
    el.lookupSessions.appendChild(item);
    return;
  }

  for (const session of sessions) {
    const item = document.createElement('li');
    item.className = 'session-item';
    item.innerHTML =
      `<strong>token:</strong> ...${session.tokenSuffix}<br />` +
      `<strong>created:</strong> ${formatDate(session.createdAt)}<br />` +
      `<strong>last seen:</strong> ${formatDate(session.lastSeenAt)}<br />` +
      `<strong>expires:</strong> ${formatDate(session.expiresAt)}`;
    el.lookupSessions.appendChild(item);
  }
}

function resetLookupResult() {
  state.lookupUser = null;
  state.lookupEmail = '';
  el.lookupResult.classList.add('is-hidden');
  el.lookupEmpty.hidden = false;
  el.revokeSessions.disabled = true;
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

async function refreshDashboard() {
  if (state.refreshInFlight) {
    return;
  }

  state.refreshInFlight = true;

  try {
    const health = await callApi('/api/health');
    if (!(await ensureAccess(health))) {
      return;
    }

    if (health.ok && health.data) {
      setText(el.healthOk, health.data.ok);
      setText(el.healthPlayers, health.data.players);
      setText(el.healthRedis, health.data.redisEnabled);
      setText(el.healthVersion, health.data.version || '-');
      setText(el.healthNodeId, health.data.nodeId || '-');
      setText(el.healthAuthStorage, health.data.authStorage || '-');
      setText(el.healthMongoConnected, health.data.mongoConnected);
      renderWarnings(health.data.configWarnings);
    }

    const headers = {};
    if (state.token) {
      headers['x-stats-token'] = state.token;
    }

    const stats = await callApi('/api/stats', { headers });
    if (!(await ensureAccess(stats))) {
      return;
    }

    if (stats.ok && stats.data) {
      setText(el.uptime, `${stats.data.uptimeSec}s`);
      setText(el.pid, stats.data.pid);
      setText(el.statsVersion, stats.data.version || '-');
      setText(el.statsNodeId, stats.data.nodeId || '-');
      setText(el.playersOnline, stats.data.playersOnline);
      setText(el.socketsOnline, stats.data.socketsOnline);
      renderCounters(stats.data.counters);
      setText(el.error, '-');
    } else {
      setText(el.error, `Loi thong ke ${stats.status}.`);
    }

    setText(el.lastUpdate, new Date().toLocaleString());
  } catch (_error) {
    setText(el.error, 'Khong the cap nhat dashboard.');
  } finally {
    state.refreshInFlight = false;
  }
}

function scheduleDashboardRefresh(delayMs = REFRESH_INTERVAL_MS) {
  if (state.refreshTimer) {
    window.clearTimeout(state.refreshTimer);
  }

  state.refreshTimer = window.setTimeout(async () => {
    state.refreshTimer = null;
    await refreshDashboard();
    scheduleDashboardRefresh();
  }, delayMs);
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
    setText(el.authStatus, 'Dang dung quyen admin session va gui kem x-stats-token.');
  } else {
    setText(el.authStatus, 'Dang dung quyen admin session cho /api/health va /api/stats.');
  }
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
  setText(el.adminWelcome, `${me.name || me.email} (${me.email})`);
  await refreshDashboard();
  scheduleDashboardRefresh();
}

el.applyToken.addEventListener('click', async () => {
  applyTokenState();
  await refreshDashboard();
});
el.lookupForm.addEventListener('submit', handleLookupSubmit);
el.refreshLookup.addEventListener('click', handleLookupRefresh);
el.revokeSessions.addEventListener('click', handleRevokeSessions);
el.logoutBtn.addEventListener('click', handleLogout);

bootstrap();
