const http = require('http');
const assert = require('assert');
const { startTestServer } = require('./helpers/server-harness.js');

const TEST_PORT = 3102;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body || '{}');
        } catch (_error) {
          parsed = null;
        }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
  });
}

async function run() {
  const serverHandle = await startTestServer({
    PORT: String(TEST_PORT),
    NODE_ENV: 'test',
    ENABLE_REDIS: 'false',
    STATS_TOKEN: 'secret-token',
    AUTH_REQUIRED: 'false',
    AUTH_REQUIRE_MONGO: 'false',
    STRICT_CLUSTER_CONFIG: 'false',
    MONGO_URL: '',
  });

  try {
    const health = await requestJson(`${BASE_URL}/health`);
    assert.strictEqual(health.statusCode, 200, 'Expected /health to succeed');
    assert.strictEqual(health.body.ok, true, 'Expected ok=true in health response');

    const healthUnauthorized = await requestJson(`${BASE_URL}/api/health`);
    assert.strictEqual(
      healthUnauthorized.statusCode,
      401,
      'Expected /api/health unauthorized without admin session'
    );

    const unauthorized = await requestJson(`${BASE_URL}/api/stats`);
    assert.strictEqual(
      unauthorized.statusCode,
      401,
      'Expected /api/stats unauthorized without token'
    );

    const authorized = await requestJson(`${BASE_URL}/api/stats`, {
      'x-stats-token': 'secret-token',
    });

    assert.strictEqual(authorized.statusCode, 200, 'Expected /api/stats with token to succeed');
    assert.strictEqual(authorized.body.ok, true, 'Expected ok=true in stats response');
    assert.strictEqual(
      typeof authorized.body.version,
      'string',
      'version missing in stats response'
    );
    assert.strictEqual(typeof authorized.body.nodeId, 'string', 'nodeId missing in stats response');
    assert.strictEqual(typeof authorized.body.uptimeSec, 'number', 'uptimeSec missing');
    assert(
      Array.isArray(authorized.body.configWarnings),
      'configWarnings missing in stats response'
    );
    assert(authorized.body.counters, 'counters missing');

    console.log('PASS stats smoke: auth + shape');
  } finally {
    await serverHandle.stop();
  }
}

run().catch((error) => {
  console.error('FAIL stats smoke:', error.message);
  process.exit(1);
});
