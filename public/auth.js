const USERS_KEY = "game64x64:users";
const SESSION_KEY = "game64x64:session";
const ACTIVE_SESSIONS_KEY = "game64x64:active_sessions";
const TAB_ID_KEY = "game64x64:tab_id";
const ACTIVE_SESSION_TTL_MS = 15_000;
const SEED_USERS = [
  { id: "seed_1", name: "Tester 01", email: "tester01@example.com", password: "Test123!" },
  { id: "seed_2", name: "Tester 02", email: "tester02@example.com", password: "Test123!" },
  { id: "seed_3", name: "Tester 03", email: "tester03@example.com", password: "Test123!" },
  { id: "seed_4", name: "Tester 04", email: "tester04@example.com", password: "Test123!" },
  { id: "seed_5", name: "Tester 05", email: "tester05@example.com", password: "Test123!" },
];

const tabLoginEl = document.getElementById("tabLogin");
const tabRegisterEl = document.getElementById("tabRegister");
const loginFormEl = document.getElementById("loginForm");
const registerFormEl = document.getElementById("registerForm");
const authMessageEl = document.getElementById("authMessage");
const seedListEl = document.getElementById("seedList");

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
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

function getNextPath() {
  const next = new URLSearchParams(window.location.search).get("next") || "/game.html";
  if (!next.startsWith("/")) {
    return "/game.html";
  }
  return next;
}

const nextPath = getNextPath();

function readUsers() {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function writeUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

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

function getAccountLock(email) {
  const normalizedEmail = normalizeEmail(email);
  const locks = readActiveSessions();
  return locks[normalizedEmail] || null;
}

function claimAccountLock(email, sessionToken) {
  const normalizedEmail = normalizeEmail(email);
  const locks = readActiveSessions();
  locks[normalizedEmail] = {
    tabId: TAB_ID,
    sessionToken,
    updatedAt: Date.now(),
  };
  writeActiveSessions(locks);
}

function isLockedByAnotherTab(email) {
  const lock = getAccountLock(email);
  if (!lock) {
    return false;
  }
  return lock.tabId !== TAB_ID;
}

function readSession() {
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
    return parsed;
  } catch (_error) {
    return null;
  }
}

function setSession(user) {
  const sessionToken = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const session = {
    name: user.name,
    email: normalizeEmail(user.email),
    tabId: TAB_ID,
    sessionToken,
    loggedAt: new Date().toISOString(),
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  claimAccountLock(session.email, sessionToken);
}

function ensureSeedUsers() {
  const users = readUsers();
  let changed = false;

  for (const seed of SEED_USERS) {
    const normalizedEmail = normalizeEmail(seed.email);
    const existingByIdIndex = users.findIndex((user) => user.id === seed.id);
    const existingByEmailIndex = users.findIndex(
      (user) => normalizeEmail(user.email) === normalizedEmail,
    );

    const normalizedSeed = {
      id: seed.id,
      name: seed.name,
      email: normalizedEmail,
      password: seed.password,
      createdAt: new Date().toISOString(),
      isSeed: true,
    };

    if (existingByIdIndex >= 0) {
      users[existingByIdIndex] = {
        ...users[existingByIdIndex],
        ...normalizedSeed,
      };
      changed = true;
      continue;
    }

    if (existingByEmailIndex >= 0) {
      users[existingByEmailIndex] = {
        ...users[existingByEmailIndex],
        ...normalizedSeed,
      };
      changed = true;
      continue;
    }

    users.push(normalizedSeed);
    changed = true;
  }

  if (changed) {
    writeUsers(users);
  }
}

function renderSeedAccounts() {
  if (!seedListEl) {
    return;
  }

  seedListEl.innerHTML = "";
  for (const seed of SEED_USERS) {
    const item = document.createElement("li");
    item.textContent = `${seed.email} / ${seed.password} (${seed.name})`;
    seedListEl.appendChild(item);
  }
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

function redirectToGame(delayMs = 300) {
  window.setTimeout(() => {
    window.location.href = nextPath;
  }, delayMs);
}

function findUserByCredential(email, password) {
  const users = readUsers();
  const found = users.find(
    (user) => normalizeEmail(user.email) === email && String(user.password || "") === password,
  );
  if (found) {
    return found;
  }

  const seeded = SEED_USERS.find(
    (user) => normalizeEmail(user.email) === email && String(user.password || "") === password,
  );
  if (!seeded) {
    return null;
  }

  return {
    id: seeded.id,
    name: seeded.name,
    email: seeded.email,
    password: seeded.password,
  };
}

function handleLogin(event) {
  event.preventDefault();
  const formData = new FormData(loginFormEl);
  const email = mapLegacySeedEmail(normalizeEmail(formData.get("email")));
  const password = String(formData.get("password") || "");

  if (!isValidEmail(email)) {
    setMessage("Email khong hop le.", "error");
    return;
  }

  if (!password) {
    setMessage("Vui long nhap mat khau.", "error");
    return;
  }

  if (isLockedByAnotherTab(email)) {
    setMessage("Tai khoan nay dang dang nhap o tab khac.", "error");
    return;
  }

  const found = findUserByCredential(email, password);
  if (!found) {
    setMessage("Sai email hoac mat khau.", "error");
    return;
  }

  try {
    setSession(found);
  } catch (_error) {
    setMessage("Khong the luu phien dang nhap tren trinh duyet nay.", "error");
    return;
  }
  setMessage("Dang nhap thanh cong. Dang chuyen ve trang game...", "success");
  redirectToGame();
}

function handleRegister(event) {
  event.preventDefault();
  const formData = new FormData(registerFormEl);
  const name = String(formData.get("name") || "").trim();
  const email = normalizeEmail(formData.get("email"));
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");

  if (name.length < 2) {
    setMessage("Ten hien thi phai co it nhat 2 ky tu.", "error");
    return;
  }

  if (!isValidEmail(email)) {
    setMessage("Email khong hop le.", "error");
    return;
  }

  if (password.length < 6) {
    setMessage("Mat khau phai co it nhat 6 ky tu.", "error");
    return;
  }

  if (password !== confirmPassword) {
    setMessage("Mat khau nhap lai khong khop.", "error");
    return;
  }

  if (isLockedByAnotherTab(email)) {
    setMessage("Tai khoan nay dang dang nhap o tab khac.", "error");
    return;
  }

  const users = readUsers();
  if (users.some((user) => normalizeEmail(user.email) === email)) {
    setMessage("Email nay da duoc dang ky.", "error");
    return;
  }

  const user = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    name,
    email,
    password,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);

  try {
    setSession(user);
  } catch (_error) {
    setMessage("Khong the luu phien dang nhap tren trinh duyet nay.", "error");
    return;
  }
  setMessage("Tao tai khoan thanh cong. Dang chuyen ve trang game...", "success");
  redirectToGame();
}

tabLoginEl.addEventListener("click", () => setMode("login"));
tabRegisterEl.addEventListener("click", () => setMode("register"));
loginFormEl.addEventListener("submit", handleLogin);
registerFormEl.addEventListener("submit", handleRegister);

ensureSeedUsers();
renderSeedAccounts();
setMode("login");

const existingSession = readSession();
if (
  existingSession
  && existingSession.tabId === TAB_ID
  && !isLockedByAnotherTab(existingSession.email)
) {
  claimAccountLock(existingSession.email, existingSession.sessionToken);
  redirectToGame(0);
}
