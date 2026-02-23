const http = require("http");
const { io } = require("socket.io-client");

function parseArgs(argv) {
  const out = {
    url: "http://127.0.0.1:3000",
    clients: 20,
    durationSec: 20,
    movesPerSec: 4,
    statsToken: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--url" && next) {
      out.url = next;
      i += 1;
    } else if (arg === "--clients" && next) {
      out.clients = Number(next);
      i += 1;
    } else if (arg === "--duration" && next) {
      out.durationSec = Number(next);
      i += 1;
    } else if (arg === "--moves" && next) {
      out.movesPerSec = Number(next);
      i += 1;
    } else if (arg === "--token" && next) {
      out.statsToken = next;
      i += 1;
    }
  }

  return out;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        } catch (_error) {
          resolve({ statusCode: res.statusCode, body: null });
        }
      });
    });
    req.on("error", reject);
  });
}

async function waitForHealth(url) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetchJson(`${url}/api/health`);
      if (res.statusCode === 200 && res.body && res.body.ok) {
        return;
      }
    } catch (_error) {
      // retry
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(200);
  }
  throw new Error("Healthcheck timeout");
}

async function run() {
  const config = parseArgs(process.argv.slice(2));
  const dirs = ["up", "down", "left", "right"];
  const sockets = [];
  const moveIntervals = [];
  let connected = 0;
  let updatesReceived = 0;
  let movesSent = 0;

  await waitForHealth(config.url);

  for (let i = 0; i < config.clients; i += 1) {
    const socket = io(config.url, {
      transports: ["websocket"],
      reconnection: false,
      timeout: 5000,
    });

    socket.on("connect", () => {
      connected += 1;
    });

    socket.on("updatePlayers", () => {
      updatesReceived += 1;
    });

    sockets.push(socket);
  }

  const moveIntervalMs = Math.max(20, Math.floor(1000 / Math.max(1, config.movesPerSec)));

  for (const socket of sockets) {
    const timer = setInterval(() => {
      if (socket.connected) {
        const direction = dirs[Math.floor(Math.random() * dirs.length)];
        socket.emit("move", { direction });
        movesSent += 1;
      }
    }, moveIntervalMs);
    moveIntervals.push(timer);
  }

  console.log(`Load test started: clients=${config.clients}, duration=${config.durationSec}s, movesPerSec/client=${config.movesPerSec}`);
  await delay(config.durationSec * 1000);

  for (const timer of moveIntervals) {
    clearInterval(timer);
  }

  for (const socket of sockets) {
    socket.disconnect();
  }

  await delay(300);

  const statsHeaders = config.statsToken ? { "x-stats-token": config.statsToken } : {};
  const statsRes = await fetchJson(`${config.url}/api/stats`, statsHeaders);

  console.log("--- Load test summary ---");
  console.log(`Connected clients: ${connected}/${config.clients}`);
  console.log(`Moves sent: ${movesSent}`);
  console.log(`updatePlayers events received: ${updatesReceived}`);

  if (statsRes.statusCode === 200 && statsRes.body && statsRes.body.counters) {
    const c = statsRes.body.counters;
    console.log("Server counters:");
    console.log(`- movesReceived: ${c.movesReceived}`);
    console.log(`- movesApplied: ${c.movesApplied}`);
    console.log(`- movesRejectedRateLimit: ${c.movesRejectedRateLimit}`);
    console.log(`- broadcastRequestsTotal: ${c.broadcastRequestsTotal}`);
    console.log(`- broadcastsEmitted: ${c.broadcastsEmitted}`);
    console.log(`- broadcastsCoalesced: ${c.broadcastsCoalesced}`);
  } else {
    console.log(`Unable to fetch /api/stats (status=${statsRes.statusCode}). Provide --token if protected.`);
  }
}

run().catch((error) => {
  console.error("Load test failed:", error.message);
  process.exit(1);
});
