import type { Express } from 'express';
import type { AppState } from '../state.js';
import { verifyPassword } from '../crypto.js';
import { validateSession } from '../session.js';

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  }
  return cookies;
}

export function registerOidcSettingsRoute(app: Express, state: AppState): void {
  /** GET /api/oidc-settings — Return the current OIDC config (clientSecret masked). */
  app.get('/api/oidc-settings', (_req, res) => {
    const mgr = state.oidcConfigManager;
    if (!mgr) {
      res.json({ success: true, config: null });
      return;
    }
    res.json({ success: true, config: mgr.getMaskedConfig() });
  });

  /** POST /api/oidc-settings — Save OIDC config. */
  app.post('/api/oidc-settings', (req, res) => {
    const mgr = state.oidcConfigManager;
    if (!mgr) {
      res.status(500).json({ success: false, message: 'OIDC config manager not initialized.' });
      return;
    }

    const {
      enabled,
      issuerUrl,
      clientId,
      clientSecret,
      redirectUri,
      scopes,
      groupClaim,
      groupToProfile,
      autoCreateUsers,
    } = req.body as {
      enabled?: unknown;
      issuerUrl?: unknown;
      clientId?: unknown;
      clientSecret?: unknown;
      redirectUri?: unknown;
      scopes?: unknown;
      groupClaim?: unknown;
      groupToProfile?: unknown;
      autoCreateUsers?: unknown;
    };

    if (!issuerUrl || typeof issuerUrl !== 'string') {
      res.status(400).json({ success: false, message: 'issuerUrl is required.' });
      return;
    }

    if (!clientId || typeof clientId !== 'string') {
      res.status(400).json({ success: false, message: 'clientId is required.' });
      return;
    }

    // Validate groupToProfile is a plain object of string -> string if provided
    let resolvedGroupToProfile: Record<string, string> = {};
    if (groupToProfile !== undefined && groupToProfile !== null) {
      if (
        typeof groupToProfile !== 'object' ||
        Array.isArray(groupToProfile) ||
        !Object.values(groupToProfile as object).every((v) => typeof v === 'string')
      ) {
        res
          .status(400)
          .json({ success: false, message: 'groupToProfile must be an object mapping strings to strings.' });
        return;
      }
      resolvedGroupToProfile = groupToProfile as Record<string, string>;
    }

    try {
      mgr.setConfig({
        enabled: enabled === true || enabled === 'true',
        issuerUrl,
        clientId,
        clientSecret: typeof clientSecret === 'string' ? clientSecret : '',
        redirectUri: typeof redirectUri === 'string' ? redirectUri : '',
        scopes: typeof scopes === 'string' ? scopes : 'openid profile email',
        groupClaim: typeof groupClaim === 'string' ? groupClaim : 'groups',
        groupToProfile: resolvedGroupToProfile,
        autoCreateUsers: autoCreateUsers === false || autoCreateUsers === 'false' ? false : true,
      });

      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to save OIDC config.';
      res.status(500).json({ success: false, message });
    }
  });

  /** POST /api/oidc-settings/reveal — Reveal OIDC clientSecret (requires admin password). */
  app.post('/api/oidc-settings/reveal', (req, res) => {
    const { password } = req.body as { password?: string };

    if (!password || typeof password !== 'string') {
      res.status(400).json({ success: false, message: 'Admin password is required.' });
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies.calame_session;
    if (!sessionId) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }
    const session = validateSession(sessionId);
    if (!session?.userId) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    const user = userManager.getUserById(session.userId);
    if (!user || user.role !== 'admin') {
      res.status(403).json({ success: false, message: 'Admin access required.' });
      return;
    }

    const userRow = state.db?.raw
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(session.userId) as { password_hash: string | null } | undefined;

    if (!userRow?.password_hash || !verifyPassword(password, userRow.password_hash)) {
      res.status(403).json({ success: false, message: 'Incorrect password.' });
      return;
    }

    const mgr = state.oidcConfigManager;
    if (!mgr) {
      res.status(500).json({ success: false, message: 'OIDC config manager not initialized.' });
      return;
    }

    const config = mgr.getConfig();
    if (!config) {
      res.status(404).json({ success: false, message: 'No OIDC config found.' });
      return;
    }

    res.json({ success: true, clientSecret: config.clientSecret });
  });
}
