import type { Express } from 'express';
import type { AppState } from '../state.js';
import { verifyPassword } from '../crypto.js';
import { TokenRateLimiter } from '../rate-limiter.js';

const userChatLimiter = new TokenRateLimiter();
const USER_CHAT_RPM = 30;
import {
  createSession,
  validateSession,
  destroySession,
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
  setSessionCookie,
  clearSessionCookie,
  setUserSessionCookie,
  clearUserSessionCookie,
  validateUserSession,
} from '../session.js';
import { createMcpChatTools, executeChatTurn, getDefaultSystemPrompt } from '../chat-engine.js';

export function registerAuthRoute(app: Express, state: AppState): void {
  /**
   * POST /api/auth/setup — Create the first admin account (first-run only).
   * Body: { name: string, email: string, password: string }
   */
  app.post('/api/auth/setup', async (req, res) => {
    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    if (userManager.hasAdminUser()) {
      res.status(403).json({ success: false, message: 'Admin account already exists. Setup is not allowed.' });
      return;
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (isRateLimited(ip)) {
      res.status(429).json({
        success: false,
        message: 'Too many attempts. Please wait 1 minute.',
      });
      return;
    }

    const { name, email, password } = req.body as {
      name?: string;
      email?: string;
      password?: string;
    };

    // Validation
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, message: 'Name is required.' });
      return;
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ success: false, message: 'A valid email is required.' });
      return;
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
      return;
    }

    try {
      const result = userManager.createAdminAccount({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
      });
      await userManager.save();

      // Create session and set cookie
      const sessionId = createSession(result.id);
      setSessionCookie(res, sessionId);

      res.json({
        success: true,
        user: {
          id: result.id,
          name: result.name,
          email: result.email,
          role: result.role,
        },
      });
    } catch (err: unknown) {
      recordFailedAttempt(ip);
      const message = err instanceof Error ? err.message : 'Failed to create admin account.';
      res.status(400).json({ success: false, message });
    }
  });

  /**
   * POST /api/auth/login — Authenticate admin with email + password.
   * Body: { email: string, password: string }
   */
  app.post('/api/auth/login', async (req, res) => {
    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    if (isRateLimited(ip)) {
      res.status(429).json({
        success: false,
        message: 'Too many login attempts. Please wait 1 minute.',
      });
      return;
    }

    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || typeof email !== 'string') {
      res.status(400).json({ success: false, message: 'Email is required.' });
      return;
    }

    if (!password || typeof password !== 'string') {
      res.status(400).json({ success: false, message: 'Password is required.' });
      return;
    }

    const user = userManager.authenticateByEmail(email, password);

    if (!user) {
      recordFailedAttempt(ip);
      res.status(401).json({ success: false, message: 'Invalid email or password.' });
      return;
    }

    if (user.role !== 'admin') {
      recordFailedAttempt(ip);
      res.status(403).json({ success: false, message: 'Admin access required.' });
      return;
    }

    clearFailedAttempts(ip);
    await userManager.save();

    const sessionId = createSession(user.id);
    setSessionCookie(res, sessionId);

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  });

  /**
   * POST /api/auth/user-login — Authenticate a user with email + password.
   * Body: { email: string, password: string }
   */
  app.post('/api/auth/user-login', async (req, res) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    if (isRateLimited(ip)) {
      res.status(429).json({
        success: false,
        message: 'Too many login attempts. Please wait 1 minute.',
      });
      return;
    }

    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      res.status(400).json({ success: false, message: 'Email and password are required.' });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    const user = userManager.authenticateByEmail(email, password);
    if (!user) {
      recordFailedAttempt(ip);
      res.status(401).json({ success: false, message: 'Invalid email or password.' });
      return;
    }

    if (user.status === 'disabled') {
      res.status(403).json({ success: false, message: 'Your account has been disabled. Contact your administrator.' });
      return;
    }

    clearFailedAttempts(ip);
    await userManager.save();

    const sessionId = createSession(user.id);
    setUserSessionCookie(res, sessionId);

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        profiles: user.profiles,
      },
    });
  });

  /**
   * POST /api/auth/logout — Destroy admin session.
   */
  app.post('/api/auth/logout', (req, res) => {
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const cookies = parseCookies(cookieHeader);
      if (cookies['calame_session']) destroySession(cookies['calame_session']);
      if (cookies['calame_user_session']) destroySession(cookies['calame_user_session']);
    }
    clearSessionCookie(res);
    clearUserSessionCookie(res);
    res.json({ success: true });
  });

  /**
   * GET /api/auth/status — Check admin auth status.
   */
  app.get('/api/auth/status', (req, res) => {
    const userManager = state.userManager;

    // If no admin user exists yet, signal that setup is needed
    if (!userManager || !userManager.hasAdminUser()) {
      res.json({
        success: true,
        needsSetup: true,
        authRequired: true,
        authenticated: false,
        oidcEnabled: !!state.config?.oidcEnabled,
      });
      return;
    }

    // Admin exists — check session
    const cookies = parseCookies(req.headers.cookie ?? '');
    const sessionId = cookies['calame_session'];
    const session = sessionId ? validateSession(sessionId) : null;

    if (!session || !session.userId) {
      res.json({
        success: true,
        authenticated: false,
        authRequired: true,
        oidcEnabled: !!state.config?.oidcEnabled,
      });
      return;
    }

    // Verify the session user is an active admin
    const user = userManager.getUserById(session.userId);
    if (!user || user.role !== 'admin' || user.status !== 'active') {
      res.json({
        success: true,
        authenticated: false,
        authRequired: true,
      });
      return;
    }

    res.json({
      success: true,
      authenticated: true,
      authRequired: true,
      oidcEnabled: !!state.config?.oidcEnabled,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  });

  /**
   * GET /api/auth/user-status — Check user auth status.
   * Returns the logged-in user's info if authenticated.
   */
  app.get('/api/auth/user-status', (req, res) => {
    const cookies = parseCookies(req.headers.cookie ?? '');
    const sessionId = cookies['calame_user_session'];

    if (!sessionId) {
      res.json({ success: true, authenticated: false });
      return;
    }

    const session = validateUserSession(sessionId);
    if (!session || !session.userId) {
      res.json({ success: true, authenticated: false });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.json({ success: true, authenticated: false });
      return;
    }

    const user = userManager.getUserById(session.userId);
    if (!user || user.status !== 'active') {
      res.json({ success: true, authenticated: false });
      return;
    }

    res.json({
      success: true,
      authenticated: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        profiles: user.profiles,
      },
    });
  });

  /**
   * GET /api/auth/user-tokens — Get the logged-in user's MCP tokens and config.
   */
  app.get('/api/auth/user-tokens', (req, res) => {
    const cookies = parseCookies(req.headers.cookie ?? '');
    const sessionId = cookies['calame_user_session'];

    if (!sessionId) {
      res.status(401).json({ success: false, message: 'Not authenticated.' });
      return;
    }

    const session = validateUserSession(sessionId);
    if (!session?.userId) {
      res.status(401).json({ success: false, message: 'Session expired.' });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    const user = userManager.getUserById(session.userId);
    if (!user || user.status !== 'active') {
      res.status(403).json({ success: false, message: 'Account disabled.' });
      return;
    }

    const host = req.headers.host ?? `localhost:${req.socket.localPort ?? 4567}`;
    const protocol = req.secure ? 'https' : 'http';

    const profilesInfo = user.profiles.map((p) => ({
      profileName: p.profileName,
      accessMode: p.accessMode,
      allowedTables: p.allowedTables,
      mcpUrl: p.accessMode !== 'chat' ? `${protocol}://${host}/mcp/${p.profileName}` : null,
    }));

    // Try to decrypt the token for display. Falls back to hash preview if no secret key.
    const decryptedToken = userManager.getUserToken(user.id);
    const tokenPreview = user.tokenHash.substring(0, 8) + '...';

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      profiles: profilesInfo,
      tokenPreview,
      hasPassword: !!user.passwordHash,
      chatEnabled: !!state.aiConfigManager?.isConfigured(),
    });
  });

  /**
   * POST /api/auth/user-reveal-token — Reveal the user's own token after password confirmation.
   */
  app.post('/api/auth/user-reveal-token', (req, res) => {
    const cookies = parseCookies(req.headers.cookie ?? '');
    const sessionId = cookies['calame_user_session'];

    if (!sessionId) {
      res.status(401).json({ success: false, message: 'Not authenticated.' });
      return;
    }

    const session = validateUserSession(sessionId);
    if (!session?.userId) {
      res.status(401).json({ success: false, message: 'Session expired.' });
      return;
    }

    const { password } = req.body as { password?: string };
    if (!password || typeof password !== 'string') {
      res.status(400).json({ success: false, message: 'Password is required.' });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    const user = userManager.getUserById(session.userId);
    if (!user || user.status !== 'active') {
      res.status(403).json({ success: false, message: 'Account disabled.' });
      return;
    }

    // Verify password
    const userRow = state.db?.raw
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(session.userId) as { password_hash: string | null } | undefined;

    if (!userRow?.password_hash) {
      res.status(403).json({ success: false, message: 'No password set on this account.' });
      return;
    }

    if (!verifyPassword(password, userRow.password_hash)) {
      res.status(403).json({ success: false, message: 'Incorrect password.' });
      return;
    }

    // Retrieve the decrypted token
    const decryptedToken = userManager.getUserToken(user.id);
    if (!decryptedToken) {
      res.status(404).json({ success: false, message: 'Token not available. Try regenerating it.' });
      return;
    }

    res.json({ success: true, token: decryptedToken });
  });

  /**
   * POST /api/auth/user-regenerate-token — Let a logged-in user regenerate their own token.
   */
  app.post('/api/auth/user-regenerate-token', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie ?? '');
    const sessionId = cookies['calame_user_session'];

    if (!sessionId) {
      res.status(401).json({ success: false, message: 'Not authenticated.' });
      return;
    }

    const session = validateUserSession(sessionId);
    if (!session?.userId) {
      res.status(401).json({ success: false, message: 'Session expired.' });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    const result = userManager.regenerateToken(session.userId);
    if (!result) {
      res.status(404).json({ success: false, message: 'User not found.' });
      return;
    }

    await userManager.save();
    res.json({ success: true, plaintextToken: result._plaintextToken });
  });

  /**
   * POST /api/auth/user-chat — Chat endpoint for authenticated users.
   * Uses the admin's AI config, filtered by user permissions.
   * Body: { message: string, history: ChatMessage[], profileName: string }
   *
   * Special case: when the target profile has authMode === 'open', user
   * authentication is skipped and a guest identity is used for audit logging.
   */
  app.post('/api/auth/user-chat', async (req, res) => {
    // Rate limit by IP or session
    const chatKey = req.ip ?? 'anon';
    const rl = userChatLimiter.check(chatKey, USER_CHAT_RPM);
    if (!rl.allowed) {
      res.status(429).json({ success: false, message: 'Too many messages. Please wait a moment.' });
      return;
    }

    const { message, history, profileName } = req.body as {
      message?: string;
      history?: Array<{ role: string; content: string }>;
      profileName?: string;
    };

    if (!message || typeof message !== 'string') {
      res.status(400).json({ success: false, message: 'Message is required.' });
      return;
    }

    if (!profileName || typeof profileName !== 'string') {
      res.status(400).json({ success: false, message: 'Profile name is required.' });
      return;
    }

    // Check AI config — required regardless of authMode
    const aiConfig = state.aiConfigManager?.getConfig();
    if (!aiConfig || !state.aiConfigManager?.isConfigured()) {
      res.status(503).json({ success: false, message: 'AI chat is not configured by the administrator.' });
      return;
    }

    // --- Open mode: bypass user session entirely ---
    const serveProfile = state.serveProfiles[profileName];
    if (serveProfile?.authMode === 'open') {
      // Profile must be active
      if (!state.activeProfileNames.has(profileName)) {
        res.status(503).json({ success: false, message: 'This MCP server is not currently active.' });
        return;
      }

      // For open-mode profiles the MCP endpoint itself uses the profile token (no user token).
      // We call the MCP server with the profile-level token (if any) or without auth.
      const profileToken = serveProfile.token ?? '';

      try {
        const host = req.headers.host ?? `localhost:${req.socket.localPort ?? 4567}`;
        const protocol = req.secure ? 'https' : 'http';
        const mcpUrl = `${protocol}://${host}/mcp/${profileName}`;

        // Connect as MCP client with the profile token (may be empty for truly open endpoints)
        const { tools, close } = await createMcpChatTools(mcpUrl, profileToken);

        try {
          const result = await executeChatTurn({
            provider: aiConfig.provider,
            apiKey: aiConfig.apiKey,
            model: aiConfig.model,
            baseUrl: aiConfig.baseUrl,
            message,
            history: history ?? [],
            tools,
            systemPrompt: getDefaultSystemPrompt(serveProfile.responseMode ?? 'friendly'),
          });

          res.json(result);
        } finally {
          await close();
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        state.logger?.error('Error', { component: 'user-chat/open', error: msg });
        res.json({ success: false, message: msg });
      }
      return;
    }

    // --- Authenticated modes: require a valid user session ---
    const cookies = parseCookies(req.headers.cookie ?? '');
    const sessionId = cookies['calame_user_session'];

    if (!sessionId) {
      res.status(401).json({ success: false, message: 'Not authenticated.' });
      return;
    }

    const session = validateUserSession(sessionId);
    if (!session?.userId) {
      res.status(401).json({ success: false, message: 'Session expired.' });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    const user = userManager.getUserById(session.userId);
    if (!user || user.status !== 'active') {
      res.status(403).json({ success: false, message: 'Account disabled.' });
      return;
    }

    // Check user has access to this profile
    const userProfile = user.profiles.find((p) => p.profileName === profileName);
    if (!userProfile) {
      res.status(403).json({ success: false, message: 'You do not have access to this profile.' });
      return;
    }

    if (userProfile.accessMode === 'mcp') {
      res.status(403).json({ success: false, message: 'Chat access is not enabled for this profile.' });
      return;
    }

    // Enforce authMode constraints on the chat route
    if (serveProfile?.authMode === 'sso') {
      // SSO mode requires the user to have authenticated via SSO (has an oidcSubject).
      if (!user.oidcSubject) {
        res.status(403).json({
          success: false,
          message: 'This profile requires SSO authentication. Please sign in via your SSO provider.',
        });
        return;
      }
    }
    // 'token', 'calame', 'oauth' — no additional chat-route constraint needed.

    // Find the active serve profile
    if (!state.activeProfileNames.has(profileName)) {
      res.status(503).json({ success: false, message: 'This MCP server is not currently active.' });
      return;
    }

    // Get the user's MCP token to authenticate against the internal MCP endpoint
    const userToken = userManager.getUserToken(user.id);
    if (!userToken) {
      res.status(503).json({
        success: false,
        message: 'Cannot use chat without CALAME_SECRET_KEY. Set this environment variable to enable chat.',
      });
      return;
    }

    try {
      // Build the internal MCP URL from the current request
      const host = req.headers.host ?? `localhost:${req.socket.localPort ?? 4567}`;
      const protocol = req.secure ? 'https' : 'http';
      const mcpUrl = `${protocol}://${host}/mcp/${profileName}`;

      // Connect as MCP client — all security rules (masking, validation, audit) are inherited
      const { tools, close } = await createMcpChatTools(mcpUrl, userToken);

      try {
        const chatResponseMode = state.serveProfiles[profileName]?.responseMode ?? 'friendly';
        const scopeRules = state.serveProfiles[profileName]?.dataScopeRules;
        const isScoped = !!(scopeRules && scopeRules.length > 0 && user.role !== 'admin');
        const result = await executeChatTurn({
          provider: aiConfig.provider,
          apiKey: aiConfig.apiKey,
          model: aiConfig.model,
          baseUrl: aiConfig.baseUrl,
          message,
          history: history ?? [],
          tools,
          systemPrompt: getDefaultSystemPrompt(chatResponseMode, { scoped: isScoped }),
        });

        res.json(result);
      } finally {
        await close();
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'user-chat', error: msg });
      res.json({ success: false, message: msg });
    }
  });

  /**
   * POST /api/auth/user-change-password — Let a logged-in user change their password.
   */
  app.post('/api/auth/user-change-password', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie ?? '');
    const sessionId = cookies['calame_user_session'];

    if (!sessionId) {
      res.status(401).json({ success: false, message: 'Not authenticated.' });
      return;
    }

    const session = validateUserSession(sessionId);
    if (!session?.userId) {
      res.status(401).json({ success: false, message: 'Session expired.' });
      return;
    }

    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    const user = userManager.getUserById(session.userId);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found.' });
      return;
    }

    // Verify current password if one is set
    if (user.passwordHash && currentPassword) {
      const { verifyPassword } = await import('../crypto.js');
      if (!verifyPassword(currentPassword, user.passwordHash)) {
        res.status(401).json({ success: false, message: 'Current password is incorrect.' });
        return;
      }
    }

    userManager.setPassword(session.userId, newPassword);
    await userManager.save();
    res.json({ success: true });
  });

  /**
   * GET /api/auth/user-profile-access — Check if the current user has access to a profile.
   * Used by ChatEntryPage to verify access after authentication.
   */
  app.get('/api/auth/user-profile-access', (req, res) => {
    const cookies = parseCookies(req.headers.cookie ?? '');
    const sessionId = cookies['calame_user_session'];

    if (!sessionId) {
      res.json({ success: false, hasAccess: false });
      return;
    }

    const session = validateUserSession(sessionId);
    if (!session?.userId) {
      res.json({ success: false, hasAccess: false });
      return;
    }

    const profileName = req.query.profileName as string | undefined;
    if (!profileName || !/^[a-zA-Z0-9_-]+$/.test(profileName)) {
      res.status(400).json({ success: false, message: 'Invalid profile name.' });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.json({ success: false, hasAccess: false });
      return;
    }

    const user = userManager.getUserById(session.userId);
    if (!user || user.status !== 'active') {
      res.json({ success: false, hasAccess: false });
      return;
    }

    const hasAccess = user.profiles.some((p) => p.profileName === profileName);
    res.json({ success: true, hasAccess, userName: user.name });
  });
}

function parseCookies(cookieHeader: string): Record<string, string> {
  return cookieHeader.split(';').reduce(
    (acc, cookie) => {
      const [key, ...vals] = cookie.trim().split('=');
      if (key) acc[key] = vals.join('=');
      return acc;
    },
    {} as Record<string, string>,
  );
}
