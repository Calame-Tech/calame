// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Express } from 'express';
import type { OidcAppContext, OidcSessionDeps } from '../types.js';

export function registerOidcSettingsRoute(
  app: Express,
  ctx: OidcAppContext,
  deps: OidcSessionDeps,
): void {
  /** GET /api/oidc-settings — Return the current OIDC config (clientSecret masked). */
  app.get('/api/oidc-settings', (_req, res) => {
    const mgr = ctx.oidcConfigManager;
    if (!mgr) {
      res.json({ success: true, config: null });
      return;
    }
    res.json({ success: true, config: mgr.getMaskedConfig() });
  });

  /** POST /api/oidc-settings — Save OIDC config. */
  app.post('/api/oidc-settings', (req, res) => {
    const mgr = ctx.oidcConfigManager;
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

    const cookies = deps.parseCookies(req.headers.cookie);
    const sessionId = cookies[deps.adminSessionCookieName];
    if (!sessionId) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }
    const session = deps.validateSession(sessionId);
    if (!session?.userId) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }

    const userManager = ctx.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    const user = userManager.getUserById(session.userId);
    if (!user || user.role !== 'admin') {
      res.status(403).json({ success: false, message: 'Admin access required.' });
      return;
    }

    const passwordHash = deps.getUserPasswordHash(session.userId);
    if (!passwordHash || !deps.verifyPassword(password, passwordHash)) {
      res.status(403).json({ success: false, message: 'Incorrect password.' });
      return;
    }

    const mgr = ctx.oidcConfigManager;
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
