const assert = require('assert');
const { createRuntimeConfig } = require('../src/core/runtime/runtime-config.js');
const packageJson = require('../package.json');

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function run() {
  const fatalErrors = withEnv(
    {
      PORT: '3199',
      NODE_ENV: 'production',
      ENABLE_REDIS: 'true',
      AUTH_REQUIRE_MONGO: 'true',
      REDIS_URL: 'redis://127.0.0.1:6379',
      MONGO_URL: 'mongodb://127.0.0.1:37018',
      STRICT_CLUSTER_CONFIG: 'true',
    },
    () => createRuntimeConfig(packageJson).getConfigFatalErrors()
  );

  assert(Array.isArray(fatalErrors), 'Expected fatal errors array');
  assert(
    fatalErrors.some((message) => message.includes('loopback REDIS_URL')),
    'Expected REDIS_URL loopback guard to trigger'
  );
  assert(
    fatalErrors.some((message) => message.includes('loopback MONGO_URL')),
    'Expected MONGO_URL loopback guard to trigger'
  );

  console.log('PASS config guard: production cluster loopback config rejected');
}

try {
  run();
} catch (error) {
  console.error('FAIL config guard:', error.message);
  process.exit(1);
}
