function registerSystemRoutes(deps) {
  const {
    app,
    asyncRoute,
    config,
    auth,
    game,
    getAdminAuthContextFromRequest,
    isStatsAuthorized,
    getStatsSnapshot,
  } = deps;

  async function requireAdminApiAuth(req, res) {
    const authContext = await getAdminAuthContextFromRequest(req);
    if (!authContext) {
      const hasSession = Boolean(await auth.getAuthenticatedUserFromRequest(req));
      if (!hasSession) {
        auth.clearAuthCookie(res);
        res.status(401).json({ ok: false, message: 'Unauthorized' });
        return null;
      }

      res.status(403).json({ ok: false, message: 'Admin access required' });
      return null;
    }

    return authContext;
  }

  function createHealthSnapshot(playersCount) {
    return {
      ok: true,
      version: config.APP_VERSION,
      nodeId: config.NODE_ID,
      startedAt: config.STARTED_AT,
      players: playersCount,
      redisEnabled: config.ENABLE_REDIS,
      authStorage: auth.getAuthStorageMode(),
      mongoConnected: auth.isMongoConnected(),
      configWarnings: config.getConfigWarnings(),
    };
  }

  async function handleLiveness(_req, res) {
    res.json({ ok: true });
  }

  async function handleAdminHealth(req, res) {
    const authContext = await requireAdminApiAuth(req, res);
    if (!authContext) {
      return;
    }

    const list = await game.getPlayersList();
    res.json(createHealthSnapshot(list.length));
  }

  async function handleAdminDashboard(req, res) {
    const authContext = await requireAdminApiAuth(req, res);
    if (!authContext) {
      return;
    }

    const list = await game.getPlayersList();
    res.json({
      ok: true,
      health: createHealthSnapshot(list.length),
      stats: {
        ok: true,
        ...getStatsSnapshot(list.length),
      },
    });
  }

  async function handleStats(req, res) {
    if (!(await isStatsAuthorized(req))) {
      res.status(401).json({ ok: false, message: 'Unauthorized' });
      return;
    }

    const list = await game.getPlayersList();
    res.json({
      ok: true,
      ...getStatsSnapshot(list.length),
    });
  }

  async function handleAdminUserLookup(req, res) {
    const authContext = await requireAdminApiAuth(req, res);
    if (!authContext) {
      return;
    }

    const email = auth.normalizeEmail(req.query?.email);
    if (!email) {
      res.status(400).json({ ok: false, message: 'Missing email query param' });
      return;
    }

    const user = await auth.getUserByEmail(email);
    const activeSessions = user
      ? (await auth.listActiveSessionsForUser(user.id)).map((session) => auth.toPublicSession(session))
      : [];

    res.json({
      ok: true,
      lookupEmail: email,
      nodeId: config.NODE_ID,
      authStorage: auth.getAuthStorageMode(),
      mongoConnected: auth.isMongoConnected(),
      found: Boolean(user),
      user: user ? auth.toPublicUser(user) : null,
      activeSessions,
      sessionSummary: {
        count: activeSessions.length,
      },
      requestedBy: auth.toPublicUser(authContext.user),
    });
  }

  async function handleAdminUserSessionRevoke(req, res) {
    const authContext = await requireAdminApiAuth(req, res);
    if (!authContext) {
      return;
    }
    if (!auth.isTrustedCsrfRequest(req)) {
      res.status(403).json({ ok: false, message: 'Untrusted request origin' });
      return;
    }

    const email = auth.normalizeEmail(req.body?.email);
    const userId = String(req.body?.userId || '').trim();
    let user = null;
    if (email) {
      user = await auth.getUserByEmail(email);
    } else if (userId) {
      user = await auth.getUserById(userId);
    } else {
      res.status(400).json({ ok: false, message: 'Missing email or userId' });
      return;
    }

    if (!user) {
      res.status(404).json({ ok: false, message: 'User not found' });
      return;
    }

    const revoked = await auth.revokeSessionsForUser(user.id);
    const revokedSelf = user.id === authContext.user.id;
    if (revokedSelf) {
      auth.clearAuthCookie(res);
    }

    res.json({
      ok: true,
      user: auth.toPublicUser(user),
      revokedCount: revoked.revokedCount,
      disconnectedSockets: revoked.disconnectedSockets,
      revokedSelf,
    });
  }

  async function handleListRooms(_req, res) {
    res.json({ ok: true, rooms: game.listRooms() });
  }

  async function handleCreateRoom(req, res) {
    const authContext = await auth.getAuthenticatedUserFromRequest(req);
    if (!authContext) {
      res.status(401).json({ ok: false, message: 'Unauthorized' });
      return;
    }
    if (!auth.isTrustedCsrfRequest(req)) {
      res.status(403).json({ ok: false, message: 'Untrusted request origin' });
      return;
    }

    const room = game.createRoom(authContext.user.id, req.body);
    res.json({ ok: true, room: { id: room.id, name: room.name, maxPlayers: room.maxPlayers, status: room.status } });
  }

  async function handleJoinRoom(req, res) {
    const authContext = await auth.getAuthenticatedUserFromRequest(req);
    if (!authContext) {
      res.status(401).json({ ok: false, message: 'Unauthorized' });
      return;
    }

    const roomId = String(req.params.roomId || '').toUpperCase();
    if (!roomId) {
      res.status(400).json({ ok: false, message: 'Missing roomId' });
      return;
    }

    const result = game.joinRoom(roomId, authContext.user.id);
    res.json(result);
  }

  async function handleLeaveRoom(req, res) {
    const authContext = await auth.getAuthenticatedUserFromRequest(req);
    if (!authContext) {
      res.status(401).json({ ok: false, message: 'Unauthorized' });
      return;
    }

    const roomId = String(req.params.roomId || '').toUpperCase();
    if (!roomId) {
      res.status(400).json({ ok: false, message: 'Missing roomId' });
      return;
    }

    const result = game.leaveRoom(roomId, authContext.user.id);
    res.json(result);
  }

  async function handleStartRoom(req, res) {
    const authContext = await auth.getAuthenticatedUserFromRequest(req);
    if (!authContext) {
      res.status(401).json({ ok: false, message: 'Unauthorized' });
      return;
    }
    if (!auth.isTrustedCsrfRequest(req)) {
      res.status(403).json({ ok: false, message: 'Untrusted request origin' });
      return;
    }

    const roomId = String(req.params.roomId || '').toUpperCase();
    if (!roomId) {
      res.status(400).json({ ok: false, message: 'Missing roomId' });
      return;
    }

    const room = game.getRoomById(roomId);
    if (!room || room.hostId !== authContext.user.id) {
      res.status(403).json({ ok: false, message: 'Only host can start the game' });
      return;
    }

    const result = game.startRoomGame(roomId);
    res.json(result);
  }

  async function handleRoomLeaderboard(req, res) {
    const roomId = String(req.params.roomId || '').toUpperCase();
    if (!roomId) {
      res.status(400).json({ ok: false, message: 'Missing roomId' });
      return;
    }

    const leaderboard = game.getRoomLeaderboard(roomId);
    res.json({ ok: true, leaderboard });
  }

  app.get('/health', asyncRoute(handleLiveness));
  app.get('/api/health', asyncRoute(handleAdminHealth));
  app.get('/api/admin/dashboard', asyncRoute(handleAdminDashboard));
  app.get('/stats', asyncRoute(handleStats));
  app.get('/api/stats', asyncRoute(handleStats));
  app.get('/api/admin/user-by-email', asyncRoute(handleAdminUserLookup));
  app.post('/api/admin/user/revoke-sessions', asyncRoute(handleAdminUserSessionRevoke));
  app.get('/api/rooms', asyncRoute(handleListRooms));
  app.post('/api/rooms', asyncRoute(handleCreateRoom));
  app.post('/api/rooms/:roomId/join', asyncRoute(handleJoinRoom));
  app.post('/api/rooms/:roomId/leave', asyncRoute(handleLeaveRoom));
  app.post('/api/rooms/:roomId/start', asyncRoute(handleStartRoom));
  app.get('/api/rooms/:roomId/leaderboard', asyncRoute(handleRoomLeaderboard));
}

module.exports = {
  registerSystemRoutes,
};
