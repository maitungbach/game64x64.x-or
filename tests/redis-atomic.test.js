const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");
const { createClient } = require("redis");
const { io } = require("socket.io-client");

const TEST_PORT = 3103;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const SERVER_PATH = path.join(__dirname, "..", "src", "server.js");
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const REDIS_PLAYERS_KEY = `test:game64x64:players:${Date.now()}`;
const REDIS_CELLS_KEY = `test:game64x64:cells:${Date.now()}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.status === 200) {
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

function connectClient() {
  return io(BASE_URL, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 4000,
  });
}

async function main() {
  const redis = createClient({ url: REDIS_URL });
  try {
    await redis.connect();
    await redis.ping();
  } catch (_error) {
    console.log("SKIP redis atomic: Redis is not available on", REDIS_URL);
    process.exit(0);
  } finally {
    try {
      await redis.disconnect();
    } catch (_error) {
      // ignore
    }
  }

  const server = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      ENABLE_REDIS: "true",
      AUTH_REQUIRED: "false",
      REDIS_URL,
      REDIS_PLAYERS_KEY,
      REDIS_CELLS_KEY,
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

  const sockets = [];
  let duplicateDetected = false;

  try {
    await waitForServerReady();

    for (let i = 0; i < 30; i += 1) {
      const socket = connectClient();
      socket.on("updatePlayers", (players) => {
        const list = Array.isArray(players) ? players : [];
        const cells = new Set(list.map((p) => `${p.x}:${p.y}`));
        if (cells.size !== list.length) {
          duplicateDetected = true;
        }
      });
      sockets.push(socket);
    }

    await delay(2000);

    const dirs = ["up", "down", "left", "right"];
    for (let tick = 0; tick < 40; tick += 1) {
      for (const socket of sockets) {
        if (!socket.connected) {
          continue;
        }
        const direction = dirs[Math.floor(Math.random() * dirs.length)];
        socket.emit("move", { direction });
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(35);
    }

    await delay(1000);

    assert.strictEqual(duplicateDetected, false, "Detected duplicate cell occupancy in updates");

    const verifyRedis = createClient({ url: REDIS_URL });
    await verifyRedis.connect();
    const playersCount = await verifyRedis.hLen(REDIS_PLAYERS_KEY);
    const cellsCount = await verifyRedis.hLen(REDIS_CELLS_KEY);
    await verifyRedis.del(REDIS_PLAYERS_KEY, REDIS_CELLS_KEY);
    await verifyRedis.disconnect();

    assert.strictEqual(playersCount, cellsCount, "Redis players/cells index mismatch");
    console.log("PASS redis atomic: no duplicate occupancy + consistent redis indexes");
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }

    server.kill();
    await delay(250);

    if (stderr.trim()) {
      console.error(stderr.trim());
    }
    if (!stdout.includes("Server is running")) {
      throw new Error("Server did not start correctly in redis atomic test");
    }
  }
}

main().catch((error) => {
  console.error("FAIL redis atomic:", error.message);
  process.exit(1);
});
