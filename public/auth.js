const {
  callApi,
  normalizeEmail,
  setClientSession,
  clearClientSession,
  isSeedTestEmail,
  mapLegacySeedEmail,
} = window.Game64Auth;
/* eslint-disable-next-line no-unused-vars */
const TEST_USERS_SEED = [
  { name: 'Tài khoản kiểm thử 01', email: 'tester01@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 02', email: 'tester02@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 03', email: 'tester03@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 04', email: 'tester04@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 05', email: 'tester05@example.com', password: 'Test123!' },
];
const tabLoginEl = document.getElementById('tabLogin');
const tabRegisterEl = document.getElementById('tabRegister');
const loginFormEl = document.getElementById('loginForm');
const registerFormEl = document.getElementById('registerForm');
const authMessageEl = document.getElementById('authMessage');
const seedListEl = document.getElementById('seedList');

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

const DISPLAY_TEST_USERS_SEED = [
  { name: 'Tài khoản kiểm thử 01', email: 'tester01@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 02', email: 'tester02@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 03', email: 'tester03@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 04', email: 'tester04@example.com', password: 'Test123!' },
  { name: 'Tài khoản kiểm thử 05', email: 'tester05@example.com', password: 'Test123!' },
];

function redirectToGame(delayMs = 300) {
  window.setTimeout(() => {
    window.location.href = nextPath;
  }, delayMs);
}

function hydrateStaticText() {
  document.title = 'Đăng nhập / Đăng ký - Game 64x64';

  const backLink = document.querySelector('.back-link');
  if (backLink) {
    backLink.textContent = 'Vào game';
  }

  const heading = document.querySelector('.auth-panel h1');
  if (heading) {
    heading.textContent = 'Tài khoản Game 64x64';
  }

  const subtitle = document.querySelector('.subtitle');
  if (subtitle) {
    subtitle.textContent =
      'Đăng nhập hoặc tạo tài khoản để lưu tên người chơi trên trình duyệt này.';
  }

  const tabs = document.querySelector('.auth-tabs');
  if (tabs) {
    tabs.setAttribute('aria-label', 'Chế độ xác thực');
  }

  tabLoginEl.textContent = 'Đăng nhập';
  tabRegisterEl.textContent = 'Đăng ký';

  const loginEmailLabel = document.querySelector('label[for="loginEmail"]');
  if (loginEmailLabel) {
    loginEmailLabel.textContent = 'Email';
  }

  const loginPasswordLabel = document.querySelector('label[for="loginPassword"]');
  if (loginPasswordLabel) {
    loginPasswordLabel.textContent = 'Mật khẩu';
  }

  const loginSubmit = loginFormEl.querySelector('button[type="submit"]');
  if (loginSubmit) {
    loginSubmit.textContent = 'Đăng nhập và vào game';
  }

  const registerNameLabel = document.querySelector('label[for="registerName"]');
  if (registerNameLabel) {
    registerNameLabel.textContent = 'Tên hiển thị';
  }

  const registerEmailLabel = document.querySelector('label[for="registerEmail"]');
  if (registerEmailLabel) {
    registerEmailLabel.textContent = 'Email';
  }

  const registerPasswordLabel = document.querySelector('label[for="registerPassword"]');
  if (registerPasswordLabel) {
    registerPasswordLabel.textContent = 'Mật khẩu';
  }

  const registerConfirmLabel = document.querySelector('label[for="registerConfirm"]');
  if (registerConfirmLabel) {
    registerConfirmLabel.textContent = 'Nhập lại mật khẩu';
  }

  const registerSubmit = registerFormEl.querySelector('button[type="submit"]');
  if (registerSubmit) {
    registerSubmit.textContent = 'Tạo tài khoản';
  }

  const note = document.querySelector('.note');
  if (note) {
    note.textContent =
      'Đăng nhập được xử lý bởi máy chủ. Tài khoản thường giới hạn 1 phiên, riêng 5 tài khoản kiểm thử có thể đăng nhập song song.';
  }

  const testAccounts = document.querySelector('.test-accounts');
  if (testAccounts) {
    testAccounts.setAttribute('aria-label', 'Tài khoản mẫu');
  }

  const seedHeading = document.querySelector('.test-accounts h2');
  if (seedHeading) {
    seedHeading.textContent = '5 tài khoản kiểm thử';
  }
}

function renderSeedAccounts() {
  if (!seedListEl) {
    return;
  }

  seedListEl.innerHTML = '';
  for (const seed of DISPLAY_TEST_USERS_SEED) {
    const item = document.createElement('li');
    item.textContent = `${seed.email} / ${seed.password} (${seed.name})`;
    seedListEl.appendChild(item);
  }
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

async function handleLogin(event) {
  event.preventDefault();
  const formData = new FormData(loginFormEl);
  const email = mapLegacySeedEmail(normalizeEmail(formData.get('email')));
  const password = String(formData.get('password') || '');

  if (!isValidEmail(email)) {
    setMessage('Email không hợp lệ.', 'error');
    return;
  }
  if (!password) {
    setMessage('Vui lòng nhập mật khẩu.', 'error');
    return;
  }

  let result;
  try {
    result = await callApi('/api/auth/login', { payload: { email, password } });
  } catch (_error) {
    setMessage('Không kết nối được máy chủ.', 'error');
    return;
  }

  if (!result.ok) {
    if (result.status === 409) {
      if (isSeedTestEmail(email)) {
        try {
          result = await callApi('/api/auth/login', { payload: { email, password, force: true } });
        } catch (_error) {
          setMessage('Không kết nối được máy chủ.', 'error');
          return;
        }
        if (result.ok) {
          const user = result.data?.user || { email, name: email };
          setClientSession(user);
          setMessage('Đăng nhập thành công. Đang chuyển về trang game...', 'success');
          redirectToGame();
          return;
        }
      }
      setMessage('Tài khoản này đang online ở nơi khác.', 'error');
      return;
    }
    if (result.status === 429) {
      setMessage(`Bạn thử đăng nhập lại sau ${formatRetryAfter(result.retryAfterSec)}.`, 'error');
      return;
    }
    setMessage('Sai email hoặc mật khẩu.', 'error');
    return;
  }

  const user = result.data?.user || { email, name: email };
  setClientSession(user);
  setMessage('Đăng nhập thành công. Đang chuyển về trang game...', 'success');
  redirectToGame();
}

async function handleRegister(event) {
  event.preventDefault();
  const formData = new FormData(registerFormEl);
  const name = String(formData.get('name') || '').trim();
  const email = normalizeEmail(formData.get('email'));
  const password = String(formData.get('password') || '');
  const confirmPassword = String(formData.get('confirmPassword') || '');

  if (name.length < 2) {
    setMessage('Tên hiển thị phải có ít nhất 2 ký tự.', 'error');
    return;
  }
  if (!isValidEmail(email)) {
    setMessage('Email không hợp lệ.', 'error');
    return;
  }
  if (password.length < 6) {
    setMessage('Mật khẩu phải có ít nhất 6 ký tự.', 'error');
    return;
  }
  if (password !== confirmPassword) {
    setMessage('Mật khẩu nhập lại không khớp.', 'error');
    return;
  }

  let result;
  try {
    result = await callApi('/api/auth/register', { payload: { name, email, password } });
  } catch (_error) {
    setMessage('Không kết nối được máy chủ.', 'error');
    return;
  }

  if (!result.ok) {
    if (result.status === 409) {
      setMessage('Email đã tồn tại hoặc đang online.', 'error');
      return;
    }
    if (result.status === 429) {
      setMessage(
        `Bạn thao tác quá nhanh. Thử lại sau ${formatRetryAfter(result.retryAfterSec)}.`,
        'error'
      );
      return;
    }
    setMessage('Không tạo được tài khoản.', 'error');
    return;
  }

  const user = result.data?.user || { email, name };
  setClientSession(user);
  setMessage('Tạo tài khoản thành công. Đang chuyển về trang game...', 'success');
  redirectToGame();
}

async function bootstrapExistingLogin() {
  let result = null;
  try {
    result = await callApi('/api/auth/me');
  } catch (_error) {
    return;
  }

  if (!result.ok || !result.data?.user) {
    clearClientSession();
    return;
  }

  setClientSession(result.data.user);
  setMessage("Bạn đã đăng nhập. Nhấn 'Vào game' để tiếp tục.", 'success');
}

hydrateStaticText();

tabLoginEl.addEventListener('click', () => setMode('login'));
tabRegisterEl.addEventListener('click', () => setMode('register'));
loginFormEl.addEventListener('submit', handleLogin);
registerFormEl.addEventListener('submit', handleRegister);

renderSeedAccounts();
setMode('login');
bootstrapExistingLogin();
