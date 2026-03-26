const GRID_SIZE = 64;
const CELL_SIZE = 10;
const CANVAS_SIZE = GRID_SIZE * CELL_SIZE;
const LOCAL_LERP = 0.55;
const REMOTE_LERP = 0.28;
const SNAP_DISTANCE = 4;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const accountNameEl = document.getElementById('accountName');
const authActionEl = document.getElementById('authAction');
const {
  ACTIVE_SESSIONS_KEY,
  clearClientSession,
  clearSeedAccountLocks,
  ensureOwnedAccountLock,
  fetchAuthMe,
  getLoginUrl,
  logoutFromServer,
  normalizeEmail,
  readSession,
  releaseOwnedAccountLock,
} = window.Game64Auth;
const LOCK_HEARTBEAT_MS = 4_000;
const LOGIN_URL = getLoginUrl('/game.html');
const AUTH_RETRY_DELAY_MS = 1200;
const socket = io({
  transports: ['websocket'],
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 600,
  reconnectionDelayMax: 3000,
  timeout: 6000,
});

canvas.width = CANVAS_SIZE;
canvas.height = CANVAS_SIZE;
ctx.imageSmoothingEnabled = false;

let myId = null;
let playersById = new Map();
let pendingInputs = [];
let nextSeq = 1;
let myServerPos = null;
let lockHeartbeatTimer = null;
let redirectingToAuth = false;

const gridLayer = document.createElement('canvas');
gridLayer.width = CANVAS_SIZE;
gridLayer.height = CANVAS_SIZE;
const gridCtx = gridLayer.getContext('2d');
gridCtx.imageSmoothingEnabled = false;

function redirectToAuth() {
  if (redirectingToAuth) {
    return;
  }
  redirectingToAuth = true;
  window.location.replace(LOGIN_URL);
}

function stopLockHeartbeat() {
  if (!lockHeartbeatTimer) {
    return;
  }
  window.clearInterval(lockHeartbeatTimer);
  lockHeartbeatTimer = null;
}

function resetRuntimeState() {
  playersById.clear();
  pendingInputs = [];
  myServerPos = null;
  myId = null;
}

function handleSessionConflict(message, options = {}) {
  const shouldLogoutServer = options.logoutServer === true;
  const shouldReleaseLock = options.releaseLock !== false;

  if (socket.connected || socket.active) {
    socket.disconnect();
  }
  clearClientSession({ releaseLock: shouldReleaseLock });
  if (shouldLogoutServer) {
    logoutFromServer();
  }
  stopLockHeartbeat();
  resetRuntimeState();
  statusEl.textContent = message || 'Phiên đăng nhập không hợp lệ. Đang chuyển hướng...';
  renderAccountBar();
  window.setTimeout(redirectToAuth, 150);
}

function startLockHeartbeat() {
  stopLockHeartbeat();
  lockHeartbeatTimer = window.setInterval(() => {
    const session = readSession();
    if (!session) {
      handleSessionConflict('Phiên đăng nhập đã bị hủy.', {
        logoutServer: false,
        releaseLock: false,
      });
      return;
    }

    if (!ensureOwnedAccountLock(session)) {
      handleSessionConflict('Tài khoản đang được sử dụng ở tab khác.', {
        logoutServer: false,
      });
    }
  }, LOCK_HEARTBEAT_MS);
}

function renderAccountBar() {
  if (!accountNameEl || !authActionEl) {
    return;
  }

  const session = readSession();
  if (!session) {
    accountNameEl.textContent = 'Chưa đăng nhập';
    authActionEl.textContent = 'Đăng nhập / Đăng ký';
    authActionEl.href = LOGIN_URL;
    authActionEl.onclick = null;
    return;
  }

  accountNameEl.textContent = `Xin chào, ${session.name || session.email}`;
  authActionEl.textContent = 'Đăng xuất';
  authActionEl.href = '#';
  authActionEl.onclick = async (event) => {
    event.preventDefault();
    clearClientSession();
    await logoutFromServer();
    if (socket.connected) {
      socket.disconnect();
    }
    stopLockHeartbeat();
    resetRuntimeState();
    statusEl.textContent = 'Đã đăng xuất. Đang chuyển đến trang đăng nhập...';
    renderAccountBar();
    redirectToAuth();
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeCoord(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return clamp(num, 0, GRID_SIZE - 1);
}

function drawGridLayer() {
  gridCtx.strokeStyle = '#dbe3f0';
  gridCtx.lineWidth = 1;

  for (let i = 0; i <= GRID_SIZE; i += 1) {
    const p = i * CELL_SIZE;

    gridCtx.beginPath();
    gridCtx.moveTo(p, 0);
    gridCtx.lineTo(p, CANVAS_SIZE);
    gridCtx.stroke();

    gridCtx.beginPath();
    gridCtx.moveTo(0, p);
    gridCtx.lineTo(CANVAS_SIZE, p);
    gridCtx.stroke();
  }
}

function getNextPosition(position, direction) {
  let nextX = position.x;
  let nextY = position.y;

  if (direction === 'up') {
    nextY = clamp(position.y - 1, 0, GRID_SIZE - 1);
  } else if (direction === 'down') {
    nextY = clamp(position.y + 1, 0, GRID_SIZE - 1);
  } else if (direction === 'left') {
    nextX = clamp(position.x - 1, 0, GRID_SIZE - 1);
  } else if (direction === 'right') {
    nextX = clamp(position.x + 1, 0, GRID_SIZE - 1);
  }

  return { x: nextX, y: nextY };
}

function createPlayerState(player) {
  const x = normalizeCoord(player.x);
  const y = normalizeCoord(player.y);
  return {
    id: player.id,
    color: typeof player.color === 'string' ? player.color : '#999999',
    serverX: x,
    serverY: y,
    targetX: x,
    targetY: y,
    renderX: x,
    renderY: y,
  };
}

function ensurePlayerState(player) {
  const existing = playersById.get(player.id);
  if (existing) {
    if (typeof player.color === 'string') {
      existing.color = player.color;
    }
    return existing;
  }

  const created = createPlayerState(player);
  playersById.set(created.id, created);
  return created;
}

function dropAckedInputs(seq) {
  if (!Number.isInteger(seq)) {
    return;
  }
  pendingInputs = pendingInputs.filter((entry) => entry.seq > seq);
}

function reconcileLocalPrediction() {
  if (!myId || !myServerPos) {
    return;
  }

  const me = playersById.get(myId);
  if (!me) {
    return;
  }

  let predicted = { x: myServerPos.x, y: myServerPos.y };
  for (const input of pendingInputs) {
    predicted = getNextPosition(predicted, input.direction);
  }

  me.serverX = myServerPos.x;
  me.serverY = myServerPos.y;
  me.targetX = predicted.x;
  me.targetY = predicted.y;
}

function applySnapshot(nextPlayers) {
  if (!Array.isArray(nextPlayers)) {
    return;
  }

  const seen = new Set();

  for (const rawPlayer of nextPlayers) {
    if (!rawPlayer || typeof rawPlayer.id !== 'string') {
      continue;
    }

    const player = {
      id: rawPlayer.id,
      x: normalizeCoord(rawPlayer.x),
      y: normalizeCoord(rawPlayer.y),
      color: typeof rawPlayer.color === 'string' ? rawPlayer.color : '#999999',
    };
    const state = ensurePlayerState(player);
    state.color = player.color;
    state.serverX = player.x;
    state.serverY = player.y;
    seen.add(player.id);

    if (player.id === myId) {
      myServerPos = { x: player.x, y: player.y };
      reconcileLocalPrediction();
    } else {
      state.targetX = player.x;
      state.targetY = player.y;
      if (
        Math.abs(state.renderX - player.x) > SNAP_DISTANCE ||
        Math.abs(state.renderY - player.y) > SNAP_DISTANCE
      ) {
        state.renderX = player.x;
        state.renderY = player.y;
      }
    }
  }

  for (const id of Array.from(playersById.keys())) {
    if (!seen.has(id)) {
      playersById.delete(id);
    }
  }
}

function applyMoveEvent(payload) {
  if (!payload || typeof payload.id !== 'string') {
    return;
  }

  const x = normalizeCoord(payload.x);
  const y = normalizeCoord(payload.y);
  const existing = playersById.get(payload.id);
  const state = ensurePlayerState({
    id: payload.id,
    x,
    y,
    color: typeof payload.color === 'string' ? payload.color : existing?.color || '#999999',
  });
  if (typeof payload.color === 'string') {
    state.color = payload.color;
  }
  state.serverX = x;
  state.serverY = y;

  if (payload.id === myId) {
    myServerPos = { x, y };
    if (Number.isInteger(payload.seq)) {
      dropAckedInputs(payload.seq);
    }
    reconcileLocalPrediction();
    return;
  }

  state.targetX = x;
  state.targetY = y;
}

function applyJoinEvent(payload) {
  if (!payload || typeof payload.id !== 'string') {
    return;
  }

  const x = normalizeCoord(payload.x);
  const y = normalizeCoord(payload.y);
  ensurePlayerState({
    id: payload.id,
    x,
    y,
    color: typeof payload.color === 'string' ? payload.color : '#999999',
  });
}

function applyLeftEvent(payload) {
  if (!payload || typeof payload.id !== 'string') {
    return;
  }
  playersById.delete(payload.id);
}

function queueMove(direction) {
  if (!myId) {
    return;
  }

  const me = playersById.get(myId);
  if (!me) {
    return;
  }

  const seq = nextSeq;
  nextSeq += 1;

  pendingInputs.push({ seq, direction });
  const predicted = getNextPosition({ x: me.targetX, y: me.targetY }, direction);
  me.targetX = predicted.x;
  me.targetY = predicted.y;
  me.renderX = predicted.x;
  me.renderY = predicted.y;

  socket.emit('move', { direction, seq });
}

function drawPlayersFrame() {
  for (const player of playersById.values()) {
    const lerp = player.id === myId ? LOCAL_LERP : REMOTE_LERP;
    player.renderX += (player.targetX - player.renderX) * lerp;
    player.renderY += (player.targetY - player.renderY) * lerp;

    if (Math.abs(player.targetX - player.renderX) < 0.001) {
      player.renderX = player.targetX;
    }
    if (Math.abs(player.targetY - player.renderY) < 0.001) {
      player.renderY = player.targetY;
    }

    ctx.fillStyle = player.color;
    ctx.fillRect(player.renderX * CELL_SIZE, player.renderY * CELL_SIZE, CELL_SIZE, CELL_SIZE);

    if (player.id === myId) {
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 1;
      ctx.strokeRect(player.renderX * CELL_SIZE, player.renderY * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }
  }
}

function updateStatusText() {
  if (!readSession()) {
    statusEl.textContent = 'Bạn cần đăng nhập để chơi.';
    return;
  }

  const me = myId ? playersById.get(myId) : null;
  const total = playersById.size;
  if (me) {
    statusEl.textContent = `Bạn: (${Math.round(me.targetX)}, ${Math.round(me.targetY)}) | Màu: ${me.color} | Trực tuyến: ${total} | Chờ xử lý: ${pendingInputs.length}`;
    return;
  }

  statusEl.textContent = `Đang kết nối... | Trực tuyến: ${total}`;
}

function renderFrame() {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.drawImage(gridLayer, 0, 0);
  drawPlayersFrame();
  updateStatusText();
  window.requestAnimationFrame(renderFrame);
}

function keyToDirection(key) {
  if (key === 'ArrowUp' || key === 'w') {
    return 'up';
  }
  if (key === 'ArrowDown' || key === 's') {
    return 'down';
  }
  if (key === 'ArrowLeft' || key === 'a') {
    return 'left';
  }
  if (key === 'ArrowRight' || key === 'd') {
    return 'right';
  }
  return null;
}

window.addEventListener('keydown', (event) => {
  if (!readSession()) {
    redirectToAuth();
    return;
  }

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const direction = keyToDirection(key);

  if (!direction) {
    return;
  }

  event.preventDefault();
  queueMove(direction);
});

window.addEventListener('storage', (event) => {
  if (event.key !== ACTIVE_SESSIONS_KEY) {
    return;
  }

  const session = readSession();
  if (!session) {
    handleSessionConflict('Phiên đăng nhập đã bị thay đổi.', {
      logoutServer: false,
      releaseLock: false,
    });
    return;
  }

  if (!ensureOwnedAccountLock(session)) {
    handleSessionConflict('Tài khoản đang được sử dụng ở tab khác.', {
      logoutServer: false,
    });
  }
});

window.addEventListener('beforeunload', () => {
  const session = readSession();
  releaseOwnedAccountLock(session);
  if (socket.connected || socket.active) {
    socket.disconnect();
  }
});

socket.on('connect', () => {
  myId = socket.id;
  pendingInputs = [];
  nextSeq = 1;
  myServerPos = null;
});

socket.on('disconnect', () => {
  pendingInputs = [];
  myServerPos = null;
});

socket.on('moveAck', (ack) => {
  if (!ack || typeof ack !== 'object') {
    return;
  }

  if (Number.isInteger(ack.seq)) {
    dropAckedInputs(ack.seq);
  }

  if (Number.isFinite(Number(ack.x)) && Number.isFinite(Number(ack.y))) {
    myServerPos = {
      x: normalizeCoord(ack.x),
      y: normalizeCoord(ack.y),
    };
  }

  reconcileLocalPrediction();
});

socket.on('updatePlayers', applySnapshot);
socket.on('playerMoved', applyMoveEvent);
socket.on('playerJoined', applyJoinEvent);
socket.on('playerLeft', applyLeftEvent);
socket.on('connect_error', (error) => {
  if (String(error?.message || '').toLowerCase() === 'unauthorized') {
    handleSessionConflict('Phiên đăng nhập không hợp lệ.', {
      logoutServer: false,
    });
    return;
  }
  statusEl.textContent = 'Kết nối tạm thời gián đoạn. Hệ thống đang tự kết nối lại...';
});

async function bootstrapAuthAndConnect() {
  const initialSession = readSession();
  if (!initialSession) {
    statusEl.textContent = 'Bạn cần đăng nhập để vào game. Đang chuyển hướng...';
    window.setTimeout(redirectToAuth, 150);
    return;
  }

  if (!ensureOwnedAccountLock(initialSession)) {
    statusEl.textContent = 'Tài khoản đang được sử dụng ở tab khác.';
    window.setTimeout(redirectToAuth, 300);
    return;
  }

  try {
    const me = await fetchAuthMe();
    if (!me || normalizeEmail(me.email) !== normalizeEmail(initialSession.email)) {
      handleSessionConflict('Phiên đăng nhập đã hết hạn hoặc bị thay đổi.');
      return;
    }
  } catch {
    statusEl.textContent = 'Không thể xác thực tài khoản. Đang thử lại...';
    window.setTimeout(() => {
      if (!redirectingToAuth) {
        bootstrapAuthAndConnect();
      }
    }, AUTH_RETRY_DELAY_MS);
    return;
  }

  startLockHeartbeat();
  socket.connect();
}

drawGridLayer();
renderAccountBar();
clearSeedAccountLocks();
renderFrame();
bootstrapAuthAndConnect();
