import type { Express, Request, Response } from 'express';
import type { AppState } from '../state.js';
import { OidcProvider } from '../oidc.js';
import { createSession, setSessionCookie, setUserSessionCookie } from '../session.js';
import type { UserProfileAccess } from '../user.js';
import crypto from 'crypto';

/**
 * Temporary in-memory store for PKCE state: state -> { codeVerifier, expiresAt, redirect? }.
 *
 * NOTE: This is an in-memory store — PKCE state is lost on server restart and
 * not shared across instances. For multi-instance deployments behind a load
 * balancer, this should be replaced with Redis or DB-backed storage.
 */
const pendingOidcStates = new Map<
  string,
  { codeVerifier: string; expiresAt: number; redirect?: string }
>();

/** Clean up expired PKCE entries (entries older than 10 minutes) */
function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [key, value] of pendingOidcStates.entries()) {
    if (now > value.expiresAt) {
      pendingOidcStates.delete(key);
    }
  }
}

/** Build an OidcProvider instance from app state config. Returns null if OIDC is not configured.
 *
 * Priority: DB config (via OidcConfigManager) > env vars (AppConfig).
 */
function buildOidcProvider(state: AppState): OidcProvider | null {
  // DB config takes priority over env vars
  const dbConfig = state.oidcConfigManager?.getConfig();
  if (dbConfig?.enabled && dbConfig.issuerUrl && dbConfig.clientId) {
    return new OidcProvider({
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

  // Fall back to env var config
  const cfg = state.config;
  if (!cfg?.oidcEnabled) return null;
  if (!cfg.oidcIssuerUrl || !cfg.oidcClientId || !cfg.oidcRedirectUri) return null;

  let groupToProfile: Record<string, string> = {};
  if (cfg.oidcGroupMap) {
    try {
      groupToProfile = JSON.parse(cfg.oidcGroupMap) as Record<string, string>;
    } catch {
      // Invalid JSON — ignore group mapping
    }
  }

  return new OidcProvider({
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

export function registerOidcAuthRoutes(app: Express, state: AppState): void {
  /**
   * GET /api/auth/oidc/config — Public.
   * Returns whether OIDC is enabled and provider details.
   * DB config takes priority over env vars.
   */
  app.get('/api/auth/oidc/config', (_req: Request, res: Response) => {
    // Check DB config first
    const dbConfig = state.oidcConfigManager?.getConfig();
    if (dbConfig?.enabled && dbConfig.issuerUrl && dbConfig.clientId) {
      let providerName: string = dbConfig.issuerUrl;
      try {
        providerName = new URL(dbConfig.issuerUrl).hostname;
      } catch {
        // Keep raw URL as name if parsing fails
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

    // Fall back to env var config
    const cfg = state.config;
    if (!cfg?.oidcEnabled || !cfg.oidcIssuerUrl) {
      res.json({ enabled: false, providerName: null });
      return;
    }

    let providerName: string = cfg.oidcIssuerUrl;
    try {
      providerName = new URL(cfg.oidcIssuerUrl).hostname;
    } catch {
      // Keep raw URL as name if parsing fails
    }

    let groupToProfile: Record<string, string> = {};
    if (cfg.oidcGroupMap) {
      try {
        groupToProfile = JSON.parse(cfg.oidcGroupMap) as Record<string, string>;
      } catch {
        // Invalid JSON — ignore
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
    const provider = buildOidcProvider(state);
    if (!provider) {
      res.status(503).json({ error: 'OIDC is not configured.' });
      return;
    }

    cleanupExpiredStates();

    // Validate the optional redirect param: must be a relative path starting
    // with '/' but NOT '//' (protocol-relative URL would be an open redirect).
    const rawRedirect = typeof req.query['redirect'] === 'string' ? req.query['redirect'] : undefined;
    const safeRedirect =
      rawRedirect !== undefined &&
      rawRedirect.startsWith('/') &&
      !rawRedirect.startsWith('//')
        ? rawRedirect
        : undefined;

    try {
      const stateParam = crypto.randomBytes(16).toString('hex');
      const codeVerifier = provider.generateCodeVerifier();

      pendingOidcStates.set(stateParam, {
        codeVerifier,
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
        ...(safeRedirect !== undefined ? { redirect: safeRedirect } : {}),
      });

      const authUrl = await provider.getAuthorizationUrl(stateParam, codeVerifier);
      res.redirect(authUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('[OIDC] Login initiation failed', { error: message });
      res.status(500).json({ error: 'Failed to initiate OIDC login' });
    }
  });

  /**
   * GET /api/auth/oidc/callback — Handle IdP callback.
   * Validates state, exchanges code, verifies token, finds/creates user, creates session.
   */
  app.get('/api/auth/oidc/callback', async (req: Request, res: Response) => {
    const provider = buildOidcProvider(state);
    if (!provider) {
      res.status(503).json({ error: 'OIDC is not configured.' });
      return;
    }

    const { code, state: stateParam, error: oidcError } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    // Handle IdP errors
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

    // Consume the state (one-time use)
    pendingOidcStates.delete(stateParam);
    const { codeVerifier, redirect: pendingRedirect } = pendingState;

    try {
      // Exchange code for tokens
      const { idToken } = await provider.exchangeCode(code, codeVerifier);

      // Verify and decode the ID token
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
            : email ?? 'SSO User';

      const groups = provider.getGroups(payload);
      const mappedProfiles = provider.mapGroupsToProfiles(groups);

      // Extract custom attributes from token claims (for data scoping)
      const claimsAttrs = provider.extractCustomAttributes(payload);

      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ error: 'User manager not initialized.' });
        return;
      }

      // Determine whether the redirect targets a profile with authMode === 'sso'.
      // Only grant auto-access when the profile explicitly trusts the IdP as gatekeeper.
      const chatRedirectMatch =
        pendingRedirect !== undefined
          ? /^\/chat\/([a-zA-Z0-9_-]+)$/.exec(pendingRedirect)
          : null;
      const ssoTargetProfileName = chatRedirectMatch ? chatRedirectMatch[1] : null;
      const ssoTargetProfile =
        ssoTargetProfileName !== null ? (state.serveProfiles[ssoTargetProfileName] ?? null) : null;
      const ssoAutoGrant =
        ssoTargetProfile !== null && ssoTargetProfile.authMode === 'sso'
          ? ssoTargetProfileName!
          : null;

      // Compute IdP scope: the set of profile names whose access is delegated to the IdP.
      // These are exactly the values of the groupToProfile mapping — the admin opts in
      // by adding a profile there. Profiles outside this set are admin-controlled.
      const idpScope = new Set<string>(Object.values(provider.getGroupToProfile()));

      // What the IdP currently grants based on JWT groups (no ssoAutoGrant here —
      // ssoAutoGrant is a one-off for new users only).
      const desiredFromIdp = new Set<string>(mappedProfiles);

      // Find or create user by OIDC subject
      let userId: string | null = null;
      const existingBySubject = userManager.getUserByOidcSubject(subject);

      // Capture the non-null userManager in a local const so the closure below
      // can use it without TypeScript raising "possibly null" inside the function body.
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

        // Add newly granted profiles
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

        // Remove revoked profiles within IdP scope
        for (const profileName of idpScope) {
          if (currentNames.has(profileName) && !desiredFromIdp.has(profileName)) {
            um.removeProfileAccess(existingUser.id, profileName);
          }
        }
      };

      if (existingBySubject) {
        // User already linked to this OIDC subject — apply destructive IdP-scope sync
        // and refresh custom attributes from the latest SSO claims.
        userId = existingBySubject.id;
        applyIdpSync(existingBySubject);
        if (claimsAttrs) {
          const merged = { ...(existingBySubject.customAttributes ?? {}), ...claimsAttrs };
          userManager.setCustomAttributes(userId, merged);
        }
        await userManager.save();
      } else if (email) {
        // Try to find by email
        const existingByEmail = userManager.getUserByEmail(email);
        if (existingByEmail) {
          // Link OIDC subject to existing account, apply destructive IdP-scope sync,
          // and refresh custom attributes from the latest SSO claims.
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
        // No existing user — auto-create if allowed.
        // DB config takes priority over env var config.
        const dbCfg = state.oidcConfigManager?.getConfig();
        const autoCreate = dbCfg?.enabled ? dbCfg.autoCreateUsers : (state.config?.oidcAutoCreateUsers ?? true);
        if (!autoCreate) {
          res.status(403).json({ error: 'Account not found and auto-creation is disabled.' });
          return;
        }

        if (!email) {
          res.status(400).json({ error: 'Cannot create user: ID token missing email claim.' });
          return;
        }

        // Build profile access list from group mapping
        const profileAccesses: UserProfileAccess[] = mappedProfiles.map((profileName) => ({
          profileName,
          allowedTables: null,
          allowedTools: null,
          accessMode: 'both' as const,
        }));

        // If the login originated from an SSO-gated chat page, inject that profile
        // so the user has access immediately after creation.  When a target SSO
        // profile is resolved we use it instead of the generic 'default' fallback.
        if (ssoAutoGrant !== null && !profileAccesses.some((p) => p.profileName === ssoAutoGrant)) {
          profileAccesses.push({
            profileName: ssoAutoGrant,
            allowedTables: null,
            allowedTools: null,
            accessMode: 'both' as const,
          });
        }

        // OIDC users need at least one profile to be created.
        // Use 'default' as last resort only when no group mapping AND no SSO target resolved.
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

        // Activate the user immediately (no onboarding needed for SSO)
        userManager.consumeOnboardingCode(newUser.onboardingCode!);
        userManager.setOidcSubject(newUser.id, subject);
        await userManager.save();
        userId = newUser.id;
      }

      // Create session for the user.
      // Always set the user cookie so chat pages work.
      // Additionally set the admin cookie when the user has admin role, so
      // that admin SSO logins continue to reach the admin dashboard.
      const sessionId = createSession(userId);
      setUserSessionCookie(res, sessionId);
      const resolvedUser = userManager.getUserById(userId);
      if (resolvedUser?.role === 'admin') {
        setSessionCookie(res, sessionId);
      }

      // Redirect to the originally requested page, falling back to the root.
      res.redirect(pendingRedirect ?? '/');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('[OIDC] Callback failed', { error: message });
      res.status(500).json({ error: 'OIDC authentication failed. Please try again or contact your administrator.' });
    }
  });
}
