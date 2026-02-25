module.exports = {
  apps: [
    {
      name: "game64x64",
      script: "src/server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        ENABLE_REDIS: "false",
        REDIS_URL: "redis://127.0.0.1:6379",
        REDIS_PLAYERS_KEY: "game64x64:players",
        MOVE_INTERVAL_MS: "16",
        SNAPSHOT_INTERVAL_MS: "250",
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
