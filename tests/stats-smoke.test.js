const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const assert = require("assert");

const TEST_PORT = 3102;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const SERVER_PATH = path.join(__dirname, "..", "src", "server.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body || "{}");
        } catch (_error) {
          parsed = null;
        }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });

    req.on("error", reject);
  });
}

async function waitForHealth() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 6000) {
    try {
      const res = await requestJson(`${BASE_URL}/api/health`);
      if (res.statusCode === 200) {
        return;
      }
    } catch (_error) {
      // keep retrying
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(100);
  }
  throw new Error("Server healthcheck timeout");
}

async function run() {
  const server = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      ENABLE_REDIS: "false",
      STATS_TOKEN: "secret-token",
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

    const health = await requestJson(`${BASE_URL}/api/health`);
    assert.strictEqual(health.statusCode, 200, "Expected /api/health to succeed");
    assert.strictEqual(health.body.ok, true, "Expected ok=true in health response");
    assert.strictEqual(typeof health.body.version, "string", "version missing in health response");
    assert(health.body.version.length > 0, "version should not be empty");
    assert.strictEqual(typeof health.body.nodeId, "string", "nodeId missing in health response");
    assert(health.body.nodeId.length > 0, "nodeId should not be empty");
    assert(Array.isArray(health.body.configWarnings), "configWarnings missing in health response");

    const unauthorized = await requestJson(`${BASE_URL}/api/stats`);
    assert.strictEqual(unauthorized.statusCode, 401, "Expected /api/stats unauthorized without token");

    const authorized = await requestJson(`${BASE_URL}/api/stats`, {
      "x-stats-token": "secret-token",
    });

    assert.strictEqual(authorized.statusCode, 200, "Expected /api/stats with token to succeed");
    assert.strictEqual(authorized.body.ok, true, "Expected ok=true in stats response");
    assert.strictEqual(typeof authorized.body.version, "string", "version missing in stats response");
    assert.strictEqual(typeof authorized.body.nodeId, "string", "nodeId missing in stats response");
    assert.strictEqual(typeof authorized.body.uptimeSec, "number", "uptimeSec missing");
    assert(Array.isArray(authorized.body.configWarnings), "configWarnings missing in stats response");
    assert(authorized.body.counters, "counters missing");

    console.log("PASS stats smoke: auth + shape");
  } finally {
    server.kill();
    await delay(200);

    if (stderr.trim()) {
      console.error(stderr.trim());
    }

    if (!stdout.includes("Server is running")) {
      throw new Error("Server did not start correctly in stats test run");
    }
  }
}

run().catch((error) => {
  console.error("FAIL stats smoke:", error.message);
  process.exit(1);
});
