const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");

const SERVER_PATH = path.join(__dirname, "..", "src", "server.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(server, timeoutMs = 6000) {
  if (server.exitCode !== null) {
    return Promise.resolve(server.exitCode);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Config guard test timed out"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      server.off("error", onError);
      server.off("exit", onExit);
      server.off("close", onClose);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onExit(code) {
      cleanup();
      resolve(code);
    }

    function onClose(code) {
      cleanup();
      resolve(code);
    }

    server.once("error", onError);
    server.once("exit", onExit);
    server.once("close", onClose);
  });
}

async function run() {
  const server = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: "3199",
      NODE_ENV: "production",
      ENABLE_REDIS: "true",
      AUTH_REQUIRE_MONGO: "true",
      REDIS_URL: "redis://127.0.0.1:6379",
      MONGO_URL: "mongodb://127.0.0.1:37018",
      STRICT_CLUSTER_CONFIG: "true",
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

  const exitCode = await waitForExit(server);

  await delay(100);

  assert.notStrictEqual(exitCode, 0, "Server should fail startup for invalid production cluster config");
  assert(stderr.includes("[startup-config]"), "Expected startup-config error in stderr");
  assert(stderr.includes("loopback REDIS_URL"), "Expected REDIS_URL loopback guard to trigger");
  assert(stderr.includes("loopback MONGO_URL"), "Expected MONGO_URL loopback guard to trigger");
  assert(!stdout.includes("Server is running"), "Server should not start when config guard fails");

  console.log("PASS config guard: production cluster loopback config rejected");
}

run().catch((error) => {
  console.error("FAIL config guard:", error.message);
  process.exit(1);
});
