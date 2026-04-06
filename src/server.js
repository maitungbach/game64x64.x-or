const { createServerRuntime } = require('./server-runtime.js');

const runtime = createServerRuntime();

runtime.start().catch((error) => {
  if (Array.isArray(error?.fatalErrors)) {
    for (const fatalError of error.fatalErrors) {
      console.error(`[startup-config] ${fatalError}`);
    }
  } else {
    console.error('[startup] failed:', error);
  }
  process.exit(1);
});
