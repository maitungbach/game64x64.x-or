const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const assert = require('assert');
const { MongoClient } = require('mongodb');
const { io } = require('socket.io-client');

const TEST_PORT = 3104;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js');
const ENV_PATH = path.join(__dirname, '..', '.env');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .reduce((acc, rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        return acc;
      }

      const separatorIndex = line.indexOf('=');
      if (separatorIndex === -1) {
        return acc;
      }

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      acc[key] = value;
      return acc;
    }, {});
}

const FILE_ENV = loadEnvFile(ENV_PATH);
const MONGO_URL = process.env.MONGO_URL || FILE_ENV.MONGO_URL || 'mongodb://127.0.0.1:37018';
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || FILE_ENV.MONGO_DB_NAME || 'game64x64';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(method, route, body = null, cookie = '') {
  const payload = body ? JSON.stringify(body) : null;
  const headers = {
    Accept: 'application/json',
  };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  if (cookie) {
    headers.Cookie = cookie;
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE_URL}${route}`,
      {
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw || '{}');
          } catch (_error) {
            parsed = null;
          }
          resolve({
            statusCode: res.statusCode,
            body: parsed,
            setCookie: res.headers['set-cookie'] || [],
            headers: res.headers,
          });
        });
      }
    );

    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function waitForHealth(timeoutMs = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await requestJson('GET', '/api/health');
      if (res.statusCode === 200) {
        return;
      }
    } catch (_error) {
      // retry
    }
    await delay(100);
  }
  throw new Error('Server healthcheck timeout');
}

function extractCookie(setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders) || setCookieHeaders.length === 0) {
    return '';
  }
  const first = setCookieHeaders[0];
  return String(first).split(';')[0];
}

function connectAuthedSocket(cookie) {
  return io(BASE_URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 4000,
    extraHeaders: {
      Cookie: cookie,
    },
  });
}

function waitForSocketConnect(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connect timeout')), 4000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function startServer() {
  const server = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      NODE_ENV: 'test',
      ENABLE_REDIS: 'false',
      STRICT_CLUSTER_CONFIG: 'false',
      MONGO_URL,
      MONGO_DB_NAME,
      AUTH_REQUIRED: 'true',
      AUTH_REQUIRE_MONGO: 'true',
      AUTH_REJECT_CONCURRENT: 'true',
      AUTH_SEED_TEST_USERS: 'true',
      AUTH_ALLOW_CONCURRENT_SEED_USERS: 'true',
      AUTH_RELEASE_DELAY_MS: '200',
      AUTH_LOGIN_FAIL_RATE_LIMIT_MAX: '2',
      AUTH_LOGIN_FAIL_RATE_LIMIT_WINDOW_SEC: '60',
      AUTH_REGISTER_RATE_LIMIT_MAX: '10',
      AUTH_REGISTER_RATE_LIMIT_WINDOW_SEC: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  server.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return {
    process: server,
    getStdout() {
      return stdout;
    },
    getStderr() {
      return stderr;
    },
  };
}

async function stopServer(serverHandle) {
  if (!serverHandle?.process) {
    return;
  }

  const server = serverHandle.process;
  if (server.exitCode !== null || server.killed) {
    return;
  }

  const exited = new Promise((resolve) => {
    server.once('exit', resolve);
  });

  server.kill();
  await Promise.race([exited, delay(600)]);
}

async function cleanupMongoAuthState(db, email) {
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const existing = await users.findOne({ email });
  if (existing?.id) {
    await sessions.deleteMany({ userId: existing.id });
  }
  await users.deleteMany({ email });
}

async function run() {
  const mongoClient = new MongoClient(MONGO_URL, { maxPoolSize: 4 });
  await mongoClient.connect();
  const mongoDb = mongoClient.db(MONGO_DB_NAME);
  const email = `auth_test_${Date.now()}@example.com`;
  let activeSocket = null;
  let serverHandle = null;
  let combinedStderr = '';
  let startedServers = 0;
  let primaryError = null;

  try {
    await cleanupMongoAuthState(mongoDb, email);

    serverHandle = startServer();
    await waitForHealth();
    startedServers += 1;
    const healthRes = await requestJson('GET', '/api/health');
    assert.strictEqual(healthRes.statusCode, 200, 'Health should return 200');
    assert.strictEqual(healthRes.body?.authStorage, 'mongo', 'Auth storage should use MongoDB');
    assert.strictEqual(healthRes.body?.mongoConnected, true, 'MongoDB should be connected');

    const password = 'Test123!';
    const name = 'Auth Test';

    const registerRes = await requestJson('POST', '/api/auth/register', {
      email,
      password,
      name,
    });
    assert.strictEqual(registerRes.statusCode, 201, 'Register should return 201');
    const registerCookie = extractCookie(registerRes.setCookie);
    assert(registerCookie.includes('game64x64_session='), 'Register should set auth cookie');

    const meRes = await requestJson('GET', '/api/auth/me', null, registerCookie);
    assert.strictEqual(meRes.statusCode, 200, 'Expected /api/auth/me authorized');
    assert.strictEqual(
      meRes.body?.user?.email,
      email,
      'Expected /api/auth/me to return registered email'
    );

    const mongoUser = await mongoDb.collection('users').findOne({ email });
    assert(mongoUser, 'Registered account should be stored in MongoDB users collection');
    assert.strictEqual(mongoUser.name, name, 'MongoDB should store the registered display name');

    combinedStderr += serverHandle.getStderr();
    await stopServer(serverHandle);
    serverHandle = startServer();
    await waitForHealth();
    startedServers += 1;

    const meAfterRestartRes = await requestJson('GET', '/api/auth/me', null, registerCookie);
    assert.strictEqual(
      meAfterRestartRes.statusCode,
      200,
      'Expected auth session to survive server restart'
    );
    assert.strictEqual(
      meAfterRestartRes.body?.user?.email,
      email,
      'Expected restarted server to load user from MongoDB'
    );

    const logoutRes = await requestJson('POST', '/api/auth/logout', null, registerCookie);
    assert.strictEqual(logoutRes.statusCode, 200, 'Logout should return 200');

    const loginRes = await requestJson('POST', '/api/auth/login', { email, password });
    assert.strictEqual(loginRes.statusCode, 200, 'Login should return 200');
    const loginCookie = extractCookie(loginRes.setCookie);
    activeSocket = connectAuthedSocket(loginCookie);
    await waitForSocketConnect(activeSocket);

    const duplicateLoginRes = await requestJson('POST', '/api/auth/login', { email, password });
    assert.strictEqual(
      duplicateLoginRes.statusCode,
      409,
      'Second login should be rejected while socket is online'
    );

    activeSocket.disconnect();
    activeSocket = null;
    await delay(350);

    const reloginAfterCloseRes = await requestJson('POST', '/api/auth/login', { email, password });
    assert.strictEqual(
      reloginAfterCloseRes.statusCode,
      200,
      'Login should recover after socket disconnect'
    );

    const forceTakeoverLoginRes = await requestJson('POST', '/api/auth/login', {
      email,
      password,
      force: true,
    });
    assert.strictEqual(
      forceTakeoverLoginRes.statusCode,
      200,
      'Force login should replace existing session'
    );

    const seedEmail = 'tester01@example.com';
    const seedPassword = 'Test123!';
    const seedLogin1 = await requestJson('POST', '/api/auth/login', {
      email: seedEmail,
      password: seedPassword,
    });
    assert.strictEqual(seedLogin1.statusCode, 200, 'Seed account first login should return 200');

    const seedLogin2 = await requestJson('POST', '/api/auth/login', {
      email: seedEmail,
      password: seedPassword,
    });
    assert.strictEqual(seedLogin2.statusCode, 200, 'Seed account should allow concurrent login');

    const wrongPassword1 = await requestJson('POST', '/api/auth/login', {
      email,
      password: 'WrongPass1!',
    });
    assert.strictEqual(wrongPassword1.statusCode, 401, 'First wrong password should return 401');

    const wrongPassword2 = await requestJson('POST', '/api/auth/login', {
      email,
      password: 'WrongPass2!',
    });
    assert.strictEqual(
      wrongPassword2.statusCode,
      429,
      'Second wrong password should trigger login rate limit'
    );
    assert.strictEqual(
      wrongPassword2.body?.message,
      'Too many login attempts',
      'Expected rate limit message'
    );
    assert(
      Number(wrongPassword2.headers?.['retry-after']) >= 1,
      'Expected Retry-After header on login rate limit'
    );

    console.log(
      'PASS auth smoke: mongo persistence + restart session + single-session + seed concurrent + login rate limit'
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (activeSocket) {
      activeSocket.disconnect();
    }
    if (serverHandle) {
      combinedStderr += serverHandle.getStderr();
      await stopServer(serverHandle);
    }
    if (combinedStderr.trim()) {
      console.error(combinedStderr.trim());
    }
    await cleanupMongoAuthState(mongoDb, email);
    await mongoClient.close();
  }

  if (!primaryError && startedServers < 2) {
    throw new Error('Server did not start correctly in auth smoke test');
  }
}

run().catch((error) => {
  console.error('FAIL auth smoke:', error.message);
  process.exit(1);
});
