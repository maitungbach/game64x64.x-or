const os = require('os');

function createRuntimeConfig(packageJson) {
  const PORT = Number(process.env.PORT || 3000);
  const GRID_SIZE = 64;
  const MAX_SPAWN_ATTEMPTS = 500;
  const MOVE_INTERVAL_MS = Number(process.env.MOVE_INTERVAL_MS || 16);
  const BROADCAST_INTERVAL_MS = Number(process.env.BROADCAST_INTERVAL_MS || 33);
  const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS || 250);
  const GHOST_SWEEP_INTERVAL_MS = Number(process.env.GHOST_SWEEP_INTERVAL_MS || 15000);
  const AUTH_RELEASE_DELAY_MS = Number(process.env.AUTH_RELEASE_DELAY_MS || 12000);

  const ENABLE_REDIS = String(process.env.ENABLE_REDIS || 'false') === 'true';
  const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const REDIS_PLAYERS_KEY = process.env.REDIS_PLAYERS_KEY || 'game64x64:players';
  const REDIS_CELLS_KEY = process.env.REDIS_CELLS_KEY || 'game64x64:cells';
  const REDIS_USERS_KEY = process.env.REDIS_USERS_KEY || 'game64x64:users';
  const REDIS_SESSION_PREFIX = process.env.REDIS_SESSION_PREFIX || 'game64x64:session:';
  const REDIS_USER_SESSION_PREFIX =
    process.env.REDIS_USER_SESSION_PREFIX || 'game64x64:user-session:';
  const MONGO_URL = process.env.MONGO_URL || '';
  const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'game64x64';
  const STATS_TOKEN = process.env.STATS_TOKEN || '';
  const STARTED_AT = new Date().toISOString();
  const APP_VERSION = String(process.env.APP_VERSION || packageJson.version || '0.0.0');
  const NODE_ID = String(process.env.NODE_ID || os.hostname() || `node-${process.pid}`);
  const STRICT_CLUSTER_CONFIG = String(process.env.STRICT_CLUSTER_CONFIG || 'true') === 'true';
  const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'game64x64_session';
  const AUTH_COOKIE_SECURE = String(process.env.AUTH_COOKIE_SECURE || 'false') === 'true';
  const AUTH_SESSION_TTL_SEC = Number(process.env.AUTH_SESSION_TTL_SEC || 86400);
  const AUTH_LOGIN_FAIL_RATE_LIMIT_MAX = Number(process.env.AUTH_LOGIN_FAIL_RATE_LIMIT_MAX || 10);
  const AUTH_LOGIN_FAIL_RATE_LIMIT_WINDOW_SEC = Number(
    process.env.AUTH_LOGIN_FAIL_RATE_LIMIT_WINDOW_SEC || 300
  );
  const AUTH_REGISTER_RATE_LIMIT_MAX = Number(process.env.AUTH_REGISTER_RATE_LIMIT_MAX || 15);
  const AUTH_REGISTER_RATE_LIMIT_WINDOW_SEC = Number(
    process.env.AUTH_REGISTER_RATE_LIMIT_WINDOW_SEC || 600
  );
  const AUTH_REQUIRE_MONGO = String(process.env.AUTH_REQUIRE_MONGO || 'false') === 'true';
  const AUTH_REJECT_CONCURRENT = String(process.env.AUTH_REJECT_CONCURRENT || 'true') === 'true';
  const AUTH_SEED_TEST_USERS = String(process.env.AUTH_SEED_TEST_USERS || 'false') === 'true';
  const AUTH_ALLOW_CONCURRENT_SEED_USERS =
    String(process.env.AUTH_ALLOW_CONCURRENT_SEED_USERS || 'true') === 'true';
  const AUTH_REQUIRED = String(process.env.AUTH_REQUIRED || 'true') === 'true';
  const ALLOW_LOOPBACK_MONGO_TUNNEL =
    String(process.env.ALLOW_LOOPBACK_MONGO_TUNNEL || 'false') === 'true';
  const AUTH_DEFAULT_PASSWORD_MIN = 6;
  const AUTH_DEFAULT_NAME_MAX = 24;
  const AUTH_DEFAULT_NAME_MIN = 2;

  function isLoopbackHost(hostname) {
    const raw = String(hostname || '')
      .trim()
      .toLowerCase();
    if (!raw) {
      return false;
    }
    return (
      raw === 'localhost' ||
      raw === '::1' ||
      raw === '[::1]' ||
      raw === '127.0.0.1' ||
      raw.startsWith('127.')
    );
  }

  function getMongoHosts(mongoUrl) {
    const raw = String(mongoUrl || '').trim();
    if (!raw) {
      return [];
    }

    const match = raw.match(/^mongodb(?:\+srv)?:\/\/([^/?]+)/i);
    if (!match) {
      return [];
    }

    const authority = match[1];
    const hostList = authority.includes('@') ? authority.split('@').slice(-1)[0] : authority;

    return hostList
      .split(',')
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .map((entry) => {
        if (entry.startsWith('[')) {
          const closingIndex = entry.indexOf(']');
          return closingIndex >= 0 ? entry.slice(1, closingIndex) : entry;
        }
        return entry.split(':')[0];
      });
  }

  function isLoopbackMongoUrl(mongoUrl) {
    return getMongoHosts(mongoUrl).some(isLoopbackHost);
  }

  function isLoopbackRedisUrl(redisUrl) {
    try {
      const parsed = new URL(redisUrl);
      return isLoopbackHost(parsed.hostname);
    } catch (_error) {
      return false;
    }
  }

  function getConfigWarnings() {
    const warnings = [];
    if (ENABLE_REDIS && isLoopbackRedisUrl(REDIS_URL)) {
      warnings.push('Redis is enabled but REDIS_URL points to a loopback host.');
    }
    if (
      ENABLE_REDIS &&
      AUTH_REQUIRE_MONGO &&
      isLoopbackMongoUrl(MONGO_URL) &&
      !ALLOW_LOOPBACK_MONGO_TUNNEL
    ) {
      warnings.push('Cluster mode is enabled but MONGO_URL points to a loopback host.');
    }
    if (AUTH_REQUIRE_MONGO && !MONGO_URL) {
      warnings.push('AUTH_REQUIRE_MONGO is true but MONGO_URL is empty.');
    }
    return warnings;
  }

  function getConfigFatalErrors() {
    if (!STRICT_CLUSTER_CONFIG || process.env.NODE_ENV !== 'production') {
      return [];
    }

    const errors = [];
    if (ENABLE_REDIS && isLoopbackRedisUrl(REDIS_URL)) {
      errors.push('Cluster mode in production cannot use a loopback REDIS_URL.');
    }
    if (
      ENABLE_REDIS &&
      AUTH_REQUIRE_MONGO &&
      isLoopbackMongoUrl(MONGO_URL) &&
      !ALLOW_LOOPBACK_MONGO_TUNNEL
    ) {
      errors.push('Cluster mode in production cannot use a loopback MONGO_URL.');
    }
    if (AUTH_REQUIRE_MONGO && !MONGO_URL) {
      errors.push('Production auth requires MONGO_URL when AUTH_REQUIRE_MONGO=true.');
    }
    return errors;
  }

  function getRedactedMongoUrl() {
    if (!MONGO_URL) {
      return '';
    }

    try {
      const parsed = new URL(MONGO_URL);
      const authPrefix = parsed.username ? `${parsed.username}:***@` : '';
      const pathname = parsed.pathname || '';
      return `${parsed.protocol}//${authPrefix}${parsed.host}${pathname}`;
    } catch (_error) {
      return MONGO_URL;
    }
  }

  return {
    PORT,
    GRID_SIZE,
    MAX_SPAWN_ATTEMPTS,
    MOVE_INTERVAL_MS,
    BROADCAST_INTERVAL_MS,
    SNAPSHOT_INTERVAL_MS,
    GHOST_SWEEP_INTERVAL_MS,
    AUTH_RELEASE_DELAY_MS,
    ENABLE_REDIS,
    REDIS_URL,
    REDIS_PLAYERS_KEY,
    REDIS_CELLS_KEY,
    REDIS_USERS_KEY,
    REDIS_SESSION_PREFIX,
    REDIS_USER_SESSION_PREFIX,
    MONGO_URL,
    MONGO_DB_NAME,
    STATS_TOKEN,
    STARTED_AT,
    APP_VERSION,
    NODE_ID,
    STRICT_CLUSTER_CONFIG,
    AUTH_COOKIE_NAME,
    AUTH_COOKIE_SECURE,
    AUTH_SESSION_TTL_SEC,
    AUTH_LOGIN_FAIL_RATE_LIMIT_MAX,
    AUTH_LOGIN_FAIL_RATE_LIMIT_WINDOW_SEC,
    AUTH_REGISTER_RATE_LIMIT_MAX,
    AUTH_REGISTER_RATE_LIMIT_WINDOW_SEC,
    AUTH_REQUIRE_MONGO,
    AUTH_REJECT_CONCURRENT,
    AUTH_SEED_TEST_USERS,
    AUTH_ALLOW_CONCURRENT_SEED_USERS,
    AUTH_REQUIRED,
    ALLOW_LOOPBACK_MONGO_TUNNEL,
    AUTH_DEFAULT_PASSWORD_MIN,
    AUTH_DEFAULT_NAME_MAX,
    AUTH_DEFAULT_NAME_MIN,
    getConfigWarnings,
    getConfigFatalErrors,
    getRedactedMongoUrl,
  };
}

module.exports = {
  createRuntimeConfig,
};
