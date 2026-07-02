// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import { OidcProvider, type OidcProviderConfig } from '../provider.js';
import type { OidcAppContext, OidcSessionDeps, OidcUserProfileAccess } from '../types.js';

/** Options for registerOidcAuthRoutes — allows tests to inject a mock OidcProvider. */
export interface OidcAuthRouteOptions {
  /** Override the OidcProvider constructor (used by tests). Defaults to `new OidcProvider(cfg)`. */
  providerFactory?: (config: OidcProviderConfig) => OidcProvider;
}

/**
 * Temporary in-memory store for PKCE state: state -> { codeVerifier, expiresAt, redirect? }.
 *
 * NOTE: in-memory only — PKCE state is lost on server restart and not shared
 * across instances. Multi-instance deployments need Redis or DB-backed storage.
 */
const pendingOidcStates = new Map<
  string,
  { codeVerifier: string; expiresAt: number; redirect?: string }
>();

function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [key, value] of pendingOidcStates.entries()) {
    if (now > value.expiresAt) {
      pendingOidcStates.delete(key);
    }
  }
}

/** Build an OidcProvider instance from app context. Returns null if OIDC is not configured.
 *  Priority: DB config (via OidcConfigManager) > env vars (OidcEnvConfig).
 */
function buildOidcProvider(
  ctx: OidcAppContext,
  factory: (config: OidcProviderConfig) => OidcProvider,
): OidcProvider | null {
  const dbConfig = ctx.oidcConfigManager?.getConfig();
  if (dbConfig?.enabled && dbConfig.issuerUrl && dbConfig.clientId) {
    return factory({
      issuerUrl: dbConfig.issuerUrl,
      clientId: dbConfig.clientId,
      clientSecret: dbConfig.clientSecret || undefined,
      redirectUri: dbConfig.redirectUri,
      scopes: dbConfig.scopes,
      groupClaim: dbConfig.groupClaim,
      groupToProfile: dbConfig.groupToProfile,
      autoCreateUsers: dbConfig.autoCreateUsers,
      claimsToAttributes: dbConfig.claimsToAttributes,
    });
  }

  const cfg = ctx.config;
  if (!cfg?.oidcEnabled) return null;
  if (!cfg.oidcIssuerUrl || !cfg.oidcClientId || !cfg.oidcRedirectUri) return null;

  let groupToProfile: Record<string, string> = {};
  if (cfg.oidcGroupMap) {
    try {
      groupToProfile = JSON.parse(cfg.oidcGroupMap) as Record<string, string>;
    } catch {
      // invalid JSON — ignore group mapping
    }
  }

  return factory({
    issuerUrl: cfg.oidcIssuerUrl,
    clientId: cfg.oidcClientId,
    clientSecret: cfg.oidcClientSecret ?? undefined,
    redirectUri: cfg.oidcRedirectUri,
    scopes: cfg.oidcScopes,
    groupClaim: cfg.oidcGroupClaim,
    groupToProfile,
    autoCreateUsers: cfg.oidcAutoCreateUsers,
  });
}

export function registerOidcAuthRoutes(
  app: Express,
  ctx: OidcAppContext,
  deps: OidcSessionDeps,
  options?: OidcAuthRouteOptions,
): void {
  const providerFactory =
    options?.providerFactory ?? ((cfg: OidcProviderConfig) => new OidcProvider(cfg));
  /**
   * GET /api/auth/oidc/config — Public.
   * Returns whether OIDC is enabled and provider details.
   * DB config takes priority over env vars.
   */
  app.get('/api/auth/oidc/config', (_req: Request, res: Response) => {
    const dbConfig = ctx.oidcConfigManager?.getConfig();
    if (dbConfig?.enabled && dbConfig.issuerUrl && dbConfig.clientId) {
      let providerName: string = dbConfig.issuerUrl;
      try {
        providerName = new URL(dbConfig.issuerUrl).hostname;
      } catch {
        // keep raw URL as name if parsing fails
      }

      res.json({
        enabled: true,
        providerName,
        issuer: dbConfig.issuerUrl,
        clientId: dbConfig.clientId,
        clientSecret: dbConfig.clientSecret ? '***' : '',
        redirectUri: dbConfig.redirectUri,
        scopes: dbConfig.scopes,
        groupClaim: dbConfig.groupClaim,
        groupToProfile: dbConfig.groupToProfile,
        autoCreateUsers: dbConfig.autoCreateUsers,
        source: 'database',
      });
      return;
    }

    const cfg = ctx.config;
    if (!cfg?.oidcEnabled || !cfg.oidcIssuerUrl) {
      res.json({ enabled: false, providerName: null });
      return;
    }

    let providerName: string = cfg.oidcIssuerUrl;
    try {
      providerName = new URL(cfg.oidcIssuerUrl).hostname;
    } catch {
      // keep raw URL as name if parsing fails
    }

    let groupToProfile: Record<string, string> = {};
    if (cfg.oidcGroupMap) {
      try {
        groupToProfile = JSON.parse(cfg.oidcGroupMap) as Record<string, string>;
      } catch {
        // invalid JSON — ignore
      }
    }

    res.json({
      enabled: true,
      providerName,
      issuer: cfg.oidcIssuerUrl,
      clientId: cfg.oidcClientId,
      clientSecret: cfg.oidcClientSecret ? '***' : '',
      redirectUri: cfg.oidcRedirectUri,
      scopes: cfg.oidcScopes,
      groupClaim: cfg.oidcGroupClaim,
      groupToProfile,
      autoCreateUsers: cfg.oidcAutoCreateUsers,
      source: 'env',
    });
  });

  /**
   * GET /api/auth/oidc/login — Initiate OIDC login with PKCE.
   * Generates a code verifier, stores it in memory keyed by state param, then redirects to IdP.
   */
  app.get('/api/auth/oidc/login', async (req: Request, res: Response) => {
    const provider = buildOidcProvider(ctx, providerFactory);
    if (!provider) {
      res.status(503).json({ error: 'OIDC is not configured.' });
      return;
    }

    cleanupExpiredStates();

    // Validate the optional redirect param: must be a relative path starting
    // with '/' but NOT '//' (protocol-relative URL would be an open redirect).
    const rawRedirect =
      typeof req.query['redirect'] === 'string' ? req.query['redirect'] : undefined;
    const safeRedirect =
      rawRedirect !== undefined && rawRedirect.startsWith('/') && !rawRedirect.startsWith('//')
        ? rawRedirect
        : undefined;

    try {
      const stateParam = crypto.randomBytes(16).toString('hex');
      const codeVerifier = provider.generateCodeVerifier();

      pendingOidcStates.set(stateParam, {
        codeVerifier,
        expiresAt: Date.now() + 10 * 60 * 1000,
        ...(safeRedirect !== undefined ? { redirect: safeRedirect } : {}),
      });

      const authUrl = await provider.getAuthorizationUrl(stateParam, codeVerifier);
      res.redirect(authUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      ctx.logger?.error('[OIDC] Login initiation failed', { error: message });
      res.status(500).json({ error: 'Failed to initiate OIDC login' });
    }
  });

  /**
   * GET /api/auth/oidc/callback — Handle IdP callback.
   * Validates state, exchanges code, verifies token, finds/creates user, creates session.
   */
  app.get('/api/auth/oidc/callback', async (req: Request, res: Response) => {
    const provider = buildOidcProvider(ctx, providerFactory);
    if (!provider) {
      res.status(503).json({ error: 'OIDC is not configured.' });
      return;
    }

    const {
      code,
      state: stateParam,
      error: oidcError,
    } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    if (oidcError) {
      res.status(400).json({ error: `IdP returned error: ${oidcError}` });
      return;
    }

    if (!code || !stateParam) {
      res.status(400).json({ error: 'Missing code or state parameter.' });
      return;
    }

    const pendingState = pendingOidcStates.get(stateParam);
    if (!pendingState || Date.now() > pendingState.expiresAt) {
      pendingOidcStates.delete(stateParam);
      res.status(400).json({ error: 'Invalid or expired state parameter.' });
      return;
    }

    pendingOidcStates.delete(stateParam);
    const { codeVerifier, redirect: pendingRedirect } = pendingState;

    try {
      const { idToken } = await provider.exchangeCode(code, codeVerifier);

      const payload = await provider.verifyIdToken(idToken);

      const subject = payload.sub;
      if (!subject) {
        res.status(400).json({ error: 'ID token missing sub claim.' });
        return;
      }

      const email = typeof payload['email'] === 'string' ? payload['email'] : null;
      const name =
        typeof payload['name'] === 'string'
          ? payload['name']
          : typeof payload['preferred_username'] === 'string'
            ? payload['preferred_username']
            : (email ?? 'SSO User');

      const groups = provider.getGroups(payload);
      const mappedProfiles = provider.mapGroupsToProfiles(groups);

      const claimsAttrs = provider.extractCustomAttributes(payload);

      const userManager = ctx.userManager;
      if (!userManager) {
        res.status(500).json({ error: 'User manager not initialized.' });
        return;
      }

      // Determine whether the redirect targets a profile with authMode === 'sso'.
      // Only grant auto-access when the profile explicitly trusts the IdP as gatekeeper.
      const chatRedirectMatch =
        pendingRedirect !== undefined ? /^\/chat\/([a-zA-Z0-9_-]+)$/.exec(pendingRedirect) : null;
      const ssoTargetProfileName = chatRedirectMatch ? chatRedirectMatch[1] : null;
      const ssoTargetProfile =
        ssoTargetProfileName !== null ? (ctx.serveProfiles[ssoTargetProfileName] ?? null) : null;
      const ssoAutoGrant =
        ssoTargetProfile !== null && ssoTargetProfile.authMode === 'sso'
          ? ssoTargetProfileName!
          : null;

      // Compute IdP scope: the set of profile names whose access is delegated to the IdP.
      // Profiles outside this set are admin-controlled.
      const idpScope = new Set<string>(Object.values(provider.getGroupToProfile()));

      // What the IdP currently grants based on JWT groups (no ssoAutoGrant here —
      // ssoAutoGrant is a one-off for new users only).
      const desiredFromIdp = new Set<string>(mappedProfiles);

      let userId: string | null = null;
      const existingBySubject = userManager.getUserByOidcSubject(subject);

      const um = userManager;

      /**
       * Apply destructive IdP-scope sync to an existing user:
       *  - ADD profiles in desiredFromIdp that the user does not already have.
       *  - REMOVE profiles in idpScope that are no longer in desiredFromIdp.
       *  - Never touch profiles outside idpScope (admin authority is absolute there).
       */
      const applyIdpSync = (existingUser: {
        id: string;
        profiles: Array<{ profileName: string }>;
      }): void => {
        const currentNames = new Set(existingUser.profiles.map((p) => p.profileName));

        for (const profileName of desiredFromIdp) {
          if (!currentNames.has(profileName)) {
            um.addProfileAccess(existingUser.id, {
              profileName,
              allowedTables: null,
              allowedTools: null,
              accessMode: 'both',
            });
          }
        }

        for (const profileName of idpScope) {
          if (currentNames.has(profileName) && !desiredFromIdp.has(profileName)) {
            um.removeProfileAccess(existingUser.id, profileName);
          }
        }
      };

      if (existingBySubject) {
        userId = existingBySubject.id;
        applyIdpSync(existingBySubject);
        if (claimsAttrs) {
          const merged = { ...(existingBySubject.customAttributes ?? {}), ...claimsAttrs };
          userManager.setCustomAttributes(userId, merged);
        }
        await userManager.save();
      } else if (email) {
        const existingByEmail = userManager.getUserByEmail(email);
        if (existingByEmail) {
          userManager.setOidcSubject(existingByEmail.id, subject);
          userId = existingByEmail.id;
          applyIdpSync(existingByEmail);
          if (claimsAttrs) {
            const merged = { ...(existingByEmail.customAttributes ?? {}), ...claimsAttrs };
            userManager.setCustomAttributes(userId, merged);
          }
          await userManager.save();
        }
      }

      if (!userId) {
        const dbCfg = ctx.oidcConfigManager?.getConfig();
        const autoCreate = dbCfg?.enabled
          ? dbCfg.autoCreateUsers
          : (ctx.config?.oidcAutoCreateUsers ?? true);
        if (!autoCreate) {
          res.status(403).json({ error: 'Account not found and auto-creation is disabled.' });
          return;
        }

        if (!email) {
          res.status(400).json({ error: 'Cannot create user: ID token missing email claim.' });
          return;
        }

        const profileAccesses: OidcUserProfileAccess[] = mappedProfiles.map((profileName) => ({
          profileName,
          allowedTables: null,
          allowedTools: null,
          accessMode: 'both' as const,
        }));

        if (ssoAutoGrant !== null && !profileAccesses.some((p) => p.profileName === ssoAutoGrant)) {
          profileAccesses.push({
            profileName: ssoAutoGrant,
            allowedTables: null,
            allowedTools: null,
            accessMode: 'both' as const,
          });
        }

        // OIDC users need at least one profile to be created.
        if (profileAccesses.length === 0) {
          profileAccesses.push({
            profileName: 'default',
            allowedTables: null,
            allowedTools: null,
            accessMode: 'both' as const,
          });
        }

        const newUser = userManager.createUser({
          name,
          email,
          role: 'user',
          profiles: profileAccesses,
          customAttributes: claimsAttrs,
        });

        userManager.consumeOnboardingCode(newUser.onboardingCode!);
        userManager.setOidcSubject(newUser.id, subject);
        await userManager.save();
        userId = newUser.id;
      }

      // Always set the user cookie so chat pages work; additionally set the
      // admin cookie when the user has admin role.
      const sessionId = deps.createSession(userId);
      deps.setUserSessionCookie(res, sessionId);
      const resolvedUser = userManager.getUserById(userId);
      if (resolvedUser?.role === 'admin') {
        deps.setSessionCookie(res, sessionId);
      }

      res.redirect(pendingRedirect ?? '/');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      ctx.logger?.error('[OIDC] Callback failed', { error: message });
      res.status(500).json({
        error: 'OIDC authentication failed. Please try again or contact your administrator.',
      });
    }
  });
}
