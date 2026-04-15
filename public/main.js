const GRID_SIZE = 64;
const CELL_SIZE = 10;
const CANVAS_SIZE = GRID_SIZE * CELL_SIZE;
const LOCAL_LERP = 0.55;
const REMOTE_LERP = 0.28;
const SNAP_DISTANCE = 4;
const FRAME_MS_60HZ = 1000 / 60;
const MOVE_REPEAT_INITIAL_MS = 90;
const MOVE_REPEAT_MS = 45;

let currentRoomId = null;
let isRoomHost = false;
let roomGameEndsAt = null;
let currentLeaderboard = [];
let roomPhase = 'idle';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const accountNameEl = document.getElementById('accountName');
const authActionEl = document.getElementById('authAction');
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
let redirectingToAuth = false;
let heldDirections = new Map();
let heldDirectionOrder = 0;
let moveRepeatTimer = null;
let nextMoveRepeatAt = 0;
let lastFrameAt = 0;

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

function resetRuntimeState() {
  playersById.clear();
  pendingInputs = [];
  myServerPos = null;
  myId = null;
  heldDirections.clear();
  heldDirectionOrder = 0;
  nextMoveRepeatAt = 0;
  lastFrameAt = 0;
  if (moveRepeatTimer !== null) {
    window.clearTimeout(moveRepeatTimer);
    moveRepeatTimer = null;
  }
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
  resetRuntimeState();
  statusEl.textContent = message || 'Phiên đăng nhập không hợp lệ. Đang chuyển hướng...';
  renderAccountBar();
  window.setTimeout(redirectToAuth, 150);
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
  if (!myId || !socket.connected) {
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

  socket.emit('move', { direction, seq });
}

function getFrameLerp(baseLerp, deltaMs) {
  const frameScale = Math.max(deltaMs / FRAME_MS_60HZ, 0);
  return 1 - Math.pow(1 - baseLerp, frameScale);
}

function drawPlayersFrame(deltaMs) {
  for (const player of playersById.values()) {
    const baseLerp = player.id === myId ? LOCAL_LERP : REMOTE_LERP;
    const lerp = getFrameLerp(baseLerp, deltaMs);
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
    statusEl.textContent = `Ban: (${Math.round(me.targetX)}, ${Math.round(me.targetY)}) | Mau: ${me.color} | Truc tuyen: ${total} | Cho xu ly: ${pendingInputs.length}`;
    return;
  }

  statusEl.textContent = `Đang kết nối... | Trực tuyến: ${total}`;
}

function renderFrame() {
  const now = window.performance.now();
  const deltaMs = lastFrameAt > 0 ? Math.min(now - lastFrameAt, 100) : FRAME_MS_60HZ;
  lastFrameAt = now;

  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.drawImage(gridLayer, 0, 0);
  drawPlayersFrame(deltaMs);
  updateStatusText();
  renderRoomTimer();
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

function getHeldDirection() {
  let nextDirection = null;
  let latestOrder = -1;

  for (const [direction, order] of heldDirections.entries()) {
    if (order > latestOrder) {
      latestOrder = order;
      nextDirection = direction;
    }
  }

  return nextDirection;
}

function stopMoveRepeatLoop() {
  nextMoveRepeatAt = 0;
  if (moveRepeatTimer !== null) {
    window.clearTimeout(moveRepeatTimer);
    moveRepeatTimer = null;
  }
}

function scheduleMoveRepeat(delayMs) {
  if (heldDirections.size === 0) {
    stopMoveRepeatLoop();
    return;
  }

  if (moveRepeatTimer !== null) {
    window.clearTimeout(moveRepeatTimer);
  }

  nextMoveRepeatAt = window.performance.now() + delayMs;
  moveRepeatTimer = window.setTimeout(function runMoveRepeat() {
    moveRepeatTimer = null;

    const direction = getHeldDirection();
    if (!direction || document.hidden) {
      stopMoveRepeatLoop();
      return;
    }

    const now = window.performance.now();
    if (now < nextMoveRepeatAt) {
      scheduleMoveRepeat(nextMoveRepeatAt - now);
      return;
    }

    queueMove(direction);
    scheduleMoveRepeat(MOVE_REPEAT_MS);
  }, Math.max(0, delayMs));
}

function clearHeldDirections() {
  heldDirections.clear();
  stopMoveRepeatLoop();
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
  if (event.repeat) {
    return;
  }

  heldDirectionOrder += 1;
  heldDirections.set(direction, heldDirectionOrder);
  queueMove(direction);
  scheduleMoveRepeat(MOVE_REPEAT_INITIAL_MS);
});

window.addEventListener('keyup', (event) => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const direction = keyToDirection(key);
  if (!direction) {
    return;
  }

  heldDirections.delete(direction);
  if (heldDirections.size === 0) {
    stopMoveRepeatLoop();
    return;
  }

  scheduleMoveRepeat(MOVE_REPEAT_MS);
});

window.addEventListener('blur', clearHeldDirections);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearHeldDirections();
  }
});

window.addEventListener('beforeunload', () => {
  clearHeldDirections();
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
  clearHeldDirections();
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

const roomStatusEl = document.getElementById('roomStatus');
const roomTimerEl = document.getElementById('roomTimer');
const leaderboardOverlayEl = document.getElementById('leaderboardOverlay');
const leaderboardListEl = document.getElementById('leaderboardList');
const btnCreateRoom = document.getElementById('btnCreateRoom');
const btnJoinRoom = document.getElementById('btnJoinRoom');
const btnStartGame = document.getElementById('btnStartGame');
const btnLeaveRoom = document.getElementById('btnLeaveRoom');
const inputRoomCode = document.getElementById('inputRoomCode');

function resetRoomState() {
  currentRoomId = null;
  isRoomHost = false;
  roomGameEndsAt = null;
  currentLeaderboard = [];
  roomPhase = 'idle';
  renderLeaderboard();
}

function updateRoomUI() {
  if (!currentRoomId || roomPhase === 'idle') {
    roomStatusEl.textContent = '';
    roomTimerEl.textContent = '';
    btnCreateRoom.hidden = false;
    btnJoinRoom.hidden = false;
    btnStartGame.hidden = true;
    btnLeaveRoom.hidden = true;
    inputRoomCode.hidden = false;
    leaderboardOverlayEl.hidden = true;
    return;
  }
  if (roomPhase === 'playing') {
    roomStatusEl.textContent = `Phòng: ${currentRoomId} | Đang chơi`;
    btnCreateRoom.hidden = true;
    btnJoinRoom.hidden = true;
    btnStartGame.hidden = true;
    btnLeaveRoom.hidden = false;
    inputRoomCode.hidden = true;
    leaderboardOverlayEl.hidden = false;
    return;
  }

  if (roomPhase === 'ended') {
    roomStatusEl.textContent = 'Phong da ket thuc';
    btnCreateRoom.hidden = true;
    btnJoinRoom.hidden = true;
    btnStartGame.hidden = true;
    btnLeaveRoom.hidden = false;
    inputRoomCode.hidden = true;
    leaderboardOverlayEl.hidden = false;
    return;
  }

  {
    roomStatusEl.textContent = `Phòng: ${currentRoomId} | Đang chờ... ${isRoomHost ? '(Host)' : ''}`;
    roomTimerEl.textContent = '';
    btnCreateRoom.hidden = true;
    btnJoinRoom.hidden = true;
    btnStartGame.hidden = !isRoomHost;
    btnLeaveRoom.hidden = false;
    inputRoomCode.hidden = true;
    leaderboardOverlayEl.hidden = true;
  }
}

function formatTimeRemaining() {
  if (!roomGameEndsAt) {
    return '';
  }
  const remaining = Math.max(0, roomGameEndsAt - Date.now());
  if (remaining === 0) {
    return 'Hết giờ!';
  }
  const sec = Math.floor(remaining / 1000);
  const min = Math.floor(sec / 60);
  const secRem = sec % 60;
  return `${min}:${String(secRem).padStart(2, '0')}`;
}

function renderRoomTimer() {
  if (roomPhase === 'ended') {
    roomTimerEl.textContent = 'Thời gian: Hết giờ!';
    return;
  }

  if (roomPhase !== 'playing' || !roomGameEndsAt) {
    roomTimerEl.textContent = '';
    return;
  }
  roomTimerEl.textContent = `Thời gian: ${formatTimeRemaining()}`;
}

function renderLeaderboard() {
  if (!currentLeaderboard.length) {
    leaderboardListEl.innerHTML = '<li>Chưa có điểm</li>';
    return;
  }
  const currentUserId = readSession()?.id || null;
  leaderboardListEl.replaceChildren();
  for (const entry of currentLeaderboard) {
    const li = document.createElement('li');
    li.textContent = `#${entry.rank} - Điểm: ${entry.score}`;
    if (currentUserId && entry.playerId === currentUserId) {
      li.className = 'current-player';
    }
    leaderboardListEl.appendChild(li);
  }
}

async function fetchJson(path, options = {}) {
  const payload =
    typeof options.body === 'string' && options.body
      ? JSON.parse(options.body)
      : options.body;
  const result = await callApi(path, {
    method: options.method,
    headers: options.headers,
    payload,
  });
  return {
    ok: result.ok,
    status: result.status,
    async json() {
      return result.data;
    },
  };
}

function createRoom() {
  fetchJson('/api/rooms', { method: 'POST' })
    .then((res) => res.json())
    .then((data) => {
      if (data.ok && data.room) {
        currentRoomId = data.room.id;
        isRoomHost = true;
        roomPhase = 'waiting';
        currentLeaderboard = [];
        renderLeaderboard();
        socket.emit('joinRoom', { roomId: currentRoomId });
        updateRoomUI();
      } else {
        roomStatusEl.textContent = 'Không thể tạo phòng: ' + (data.message || 'lỗi');
      }
    })
    .catch(() => {
      roomStatusEl.textContent = 'Lỗi kết nối';
    });
}

function joinRoom(roomId) {
  if (!roomId) {
    roomId = inputRoomCode.value.trim().toUpperCase();
  }
  if (!roomId || roomId.length < 2) {
    roomStatusEl.textContent = 'Nhập mã phòng';
    return;
  }
  currentRoomId = roomId;
  isRoomHost = false;
  roomPhase = 'waiting';
  currentLeaderboard = [];
  renderLeaderboard();
  socket.emit('joinRoom', { roomId: currentRoomId });
  updateRoomUI();
}

function startRoomGame() {
  if (!isRoomHost || !currentRoomId) {
    return;
  }
  socket.emit('startRoom', {});
}

function leaveRoom() {
  if (!currentRoomId) {
    return;
  }
  socket.emit('leaveRoom', {});
  resetRoomState();
  updateRoomUI();
}

if (btnCreateRoom) {
  btnCreateRoom.addEventListener('click', createRoom);
}
if (btnJoinRoom) {
  btnJoinRoom.addEventListener('click', () => joinRoom());
}
if (btnStartGame) {
  btnStartGame.addEventListener('click', startRoomGame);
}
if (btnLeaveRoom) {
  btnLeaveRoom.addEventListener('click', leaveRoom);
}

socket.on('roomJoined', (data) => {
  currentRoomId = data.roomId;
  roomPhase = data.room?.status === 'playing' ? 'playing' : 'waiting';
  roomStatusEl.textContent = `Đã vào phòng: ${data.roomId}`;
  updateRoomUI();
});

socket.on('roomStarted', (data) => {
  roomGameEndsAt = data.endsAt;
  roomPhase = 'playing';
  updateRoomUI();
});

socket.on('roomScoreUpdate', (data) => {
  currentLeaderboard = data.leaderboard || [];
  renderLeaderboard();
});

socket.on('roomPlayerJoined', (data) => {
  roomStatusEl.textContent = `Người chơi mới vào phòng (${data.playerCount})`;
});

socket.on('roomPlayerLeft', (_data) => {
  roomStatusEl.textContent = `Người chơi rời phòng`;
});

socket.on('roomEnded', (data) => {
  roomPhase = 'ended';
  roomGameEndsAt = null;
  currentLeaderboard = data.leaderboard || [];
  renderLeaderboard();
  updateRoomUI();
});

socket.on('roomLeft', (_data) => {
  resetRoomState();
  updateRoomUI();
});

socket.on('roomClosed', (_data) => {
  resetRoomState();
  updateRoomUI();
  roomStatusEl.textContent = 'Phòng đã đóng';
});

socket.on('roomError', (data) => {
  resetRoomState();
  updateRoomUI();
  roomStatusEl.textContent = 'Lỗi: ' + (data.message || 'unknown');
});

async function bootstrapAuthAndConnect() {
  let initialSession = readSession();

  try {
    const me = await fetchAuthMe();
    if (!me) {
      statusEl.textContent = 'Bạn cần đăng nhập để vào game. Đang chuyển hướng...';
      window.setTimeout(redirectToAuth, 150);
      return;
    }

    if (!initialSession || normalizeEmail(me.email) !== normalizeEmail(initialSession.email)) {
      initialSession = setClientSession(me);
      renderAccountBar();
    }

    if (!initialSession) {
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

  socket.connect();
}

drawGridLayer();
renderAccountBar();
renderFrame();
bootstrapAuthAndConnect();
