const { createServerRuntime } = require('../../src/server-runtime.js');

function withEnv(overrides) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    previous[key] = process.env[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function startTestServer(overrides = {}) {
  const restoreEnv = withEnv(overrides);
  const runtime = createServerRuntime();

  try {
    await runtime.start();
  } catch (error) {
    restoreEnv();
    throw error;
  }

  return {
    runtime,
    async stop() {
      try {
        await runtime.stop();
      } finally {
        restoreEnv();
      }
    },
  };
}

module.exports = {
  startTestServer,
};
