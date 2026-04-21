const { createServerRuntime } = require('./server-runtime.js');

const runtime = createServerRuntime();

async function main() {
  try {
    await runtime.start();
    console.log(`[main] Server ready at http://localhost:${runtime.config.PORT}`);
  } catch (error) {
    if (Array.isArray(error?.fatalErrors)) {
      for (const fatalError of error.fatalErrors) {
        console.error(`[startup-config] ${fatalError}`);
      }
    } else {
      console.error('[startup] failed:', error);
    }
    process.exit(1);
  }
}

main();
