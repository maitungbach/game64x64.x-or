const http = require('http');
const path = require('path');
const assert = require('assert');
const { MongoClient } = require('mongodb');
const { io } = require('socket.io-client');
const { loadEnvFile } = require('../src/lib/load-env-file.js');
const { startTestServer } = require('./helpers/server-harness.js');

const TEST_PORT = 3104;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const ENV_PATH = path.join(__dirname, '..', '.env');
const RUN_ADMIN_ASSERTIONS = true;

const FILE_ENV = loadEnvFile(ENV_PATH, {});
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
  if (method !== 'GET' && method !== 'HEAD') {
    headers['x-game64x64-csrf'] = '1';
  }
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
            rawBody: raw,
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

function waitForSocketDisconnect(socket) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('Socket disconnect timeout')), 4000);
    socket.once('disconnect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function createServerHandle() {
  return startTestServer({
    PORT: String(TEST_PORT),
    NODE_ENV: 'test',
    ENABLE_REDIS: 'false',
    STATS_TOKEN: 'secret-token',
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
  });
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
  const adminVictimEmail = `admin_victim_${Date.now()}@example.com`;
  let activeSocket = null;
  let adminVictimSocket = null;
  let serverHandle = null;
  let startedServers = 0;
  let primaryError = null;

  try {
    await cleanupMongoAuthState(mongoDb, email);
    await cleanupMongoAuthState(mongoDb, adminVictimEmail);

    serverHandle = await createServerHandle();
    startedServers += 1;
    const healthRes = await requestJson('GET', '/health');
    assert.strictEqual(healthRes.statusCode, 200, 'Health should return 200');
    assert.strictEqual(healthRes.body?.ok, true, 'Public health should return ok=true');

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

    await serverHandle.stop();
    serverHandle = await createServerHandle();
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

    if (RUN_ADMIN_ASSERTIONS) {
      const anonAdminPage = await requestJson('GET', '/admin');
      assert.strictEqual(anonAdminPage.statusCode, 302, 'Anonymous /admin should redirect to login');
      assert.strictEqual(
        anonAdminPage.headers?.location,
        '/auth.html?next=%2Fadmin',
        'Anonymous /admin should redirect to admin login'
      );

      const anonAdminHealth = await requestJson('GET', '/api/health');
      assert.strictEqual(
        anonAdminHealth.statusCode,
        401,
        'Anonymous /api/health should require admin auth'
      );

      const anonAdminDashboard = await requestJson('GET', '/api/admin/dashboard');
      assert.strictEqual(
        anonAdminDashboard.statusCode,
        401,
        'Anonymous /api/admin/dashboard should require admin auth'
      );

      const nonAdminLogin = await requestJson('POST', '/api/auth/login', {
        email: 'tester02@example.com',
        password: 'Test123!',
      });
      assert.strictEqual(nonAdminLogin.statusCode, 200, 'Non-admin seed user login should succeed');
      const nonAdminCookie = extractCookie(nonAdminLogin.setCookie);

      const nonAdminPage = await requestJson('GET', '/admin', null, nonAdminCookie);
      assert.strictEqual(nonAdminPage.statusCode, 403, 'Non-admin should be blocked from /admin');

      const nonAdminHealth = await requestJson('GET', '/api/health', null, nonAdminCookie);
      assert.strictEqual(
        nonAdminHealth.statusCode,
        403,
        'Non-admin should be blocked from /api/health'
      );

      const nonAdminDashboard = await requestJson('GET', '/api/admin/dashboard', null, nonAdminCookie);
      assert.strictEqual(
        nonAdminDashboard.statusCode,
        403,
        'Non-admin should be blocked from /api/admin/dashboard'
      );

      const nonAdminStats = await requestJson('GET', '/api/stats', null, nonAdminCookie);
      assert.strictEqual(
        nonAdminStats.statusCode,
        401,
        'Non-admin should not access /api/stats without STATS_TOKEN'
      );

      const adminLogin = await requestJson('POST', '/api/auth/login', {
        email: 'tester01@example.com',
        password: 'Test123!',
      });
      assert.strictEqual(adminLogin.statusCode, 200, 'Admin seed user login should succeed');
      const adminCookie = extractCookie(adminLogin.setCookie);

      const adminPage = await requestJson('GET', '/admin', null, adminCookie);
      assert.strictEqual(adminPage.statusCode, 200, 'Admin should access /admin');
      assert(
        adminPage.rawBody.includes('Tra cứu người dùng'),
        'Expected admin page HTML to include lookup tools'
      );

      const adminHealth = await requestJson('GET', '/api/health', null, adminCookie);
      assert.strictEqual(adminHealth.statusCode, 200, 'Admin should access /api/health');
      assert.strictEqual(adminHealth.body?.authStorage, 'mongo', 'Admin health should report Mongo');

      const adminDashboard = await requestJson('GET', '/api/admin/dashboard', null, adminCookie);
      assert.strictEqual(adminDashboard.statusCode, 200, 'Admin should access /api/admin/dashboard');
      assert.strictEqual(adminDashboard.body?.ok, true, 'Admin dashboard should return ok=true');
      assert.strictEqual(
        adminDashboard.body?.health?.authStorage,
        'mongo',
        'Admin dashboard health should report Mongo'
      );
      assert.strictEqual(
        typeof adminDashboard.body?.stats?.uptimeSec,
        'number',
        'Admin dashboard stats should include uptimeSec'
      );

      const adminStats = await requestJson('GET', '/api/stats', null, adminCookie);
      assert.strictEqual(adminStats.statusCode, 200, 'Admin should access /api/stats without token');

      const victimRegisterRes = await requestJson('POST', '/api/auth/register', {
        email: adminVictimEmail,
        password: 'Victim123!',
        name: 'Admin Victim',
      });
      assert.strictEqual(victimRegisterRes.statusCode, 201, 'Victim registration should succeed');
      const victimCookie = extractCookie(victimRegisterRes.setCookie);

      adminVictimSocket = connectAuthedSocket(victimCookie);
      await waitForSocketConnect(adminVictimSocket);

      const lookupRes = await requestJson(
        'GET',
        `/api/admin/user-by-email?email=${encodeURIComponent(adminVictimEmail)}`,
        null,
        adminCookie
      );
      assert.strictEqual(lookupRes.statusCode, 200, 'Admin lookup should succeed');
      assert.strictEqual(lookupRes.body?.found, true, 'Admin lookup should find victim');
      assert(
        Number(lookupRes.body?.sessionSummary?.count) >= 1,
        'Victim should have at least one active session'
      );

      const victimUserId = lookupRes.body?.user?.id;
      assert(victimUserId, 'Admin lookup should return victim user id');

      const disconnectWait = waitForSocketDisconnect(adminVictimSocket);
      const revokeRes = await requestJson(
        'POST',
        '/api/admin/user/revoke-sessions',
        { userId: victimUserId },
        adminCookie
      );
      assert.strictEqual(revokeRes.statusCode, 200, 'Admin revoke should succeed');
      assert(
        Number(revokeRes.body?.revokedCount) >= 1,
        'Admin revoke should clear at least one session'
      );
      assert(
        Number(revokeRes.body?.disconnectedSockets) >= 1,
        'Admin revoke should disconnect at least one socket'
      );

      await disconnectWait;
      adminVictimSocket = null;

      const victimMeRes = await requestJson('GET', '/api/auth/me', null, victimCookie);
      assert.strictEqual(
        victimMeRes.statusCode,
        401,
        'Victim session should be unauthorized after admin revoke'
      );
    }

    console.log(
      RUN_ADMIN_ASSERTIONS
        ? 'PASS auth smoke admin: auth + admin route guard + lookup + revoke session'
        : 'PASS auth smoke: mongo persistence + restart session + single-session + seed concurrent + login rate limit'
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (activeSocket) {
      activeSocket.disconnect();
    }
    if (adminVictimSocket) {
      adminVictimSocket.disconnect();
    }
    if (serverHandle) {
      await serverHandle.stop();
    }
    await cleanupMongoAuthState(mongoDb, email);
    await cleanupMongoAuthState(mongoDb, adminVictimEmail);
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
