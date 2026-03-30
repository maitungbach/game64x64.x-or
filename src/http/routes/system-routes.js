function registerSystemRoutes(deps) {
  const { app, asyncRoute, config, auth, game, isStatsAuthorized, getStatsSnapshot } = deps;

  async function handleHealth(_req, res) {
    const list = await game.getPlayersList();
    res.json({
      ok: true,
      version: config.APP_VERSION,
      nodeId: config.NODE_ID,
      startedAt: config.STARTED_AT,
      players: list.length,
      redisEnabled: config.ENABLE_REDIS,
      authStorage: auth.getAuthStorageMode(),
      mongoConnected: auth.isMongoConnected(),
      configWarnings: config.getConfigWarnings(),
    });
  }

  async function handleStats(req, res) {
    if (!isStatsAuthorized(req)) {
      res.status(401).json({ ok: false, message: 'Unauthorized' });
      return;
    }

    const list = await game.getPlayersList();
    res.json({
      ok: true,
      ...getStatsSnapshot(list.length),
    });
  }

  async function handleDebugUserLookup(req, res) {
    if (!isStatsAuthorized(req)) {
      res.status(401).json({ ok: false, message: 'Unauthorized' });
      return;
    }

    const email = auth.normalizeEmail(req.query?.email);
    if (!email) {
      res.status(400).json({ ok: false, message: 'Missing email query param' });
      return;
    }

    const user = await auth.getUserByEmail(email);
    res.json({
      ok: true,
      lookupEmail: email,
      nodeId: config.NODE_ID,
      authStorage: auth.getAuthStorageMode(),
      mongoConnected: auth.isMongoConnected(),
      mongoUrl: config.getRedactedMongoUrl(),
      found: Boolean(user),
      user: user ? auth.toPublicUser(user) : null,
    });
  }

  app.get('/health', asyncRoute(handleHealth));
  app.get('/api/health', asyncRoute(handleHealth));
  app.get('/stats', asyncRoute(handleStats));
  app.get('/api/stats', asyncRoute(handleStats));
  app.get('/api/debug/user-by-email', asyncRoute(handleDebugUserLookup));
}

module.exports = {
  registerSystemRoutes,
};
