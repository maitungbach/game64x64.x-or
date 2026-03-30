/* eslint-disable no-console */
function registerAuthRoutes(deps) {
  const { app, asyncRoute, config, auth } = deps;

  app.post(
    '/api/auth/register',
    asyncRoute(async (req, res) => {
      const clientIp = auth.getRequestIp(req);
      const registerRateKey = clientIp;
      if (config.AUTH_REGISTER_RATE_LIMIT_MAX > 0) {
        const currentLimit = await auth.getAuthRateLimitState(
          'register',
          registerRateKey,
          config.AUTH_REGISTER_RATE_LIMIT_WINDOW_SEC
        );
        if (currentLimit.count >= config.AUTH_REGISTER_RATE_LIMIT_MAX) {
          console.warn(
            `[auth-register] rate_limited ip=${clientIp} retryAfter=${currentLimit.retryAfterSec}s stage=precheck`
          );
          auth.setRetryAfter(res, currentLimit.retryAfterSec);
          res.status(429).json({ ok: false, message: 'Too many register attempts' });
          return;
        }
      }

      const name = auth.normalizeDisplayName(req.body?.name);
      const email = auth.normalizeEmail(req.body?.email);
      const password = String(req.body?.password || '');

      if (
        !name ||
        name.length < config.AUTH_DEFAULT_NAME_MIN ||
        !auth.isValidEmail(email) ||
        password.length < config.AUTH_DEFAULT_PASSWORD_MIN
      ) {
        console.warn(
          `[auth-register] invalid_payload ip=${clientIp} email=${email || 'missing'} nameLength=${name.length} passwordLength=${password.length}`
        );
        res.status(400).json({ ok: false, message: 'Invalid register payload' });
        return;
      }

      if (config.AUTH_REGISTER_RATE_LIMIT_MAX > 0) {
        const nextLimit = await auth.incrementAuthRateLimit(
          'register',
          registerRateKey,
          config.AUTH_REGISTER_RATE_LIMIT_WINDOW_SEC
        );
        if (nextLimit.count > config.AUTH_REGISTER_RATE_LIMIT_MAX) {
          console.warn(
            `[auth-register] rate_limited ip=${clientIp} email=${email} retryAfter=${nextLimit.retryAfterSec}s stage=post-increment`
          );
          auth.setRetryAfter(res, nextLimit.retryAfterSec);
          res.status(429).json({ ok: false, message: 'Too many register attempts' });
          return;
        }
      }

      const existing = await auth.getUserByEmail(email);
      if (existing) {
        console.warn(`[auth-register] duplicate_email ip=${clientIp} email=${email}`);
        res.status(409).json({ ok: false, message: 'Email already registered' });
        return;
      }

      const user = {
        id: auth.randomId(12),
        email,
        name,
        passwordHash: auth.hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      const createdUser = await auth.createUser(user);
      if (!createdUser.ok) {
        console.warn(`[auth-register] create_user_conflict ip=${clientIp} email=${email}`);
        res.status(409).json({ ok: false, message: 'Email already registered' });
        return;
      }

      const created = await auth.createSessionForUser(createdUser.user);
      if (!created.ok) {
        console.warn(
          `[auth-register] session_conflict ip=${clientIp} email=${email} reason=${created.reason}`
        );
        res.status(409).json({ ok: false, message: created.reason });
        return;
      }

      auth.setAuthCookie(res, created.session.token);
      console.log(
        `[auth-register] success ip=${clientIp} email=${email} userId=${createdUser.user.id} authStorage=${auth.getAuthStorageMode()}`
      );
      res.status(201).json({ ok: true, user: auth.toPublicUser(createdUser.user) });
    })
  );

  app.post(
    '/api/auth/login',
    asyncRoute(async (req, res) => {
      const clientIp = auth.getRequestIp(req);
      const email = auth.normalizeEmail(req.body?.email);
      const password = String(req.body?.password || '');
      const forceFromClient = req.body?.force === true;
      const loginRateKey = `${clientIp}:${email || 'unknown'}`;
      if (!auth.isValidEmail(email) || !password) {
        res.status(400).json({ ok: false, message: 'Invalid login payload' });
        return;
      }

      if (config.AUTH_LOGIN_FAIL_RATE_LIMIT_MAX > 0) {
        const currentLimit = await auth.getAuthRateLimitState(
          'login-fail',
          loginRateKey,
          config.AUTH_LOGIN_FAIL_RATE_LIMIT_WINDOW_SEC
        );
        if (currentLimit.count >= config.AUTH_LOGIN_FAIL_RATE_LIMIT_MAX) {
          auth.setRetryAfter(res, currentLimit.retryAfterSec);
          res.status(429).json({ ok: false, message: 'Too many login attempts' });
          return;
        }
      }

      const user = await auth.getUserByEmail(email);
      if (!user || !auth.verifyPassword(password, user.passwordHash)) {
        if (config.AUTH_LOGIN_FAIL_RATE_LIMIT_MAX > 0) {
          const nextLimit = await auth.incrementAuthRateLimit(
            'login-fail',
            loginRateKey,
            config.AUTH_LOGIN_FAIL_RATE_LIMIT_WINDOW_SEC
          );
          if (nextLimit.count >= config.AUTH_LOGIN_FAIL_RATE_LIMIT_MAX) {
            auth.setRetryAfter(res, nextLimit.retryAfterSec);
            res.status(429).json({ ok: false, message: 'Too many login attempts' });
            return;
          }
        }
        res.status(401).json({ ok: false, message: 'Invalid credentials' });
        return;
      }

      await auth.clearAuthRateLimit('login-fail', loginRateKey);

      const forceExistingSession = forceFromClient || auth.isSeedTestEmail(email);
      const created = await auth.createSessionForUser(user, { forceExistingSession });
      if (!created.ok) {
        res.status(409).json({ ok: false, message: created.reason });
        return;
      }

      auth.setAuthCookie(res, created.session.token);
      res.json({ ok: true, user: auth.toPublicUser(user) });
    })
  );

  app.post(
    '/api/auth/logout',
    asyncRoute(async (req, res) => {
      const token = auth.getAuthTokenFromRequest(req);
      if (token) {
        const session = await auth.getSessionByToken(token);
        await auth.deleteSession(token, session);
      }
      auth.clearAuthCookie(res);
      res.json({ ok: true });
    })
  );

  app.get(
    '/api/auth/me',
    asyncRoute(async (req, res) => {
      const authContext = await auth.getAuthenticatedUserFromRequest(req);
      if (!authContext) {
        auth.clearAuthCookie(res);
        res.status(401).json({ ok: false, message: 'Unauthorized' });
        return;
      }

      res.json({
        ok: true,
        user: auth.toPublicUser(authContext.user),
      });
    })
  );
}

module.exports = {
  registerAuthRoutes,
};
