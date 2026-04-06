/* eslint-disable no-console */
const { registerAuthRoutes } = require('./routes/auth-routes.js');
const { registerSystemRoutes } = require('./routes/system-routes.js');

function registerAppRoutes(deps) {
  const {
    app,
    express,
    path,
    PUBLIC_DIR,
    asyncRoute,
    stats,
    config,
    auth,
    game,
    getAdminAuthContextFromRequest,
    isStatsAuthorized,
    getStatsSnapshot,
  } = deps;

  function isApiRoute(pathname) {
    return String(pathname || '').startsWith('/api/');
  }

  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    const route = String(req.path || '').toLowerCase();
    if (
      route.endsWith('.html') ||
      route === '/' ||
      route === '/auth' ||
      route === '/game' ||
      route === '/admin'
    ) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  app.get('/', (_req, res) => {
    res.redirect(302, '/auth.html');
  });
  app.get('/index.html', (_req, res) => {
    res.redirect(302, '/auth.html');
  });

  async function handleAdminPage(req, res) {
    const authContext = await auth.getAuthenticatedUserFromRequest(req);
    if (!authContext) {
      auth.clearAuthCookie(res);
      res.redirect(302, '/auth.html?next=%2Fadmin');
      return;
    }

    if (!(await getAdminAuthContextFromRequest(req))) {
      res.status(403).send('Admin access required');
      return;
    }

    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  }

  app.get('/admin', asyncRoute(handleAdminPage));
  app.get('/admin.html', asyncRoute(handleAdminPage));

  app.use(express.static(PUBLIC_DIR));

  registerAuthRoutes({ app, asyncRoute, config, auth });
  registerSystemRoutes({
    app,
    asyncRoute,
    config,
    auth,
    game,
    getAdminAuthContextFromRequest,
    isStatsAuthorized,
    getStatsSnapshot,
  });

  app.get('*', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    stats.errorsTotal += 1;
    console.error('[http] failed:', error);

    if (isApiRoute(req.path)) {
      res.status(500).json({ ok: false, message: 'Internal server error' });
      return;
    }

    res.status(500).send('Internal server error');
  });
}

module.exports = {
  registerAppRoutes,
};
