const {
  TEST_USERS_SEED,
  callApi,
  clearClientSession,
  clearSeedAccountLocks,
  isLockedByAnotherTab,
  isSeedTestEmail,
  mapLegacySeedEmail,
  normalizeEmail,
  setClientSession,
} = window.Game64Auth;

const tabLoginEl = document.getElementById('tabLogin');
const tabRegisterEl = document.getElementById('tabRegister');
const loginFormEl = document.getElementById('loginForm');
const registerFormEl = document.getElementById('registerForm');
const authMessageEl = document.getElementById('authMessage');
const seedListEl = document.getElementById('seedList');
const testAccountsEl = document.querySelector('.test-accounts');

const TEXT = Object.freeze({
  authModeLabel: 'Chế độ xác thực',
  authTitle: 'Đăng nhập / Đăng ký - Game 64x64',
  backToGame: 'Vào game',
  bootstrapLoggedIn: "Bạn đã đăng nhập. Nhấn 'Vào game' để tiếp tục.",
  concurrentOnline: 'Tài khoản này đang online ở nơi khác.',
  duplicateEmail: 'Email đã tồn tại hoặc đang online.',
  heading: 'Tài khoản Game 64x64',
  invalidConfirmPassword: 'Mật khẩu nhập lại không khớp.',
  invalidEmail: 'Email không hợp lệ.',
  invalidName: 'Tên hiển thị phải có ít nhất 2 ký tự.',
  invalidPassword: 'Mật khẩu phải có ít nhất 6 ký tự.',
  lockedByTab: 'Tài khoản này đang đăng nhập ở tab khác.',
  loginButton: 'Đăng nhập và vào game',
  loginSuccess: 'Đăng nhập thành công. Đang chuyển về trang game...',
  missingPassword: 'Vui lòng nhập mật khẩu.',
  note: 'Đăng nhập được xử lý bởi máy chủ. Tài khoản thường giới hạn 1 phiên, riêng 5 tài khoản kiểm thử có thể đăng nhập song song.',
  registerButton: 'Tạo tài khoản',
  registerFailed: 'Không tạo được tài khoản.',
  registerRateLimitedPrefix: 'Bạn thao tác quá nhanh. Thử lại sau ',
  registerSuccess: 'Tạo tài khoản thành công. Đang chuyển về trang game...',
  seedHeading: '5 tài khoản kiểm thử',
  serverUnavailable: 'Không kết nối được máy chủ.',
  subtitle: 'Đăng nhập hoặc tạo tài khoản để lưu tên người chơi trên trình duyệt này.',
  wrongCredentials: 'Sai email hoặc mật khẩu.',
});

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getNextPath() {
  const next = new URLSearchParams(window.location.search).get('next') || '/game.html';
  if (!next.startsWith('/')) {
    return '/game.html';
  }
  return next;
}

const nextPath = getNextPath();

function setMessage(text, type) {
  authMessageEl.textContent = text || '';
  authMessageEl.className = 'message';
  if (type) {
    authMessageEl.classList.add(type);
  }
}

function setMode(mode) {
  const loginActive = mode === 'login';
  tabLoginEl.classList.toggle('is-active', loginActive);
  tabRegisterEl.classList.toggle('is-active', !loginActive);
  loginFormEl.classList.toggle('is-hidden', !loginActive);
  registerFormEl.classList.toggle('is-hidden', loginActive);
  setMessage('');
}

function setElementText(element, text) {
  if (element) {
    element.textContent = text;
  }
}

function setText(selector, text) {
  setElementText(document.querySelector(selector), text);
}

function hydrateStaticText() {
  document.title = TEXT.authTitle;

  setText('.back-link', TEXT.backToGame);
  setText('.auth-panel h1', TEXT.heading);
  setText('.subtitle', TEXT.subtitle);
  setText('label[for="loginEmail"]', 'Email');
  setText('label[for="loginPassword"]', 'Mật khẩu');
  setText('label[for="registerName"]', 'Tên hiển thị');
  setText('label[for="registerEmail"]', 'Email');
  setText('label[for="registerPassword"]', 'Mật khẩu');
  setText('label[for="registerConfirm"]', 'Nhập lại mật khẩu');
  setText(
    '.note',
    TEST_USERS_SEED.length > 0
      ? TEXT.note
      : 'Dang nhap duoc xu ly boi may chu. Tai khoan thuong gioi han 1 phien.'
  );
  if (TEST_USERS_SEED.length > 0) {
    setText('.test-accounts h2', TEXT.seedHeading);
  }

  const tabs = document.querySelector('.auth-tabs');
  if (tabs) {
    tabs.setAttribute('aria-label', TEXT.authModeLabel);
  }

  const testAccounts = document.querySelector('.test-accounts');
  if (testAccounts) {
    testAccounts.setAttribute('aria-label', 'Tài khoản mẫu');
  }

  setElementText(tabLoginEl, 'Đăng nhập');
  setElementText(tabRegisterEl, 'Đăng ký');
  setElementText(loginFormEl.querySelector('button[type="submit"]'), TEXT.loginButton);
  setElementText(registerFormEl.querySelector('button[type="submit"]'), TEXT.registerButton);
}

function renderSeedAccounts() {
  if (!seedListEl || !testAccountsEl) {
    return;
  }

  if (TEST_USERS_SEED.length === 0) {
    testAccountsEl.hidden = true;
    return;
  }

  testAccountsEl.hidden = false;
  seedListEl.innerHTML = '';
  for (const seed of TEST_USERS_SEED) {
    const item = document.createElement('li');
    item.textContent = `${seed.email} / ${seed.password} (${seed.name})`;
    seedListEl.appendChild(item);
  }
}

function redirectToGame(delayMs = 300) {
  window.setTimeout(() => {
    window.location.href = nextPath;
  }, delayMs);
}

function formatRetryAfter(retryAfterSec) {
  if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) {
    return 'ít phút nữa';
  }
  if (retryAfterSec < 60) {
    return `${retryAfterSec} giây`;
  }
  return `${Math.ceil(retryAfterSec / 60)} phút`;
}

async function requestAuth(path, payload) {
  try {
    return await callApi(path, { payload });
  } catch {
    setMessage(TEXT.serverUnavailable, 'error');
    return null;
  }
}

function completeAuthentication(user, fallbackUser, successMessage) {
  setClientSession(user || fallbackUser);
  setMessage(successMessage, 'success');
  redirectToGame();
}

async function handleLogin(event) {
  event.preventDefault();

  const formData = new FormData(loginFormEl);
  const email = mapLegacySeedEmail(formData.get('email'));
  const password = String(formData.get('password') || '');

  if (!isValidEmail(email)) {
    setMessage(TEXT.invalidEmail, 'error');
    return;
  }
  if (!password) {
    setMessage(TEXT.missingPassword, 'error');
    return;
  }
  if (isLockedByAnotherTab(email)) {
    setMessage(TEXT.lockedByTab, 'error');
    return;
  }

  let result = await requestAuth('/api/auth/login', { email, password });
  if (!result) {
    return;
  }

  if (!result.ok && result.status === 409 && isSeedTestEmail(email)) {
    result = await requestAuth('/api/auth/login', { email, password, force: true });
    if (!result) {
      return;
    }
  }

  if (!result.ok) {
    if (result.status === 409) {
      setMessage(TEXT.concurrentOnline, 'error');
      return;
    }
    if (result.status === 429) {
      setMessage(`Bạn thử đăng nhập lại sau ${formatRetryAfter(result.retryAfterSec)}.`, 'error');
      return;
    }
    setMessage(TEXT.wrongCredentials, 'error');
    return;
  }

  completeAuthentication(result.data?.user, { email, name: email }, TEXT.loginSuccess);
}

async function handleRegister(event) {
  event.preventDefault();

  const formData = new FormData(registerFormEl);
  const name = String(formData.get('name') || '').trim();
  const email = normalizeEmail(formData.get('email'));
  const password = String(formData.get('password') || '');
  const confirmPassword = String(formData.get('confirmPassword') || '');

  if (name.length < 2) {
    setMessage(TEXT.invalidName, 'error');
    return;
  }
  if (!isValidEmail(email)) {
    setMessage(TEXT.invalidEmail, 'error');
    return;
  }
  if (password.length < 6) {
    setMessage(TEXT.invalidPassword, 'error');
    return;
  }
  if (password !== confirmPassword) {
    setMessage(TEXT.invalidConfirmPassword, 'error');
    return;
  }
  if (isLockedByAnotherTab(email)) {
    setMessage(TEXT.lockedByTab, 'error');
    return;
  }

  const result = await requestAuth('/api/auth/register', { name, email, password });
  if (!result) {
    return;
  }

  if (!result.ok) {
    if (result.status === 409) {
      setMessage(TEXT.duplicateEmail, 'error');
      return;
    }
    if (result.status === 429) {
      setMessage(
        `${TEXT.registerRateLimitedPrefix}${formatRetryAfter(result.retryAfterSec)}.`,
        'error'
      );
      return;
    }
    setMessage(TEXT.registerFailed, 'error');
    return;
  }

  completeAuthentication(result.data?.user, { email, name }, TEXT.registerSuccess);
}

async function bootstrapExistingLogin() {
  let result;
  try {
    result = await callApi('/api/auth/me');
  } catch {
    return;
  }

  if (!result.ok || !result.data?.user) {
    clearClientSession();
    return;
  }

  if (isLockedByAnotherTab(result.data.user.email)) {
    setMessage(TEXT.lockedByTab, 'error');
    return;
  }

  setClientSession(result.data.user);
  setMessage(TEXT.bootstrapLoggedIn, 'success');
}

hydrateStaticText();

tabLoginEl.addEventListener('click', () => setMode('login'));
tabRegisterEl.addEventListener('click', () => setMode('register'));
loginFormEl.addEventListener('submit', handleLogin);
registerFormEl.addEventListener('submit', handleRegister);

renderSeedAccounts();
clearSeedAccountLocks();
setMode('login');
bootstrapExistingLogin();
