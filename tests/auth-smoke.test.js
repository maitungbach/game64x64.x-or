const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const assert = require("assert");

const TEST_PORT = 3104;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const SERVER_PATH = path.join(__dirname, "..", "src", "server.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(method, route, body = null, cookie = "") {
  const payload = body ? JSON.stringify(body) : null;
  const headers = {
    Accept: "application/json",
  };
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
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
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw || "{}");
          } catch (_error) {
            parsed = null;
          }
          resolve({
            statusCode: res.statusCode,
            body: parsed,
            setCookie: res.headers["set-cookie"] || [],
          });
        });
      },
    );

    req.on("error", reject);
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
      const res = await requestJson("GET", "/api/health");
      if (res.statusCode === 200) {
        return;
      }
    } catch (_error) {
      // retry
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(100);
  }
  throw new Error("Server healthcheck timeout");
}

function extractCookie(setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders) || setCookieHeaders.length === 0) {
    return "";
  }
  const first = setCookieHeaders[0];
  return String(first).split(";")[0];
}

async function run() {
  const server = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      ENABLE_REDIS: "false",
      AUTH_REQUIRED: "true",
      AUTH_REJECT_CONCURRENT: "true",
      AUTH_CONCURRENT_STALE_SEC: "1",
      AUTH_SEED_TEST_USERS: "true",
      AUTH_ALLOW_CONCURRENT_SEED_USERS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth();

    const email = `auth_test_${Date.now()}@example.com`;
    const password = "Test123!";
    const name = "Auth Test";

    const registerRes = await requestJson("POST", "/api/auth/register", {
      email,
      password,
      name,
    });
    assert.strictEqual(registerRes.statusCode, 201, "Register should return 201");
    const registerCookie = extractCookie(registerRes.setCookie);
    assert(registerCookie.includes("game64x64_session="), "Register should set auth cookie");

    const meRes = await requestJson("GET", "/api/auth/me", null, registerCookie);
    assert.strictEqual(meRes.statusCode, 200, "Expected /api/auth/me authorized");
    assert.strictEqual(meRes.body?.user?.email, email, "Expected /api/auth/me to return registered email");

    const logoutRes = await requestJson("POST", "/api/auth/logout", null, registerCookie);
    assert.strictEqual(logoutRes.statusCode, 200, "Logout should return 200");

    const loginRes = await requestJson("POST", "/api/auth/login", { email, password });
    assert.strictEqual(loginRes.statusCode, 200, "Login should return 200");

    const duplicateLoginRes = await requestJson("POST", "/api/auth/login", { email, password });
    assert.strictEqual(duplicateLoginRes.statusCode, 409, "Second login should be rejected by single-session policy");

    await delay(1200);
    const staleTakeoverLoginRes = await requestJson("POST", "/api/auth/login", { email, password });
    assert.strictEqual(staleTakeoverLoginRes.statusCode, 200, "Stale session should be replaced after threshold");

    const seedEmail = "tester01@example.com";
    const seedPassword = "Test123!";
    const seedLogin1 = await requestJson("POST", "/api/auth/login", {
      email: seedEmail,
      password: seedPassword,
    });
    assert.strictEqual(seedLogin1.statusCode, 200, "Seed account first login should return 200");

    const seedLogin2 = await requestJson("POST", "/api/auth/login", {
      email: seedEmail,
      password: seedPassword,
    });
    assert.strictEqual(seedLogin2.statusCode, 200, "Seed account should allow concurrent login");

    console.log("PASS auth smoke: register/login/me/logout + single-session reject + seed concurrent");
  } finally {
    server.kill();
    await delay(250);

    if (stderr.trim()) {
      console.error(stderr.trim());
    }
    if (!stdout.includes("Server is running")) {
      throw new Error("Server did not start correctly in auth smoke test");
    }
  }
}

run().catch((error) => {
  console.error("FAIL auth smoke:", error.message);
  process.exit(1);
});
