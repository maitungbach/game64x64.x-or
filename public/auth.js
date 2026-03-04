const SESSION_KEY = "game64x64:session";
const ACTIVE_SESSIONS_KEY = "game64x64:active_sessions";
const TAB_ID_KEY = "game64x64:tab_id";
const ACTIVE_SESSION_TTL_MS = 15_000;
const TEST_USERS_SEED = [
  { name: "Tài khoản kiểm thử 01", email: "tester01@example.com", password: "Test123!" },
  { name: "Tài khoản kiểm thử 02", email: "tester02@example.com", password: "Test123!" },
  { name: "Tài khoản kiểm thử 03", email: "tester03@example.com", password: "Test123!" },
  { name: "Tài khoản kiểm thử 04", email: "tester04@example.com", password: "Test123!" },
  { name: "Tài khoản kiểm thử 05", email: "tester05@example.com", password: "Test123!" },
];
const SEED_TEST_EMAILS = new Set(TEST_USERS_SEED.map((seed) => normalizeEmail(seed.email)));

const tabLoginEl = document.getElementById("tabLogin");
const tabRegisterEl = document.getElementById("tabRegister");
const loginFormEl = document.getElementById("loginForm");
const registerFormEl = document.getElementById("registerForm");
const authMessageEl = document.getElementById("authMessage");
const seedListEl = document.getElementById("seedList");

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isSeedTestEmail(email) {
  return SEED_TEST_EMAILS.has(normalizeEmail(email));
}

function mapLegacySeedEmail(email) {
  const match = /^tester(0[1-5])@game\.local$/.exec(email);
  if (!match) {
    return email;
  }
  return `tester${match[1]}@example.com`;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getTabId() {
  try {
    const current = sessionStorage.getItem(TAB_ID_KEY);
    if (current) {
      return current;
    }
    const created = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
    sessionStorage.setItem(TAB_ID_KEY, created);
    return created;
  } catch (_error) {
    return `fallback_${Math.random().toString(16).slice(2, 10)}`;
  }
}

const TAB_ID = getTabId();

function getNextPath() {
  const next = new URLSearchParams(window.location.search).get("next") || "/game.html";
  if (!next.startsWith("/")) {
    return "/game.html";
  }
  return next;
}

const nextPath = getNextPath();

function pruneExpiredLocks(locks) {
  const now = Date.now();
  for (const [email, lock] of Object.entries(locks)) {
    if (
      !lock
      || typeof lock.tabId !== "string"
      || typeof lock.sessionToken !== "string"
      || !Number.isFinite(Number(lock.updatedAt))
      || now - Number(lock.updatedAt) > ACTIVE_SESSION_TTL_MS
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    pruneExpiredLocks(parsed);
    return parsed;
  } catch (_error) {
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

function claimAccountLock(email, sessionToken) {
  const normalizedEmail = normalizeEmail(email);
  if (isSeedTestEmail(normalizedEmail)) {
    return;
  }
  const locks = readActiveSessions();
  locks[normalizedEmail] = {
    tabId: TAB_ID,
    sessionToken,
    updatedAt: Date.now(),
  };
  writeActiveSessions(locks);
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
  const normalizedEmail = normalizeEmail(session.email);
  if (isSeedTestEmail(normalizedEmail)) {
    return;
  }
  const locks = readActiveSessions();
  const lock = locks[normalizedEmail];
  if (!lock) {
    return;
  }
  if (lock.tabId !== TAB_ID || lock.sessionToken !== session.sessionToken) {
    return;
  }
  delete locks[normalizedEmail];
  writeActiveSessions(locks);
}

function readClientSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || typeof parsed.email !== "string"
      || typeof parsed.tabId !== "string"
      || typeof parsed.sessionToken !== "string"
    ) {
      return null;
    }
    if (parsed.tabId !== TAB_ID) {
      return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
}

function setClientSession(user) {
  const existing = readClientSession();
  if (existing && normalizeEmail(existing.email) !== normalizeEmail(user.email)) {
    releaseOwnedAccountLock(existing);
  }

  const session = {
    name: String(user.name || user.email || "").trim(),
    email: normalizeEmail(user.email),
    tabId: TAB_ID,
    sessionToken: `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
    loggedAt: new Date().toISOString(),
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  claimAccountLock(session.email, session.sessionToken);
}

function clearClientSession() {
  const existing = readClientSession();
  releaseOwnedAccountLock(existing);
  sessionStorage.removeItem(SESSION_KEY);
}

function setMessage(text, type) {
  authMessageEl.textContent = text || "";
  authMessageEl.className = "message";
  if (type) {
    authMessageEl.classList.add(type);
  }
}

function setMode(mode) {
  const loginActive = mode === "login";
  tabLoginEl.classList.toggle("is-active", loginActive);
  tabRegisterEl.classList.toggle("is-active", !loginActive);
  loginFormEl.classList.toggle("is-hidden", !loginActive);
  registerFormEl.classList.toggle("is-hidden", loginActive);
  setMessage("");
}

function renderSeedAccounts() {
  if (!seedListEl) {
    return;
  }

  seedListEl.innerHTML = "";
  for (const seed of TEST_USERS_SEED) {
    const item = document.createElement("li");
    item.textContent = `${seed.email} / ${seed.password} (${seed.name})`;
    seedListEl.appendChild(item);
  }
}

async function callApi(path, payload) {
  const response = await fetch(path, {
    method: payload ? "POST" : "GET",
    credentials: "include",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });

  let data = null;
  try {
    data = await response.json();
  } catch (_error) {
    data = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

function redirectToGame(delayMs = 300) {
  window.setTimeout(() => {
    window.location.href = nextPath;
  }, delayMs);
}

async function handleLogin(event) {
  event.preventDefault();
  const formData = new FormData(loginFormEl);
  const email = mapLegacySeedEmail(normalizeEmail(formData.get("email")));
  const password = String(formData.get("password") || "");

  if (!isValidEmail(email)) {
    setMessage("Email không hợp lệ.", "error");
    return;
  }
  if (!password) {
    setMessage("Vui lòng nhập mật khẩu.", "error");
    return;
  }
  if (isLockedByAnotherTab(email)) {
    setMessage("Tài khoản này đang đăng nhập ở tab khác.", "error");
    return;
  }

  let result;
  try {
    result = await callApi("/api/auth/login", { email, password });
  } catch (_error) {
    setMessage("Không kết nối được máy chủ.", "error");
    return;
  }

  if (!result.ok) {
    if (result.status === 409) {
      if (isSeedTestEmail(email)) {
        try {
          result = await callApi("/api/auth/login", { email, password, force: true });
        } catch (_error) {
          setMessage("Không kết nối được máy chủ.", "error");
          return;
        }
        if (result.ok) {
          const user = result.data?.user || { email, name: email };
          setClientSession(user);
          setMessage("Đăng nhập thành công. Đang chuyển về trang game...", "success");
          redirectToGame();
          return;
        }
      }
      setMessage("Tài khoản này đang online ở nơi khác.", "error");
      return;
    }
    setMessage("Sai email hoặc mật khẩu.", "error");
    return;
  }

  const user = result.data?.user || { email, name: email };
  setClientSession(user);
  setMessage("Đăng nhập thành công. Đang chuyển về trang game...", "success");
  redirectToGame();
}

async function handleRegister(event) {
  event.preventDefault();
  const formData = new FormData(registerFormEl);
  const name = String(formData.get("name") || "").trim();
  const email = normalizeEmail(formData.get("email"));
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");

  if (name.length < 2) {
    setMessage("Tên hiển thị phải có ít nhất 2 ký tự.", "error");
    return;
  }
  if (!isValidEmail(email)) {
    setMessage("Email không hợp lệ.", "error");
    return;
  }
  if (password.length < 6) {
    setMessage("Mật khẩu phải có ít nhất 6 ký tự.", "error");
    return;
  }
  if (password !== confirmPassword) {
    setMessage("Mật khẩu nhập lại không khớp.", "error");
    return;
  }
  if (isLockedByAnotherTab(email)) {
    setMessage("Tài khoản này đang đăng nhập ở tab khác.", "error");
    return;
  }

  let result;
  try {
    result = await callApi("/api/auth/register", { name, email, password });
  } catch (_error) {
    setMessage("Không kết nối được máy chủ.", "error");
    return;
  }

  if (!result.ok) {
    if (result.status === 409) {
      setMessage("Email đã tồn tại hoặc đang online.", "error");
      return;
    }
    setMessage("Không tạo được tài khoản.", "error");
    return;
  }

  const user = result.data?.user || { email, name };
  setClientSession(user);
  setMessage("Tạo tài khoản thành công. Đang chuyển về trang game...", "success");
  redirectToGame();
}

async function bootstrapExistingLogin() {
  let result = null;
  try {
    result = await callApi("/api/auth/me");
  } catch (_error) {
    return;
  }

  if (!result.ok || !result.data?.user) {
    clearClientSession();
    return;
  }

  if (isLockedByAnotherTab(result.data.user.email)) {
    setMessage("Tài khoản này đang đăng nhập ở tab khác.", "error");
    return;
  }

  setClientSession(result.data.user);
  setMessage("Bạn đã đăng nhập. Nếu muốn vào game, bấm 'Vào game'.", "success");
}

tabLoginEl.addEventListener("click", () => setMode("login"));
tabRegisterEl.addEventListener("click", () => setMode("register"));
loginFormEl.addEventListener("submit", handleLogin);
registerFormEl.addEventListener("submit", handleRegister);

renderSeedAccounts();
clearSeedAccountLocks();
setMode("login");
bootstrapExistingLogin();
