const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((acc, rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        return acc;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        return acc;
      }

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      acc[key] = value;
      return acc;
    }, {});
}

const fileEnv = loadEnvFile(path.join(__dirname, "..", ".env"));

function getEnv(name, fallback) {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    return process.env[name];
  }
  if (Object.prototype.hasOwnProperty.call(fileEnv, name)) {
    return fileEnv[name];
  }
  return fallback;
}

module.exports = {
  apps: [
    {
      name: "game64x64",
      script: "src/server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: getEnv("NODE_ENV", "production"),
        PORT: getEnv("PORT", "3000"),
        ENABLE_REDIS: getEnv("ENABLE_REDIS", "true"),
        REDIS_URL: getEnv("REDIS_URL", "redis://127.0.0.1:6379"),
        MONGO_URL: getEnv("MONGO_URL", "mongodb://127.0.0.1:37018"),
        MONGO_DB_NAME: getEnv("MONGO_DB_NAME", "game64x64"),
        REDIS_PLAYERS_KEY: getEnv("REDIS_PLAYERS_KEY", "game64x64:players"),
        REDIS_USERS_KEY: getEnv("REDIS_USERS_KEY", "game64x64:users"),
        REDIS_SESSION_PREFIX: getEnv("REDIS_SESSION_PREFIX", "game64x64:session:"),
        REDIS_USER_SESSION_PREFIX: getEnv("REDIS_USER_SESSION_PREFIX", "game64x64:user-session:"),
        MOVE_INTERVAL_MS: getEnv("MOVE_INTERVAL_MS", "16"),
        SNAPSHOT_INTERVAL_MS: getEnv("SNAPSHOT_INTERVAL_MS", "250"),
        AUTH_COOKIE_SECURE: getEnv("AUTH_COOKIE_SECURE", "true"),
        AUTH_SESSION_TTL_SEC: getEnv("AUTH_SESSION_TTL_SEC", "86400"),
        TRUST_PROXY: getEnv("TRUST_PROXY", "false"),
        ALLOW_LOOPBACK_MONGO_TUNNEL: getEnv("ALLOW_LOOPBACK_MONGO_TUNNEL", "true"),
        AUTH_REQUIRE_MONGO: getEnv("AUTH_REQUIRE_MONGO", "true"),
        AUTH_REJECT_CONCURRENT: getEnv("AUTH_REJECT_CONCURRENT", "true"),
        AUTH_SEED_TEST_USERS: getEnv("AUTH_SEED_TEST_USERS", "false"),
        AUTH_ALLOW_CONCURRENT_SEED_USERS: getEnv("AUTH_ALLOW_CONCURRENT_SEED_USERS", "false"),
      },
      max_memory_restart: "300M",
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      autorestart: true,
    },
  ],
};
