import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import type { AppState } from '../state.js';
import { getOAuthProvider } from '../oauth-providers.js';
import type { OidcProvider, OidcSettingsConfig } from '@calame-ee/sso';

/**
 * Minimal OAuth 2.1 implementation for MCP auth (claude.ai compatibility).
 *
 * Flow:
 * 1. claude.ai discovers auth server via .well-known endpoints
 * 2. Registers a client via POST /register
 * 3. Redirects user to GET /authorize?profile=<name> — behaviour depends on the profile's authMode
 * 4. Server redirects back with an auth code
 * 5. claude.ai exchanges code for access token via POST /token
 * 6. Access token = forge token, used as Bearer for MCP requests
 *
 * authMode behaviours in GET /authorize:
 *   - 'token'    : Show "enter your token" form (default / backward-compat).
 *   - 'open'     : Auto-authorize immediately — no user input required.
 *   - 'calame' : Show email + password login form.
 *   - 'sso'      : Redirect to OIDC provider; complete OAuth flow on callback.
 *   - 'oauth'    : Redirect to the profile's OAuth provider; complete on callback.
 */

// ---------------------------------------------------------------------------
// In-memory stores (cleared on restart — intentional for dev/stateless mode)
// ---------------------------------------------------------------------------

const registeredClients = new Map<string, { clientId: string; redirectUris: string[] }>();
const authCodes = new Map<
  string,
  { forgeToken: string; clientId: string; redirectUri: string; codeChallenge?: string; expiresAt: number }
>();

/**
 * Pending OAuth authorize params stored while the user completes an SSO / OAuth round-trip.
 * Keyed by a random opaque state value that is stored in the provider's `state` param.
 */
interface PendingOAuthAuthorization {
  /** OAuth 2.1 client_id from the original /authorize request. */
  clientId: string;
  /** Redirect URI the MCP client wants the code delivered to. */
  redirectUri: string;
  /** OAuth 2.1 `state` from the original /authorize request (pass back on redirect). */
  oauthState: string;
  /** PKCE challenge from the original /authorize request. */
  codeChallenge: string;
  /** Profile name whose authMode triggered the redirect. */
  profileName: string;
  /** PKCE code verifier generated for the SSO / OAuth round-trip. */
  codeVerifier: string;
  expiresAt: number;
}

const pendingOAuthAuthorizations = new Map<string, PendingOAuthAuthorization>();

/** Remove entries older than 10 minutes. */
function cleanupPendingAuthorizations(): void {
  const now = Date.now();
  for (const [key, entry] of pendingOAuthAuthorizations.entries()) {
    if (now > entry.expiresAt) pendingOAuthAuthorizations.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerOAuthRoutes(app: Express, state: AppState): void {
  // --- OAuth Protected Resource Metadata (RFC 9728) ---

  /**
   * Per-resource metadata. When the path is mcp/<profileName> we include the profile name
   * as a query parameter on the authorization_endpoint so the authorize page can adapt its
   * UI to the profile's authMode without relying on the (unreliable) scope parameter.
   */
  app.get('/.well-known/oauth-protected-resource/:path(*)', (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    const path = req.params.path as string;

    // Extract profile name from paths like "mcp/myprofile"
    let authEndpoint = `${baseUrl}/authorize`;
    const mcpMatch = path.match(/^mcp\/([^/]+)/);
    if (mcpMatch) {
      authEndpoint = `${baseUrl}/authorize?profile=${encodeURIComponent(mcpMatch[1])}`;
    }

    res.json({
      resource: `${baseUrl}/${path}`,
      authorization_servers: [baseUrl],
      // Hint to the client which authorization endpoint to use (with profile context).
      // This is informational only — RFC 9728 §2 does not define authorization_endpoint
      // in resource metadata, but it does no harm and helps custom MCP clients.
      authorization_endpoint: authEndpoint,
    });
  });

  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl(_req);
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
    });
  });

  // --- OAuth Authorization Server Metadata (RFC 8414) ---
  app.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:read'],
    });
  });

  // --- Dynamic Client Registration (RFC 7591) ---
  app.post('/register', (req: Request, res: Response) => {
    const { redirect_uris, client_name } = (req.body as Record<string, unknown>) ?? {};
    const clientId = 'client_' + crypto.randomBytes(16).toString('hex');

    registeredClients.set(clientId, {
      clientId,
      redirectUris: Array.isArray(redirect_uris) ? (redirect_uris as string[]) : [],
    });

    res.status(201).json({
      client_id: clientId,
      client_name: client_name ?? 'MCP Client',
      redirect_uris: redirect_uris ?? [],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // --- Authorization Endpoint (GET) ---
  app.get('/authorize', async (req: Request, res: Response) => {
    const {
      client_id,
      redirect_uri,
      state: oauthState,
      code_challenge,
      code_challenge_method,
      response_type,
      profile: profileParam,
    } = req.query as Record<string, string | undefined>;

    if (response_type !== 'code') {
      res.status(400).json({ error: 'unsupported_response_type' });
      return;
    }

    // Determine authMode from the profile
    const profileName = typeof profileParam === 'string' ? profileParam : '';
    const profile = profileName ? state.serveProfiles[profileName] : undefined;
    const authMode = profile?.authMode ?? 'token';

    const baseParams = {
      clientId: client_id ?? '',
      redirectUri: redirect_uri ?? '',
      oauthState: oauthState ?? '',
      codeChallenge: code_challenge ?? '',
      codeChallengeMethod: code_challenge_method ?? '',
      profileName,
    };

    switch (authMode) {
      // ------------------------------------------------------------------
      case 'open': {
        // Auto-authorize immediately — no user interaction required.
        const code = crypto.randomBytes(32).toString('hex');
        authCodes.set(code, {
          forgeToken: '__open__',
          clientId: client_id ?? '',
          redirectUri: redirect_uri ?? '',
          codeChallenge: code_challenge,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });

        try {
          const url = new URL(redirect_uri ?? '');
          url.searchParams.set('code', code);
          if (oauthState) url.searchParams.set('state', oauthState);
          res.redirect(302, url.toString());
        } catch {
          res.status(400).json({ error: 'invalid_request', error_description: 'Invalid redirect_uri.' });
        }
        return;
      }

      // ------------------------------------------------------------------
      case 'calame': {
        // Show an email + password login form.
        res.type('html').send(buildCalameAuthPage({ ...baseParams, error: '' }));
        return;
      }

      // ------------------------------------------------------------------
      case 'sso': {
        // Redirect to the global OIDC provider; complete OAuth flow on callback.
        const oidcProvider = buildOidcProvider(state);
        if (!oidcProvider) {
          res.status(503).send(buildErrorPage('SSO is not configured on this server.'));
          return;
        }

        cleanupPendingAuthorizations();

        const ssoState = crypto.randomBytes(16).toString('hex');
        const codeVerifier = generateCodeVerifier();

        pendingOAuthAuthorizations.set(ssoState, {
          ...baseParams,
          codeVerifier,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });

        try {
          const authUrl = await oidcProvider.getAuthorizationUrl(ssoState, codeVerifier);
          res.redirect(authUrl);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          state.logger?.error('[OAuth/SSO] Failed to build OIDC authorization URL', { error: msg });
          res.status(500).send(buildErrorPage('Failed to initiate SSO login. Please try again.'));
        }
        return;
      }

      // ------------------------------------------------------------------
      case 'oauth': {
        // Redirect to the profile-specific OAuth provider; complete OAuth flow on callback.
        const oauthConfig = profile?.oauthConfig;
        if (!oauthConfig) {
          res.status(500).send(buildErrorPage(`Profile "${profileName}" has authMode 'oauth' but no OAuth provider is configured.`));
          return;
        }

        cleanupPendingAuthorizations();

        const providerState = crypto.randomBytes(16).toString('hex');
        const codeVerifier = generateCodeVerifier();

        pendingOAuthAuthorizations.set(providerState, {
          ...baseParams,
          codeVerifier,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });

        try {
          const providerConfig = getOAuthProvider(oauthConfig.provider, {
            authorizationUrl: oauthConfig.authorizationUrl,
            tokenUrl: oauthConfig.tokenUrl,
            userinfoUrl: oauthConfig.userinfoUrl,
          });

          const baseUrl = getBaseUrl(req);
          const codeChallenge = generateCodeChallenge(codeVerifier);
          const redirectUri = `${baseUrl}/authorize/oauth-callback`;

          const authUrl = new URL(providerConfig.authorizationUrl);
          authUrl.searchParams.set('client_id', oauthConfig.clientId);
          authUrl.searchParams.set('redirect_uri', redirectUri);
          authUrl.searchParams.set('response_type', 'code');
          authUrl.searchParams.set('scope', providerConfig.scopes);
          authUrl.searchParams.set('state', providerState);
          authUrl.searchParams.set('code_challenge', codeChallenge);
          authUrl.searchParams.set('code_challenge_method', 'S256');

          res.redirect(authUrl.toString());
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          state.logger?.error('[OAuth] Failed to build provider authorization URL', { error: msg });
          res.status(500).send(buildErrorPage('Failed to initiate OAuth login. Please try again.'));
        }
        return;
      }

      // ------------------------------------------------------------------
      case 'external': {
        // Show a form where the user enters their external (company) token.
        res.type('html').send(
          buildExternalAuthPage({
            clientId: client_id ?? '',
            redirectUri: redirect_uri ?? '',
            oauthState: oauthState ?? '',
            codeChallenge: code_challenge ?? '',
            codeChallengeMethod: code_challenge_method ?? '',
            profileName,
            profileLabel: profile?.label || profileName,
            error: '',
          }),
        );
        return;
      }

      // ------------------------------------------------------------------
      case 'token':
      default: {
        // Show the "enter your Calame token" form (backward-compatible default).
        res.type('html').send(buildTokenAuthPage(baseParams));
        return;
      }
    }
  });

  // --- Authorization Endpoint (POST) ---
  app.post('/authorize', async (req: Request, res: Response) => {
    const {
      client_id,
      redirect_uri,
      state: oauthState,
      code_challenge,
      auth_mode,
      profile: profileName,
    } = req.body as Record<string, string | undefined>;

    let forgeToken: string | null = null;

    switch (auth_mode) {
      // ------------------------------------------------------------------
      case 'calame': {
        const { email, password } = req.body as { email?: string; password?: string };
        const userManager = state.userManager;
        if (!userManager) {
          res.status(500).json({ error: 'User manager not initialized.' });
          return;
        }

        if (!email || !password) {
          const pageParams = {
            clientId: client_id ?? '',
            redirectUri: redirect_uri ?? '',
            oauthState: oauthState ?? '',
            codeChallenge: code_challenge ?? '',
            codeChallengeMethod: '',
            profileName: profileName ?? '',
          };
          res.type('html').send(buildCalameAuthPage({ ...pageParams, error: 'Email and password are required.' }));
          return;
        }

        const user = userManager.authenticateByEmail(email, password);
        if (!user) {
          const pageParams = {
            clientId: client_id ?? '',
            redirectUri: redirect_uri ?? '',
            oauthState: oauthState ?? '',
            codeChallenge: code_challenge ?? '',
            codeChallengeMethod: '',
            profileName: profileName ?? '',
          };
          res.type('html').send(buildCalameAuthPage({ ...pageParams, error: 'Invalid email or password.' }));
          return;
        }

        if (user.status !== 'active') {
          const pageParams = {
            clientId: client_id ?? '',
            redirectUri: redirect_uri ?? '',
            oauthState: oauthState ?? '',
            codeChallenge: code_challenge ?? '',
            codeChallengeMethod: '',
            profileName: profileName ?? '',
          };
          res.type('html').send(buildCalameAuthPage({ ...pageParams, error: 'Your account has been disabled.' }));
          return;
        }

        forgeToken = userManager.getUserToken(user.id);
        if (!forgeToken) {
          res.status(500).json({ error: 'User token is not available. Contact your administrator.' });
          return;
        }
        break;
      }

      // ------------------------------------------------------------------
      case 'external': {
        // Validate the token against the external API; if valid, mint a Calame user
        // token so the OAuth code can map to it like any other auth mode.
        const { forge_token: externalToken } = req.body as { forge_token?: string };
        if (!externalToken) {
          const pageParams = {
            clientId: client_id ?? '',
            redirectUri: redirect_uri ?? '',
            oauthState: oauthState ?? '',
            codeChallenge: code_challenge ?? '',
            codeChallengeMethod: '',
            profileName: profileName ?? '',
            profileLabel: profileName ?? '',
            error: 'Token is required.',
          };
          res.type('html').send(buildExternalAuthPage(pageParams));
          return;
        }

        const externalProfile = profileName ? state.serveProfiles[profileName] : undefined;
        if (!externalProfile?.externalAuthConfig) {
          res.status(500).json({ error: 'External auth not configured for this profile.' });
          return;
        }

        const { validateExternalToken } = await import('../external-auth.js');
        const externalResult = await validateExternalToken(
          externalToken,
          externalProfile.externalAuthConfig,
        );

        if (!externalResult.valid) {
          const pageParams = {
            clientId: client_id ?? '',
            redirectUri: redirect_uri ?? '',
            oauthState: oauthState ?? '',
            codeChallenge: code_challenge ?? '',
            codeChallengeMethod: '',
            profileName: profileName ?? '',
            profileLabel: externalProfile.label || (profileName ?? ''),
            error: 'Invalid token. Please try again.',
          };
          res.type('html').send(buildExternalAuthPage(pageParams));
          return;
        }

        // Token is valid — find or create a Calame user and use their token
        const userManager = state.userManager;
        if (!userManager) {
          res.status(500).json({ error: 'User manager not initialized.' });
          return;
        }

        const email =
          externalResult.email || `external_${Date.now()}@calame.local`;
        const displayName = externalResult.name || 'External User';

        let existingUser = email ? userManager.getUserByEmail(email) : null;

        if (!existingUser) {
          const created = userManager.createUser({
            name: displayName,
            email,
            role: 'user',
            profiles: [
              {
                profileName: profileName ?? '',
                allowedTables: null,
                allowedTools: null,
                accessMode: 'both',
              },
            ],
          });
          if (created.onboardingCode) {
            userManager.consumeOnboardingCode(created.onboardingCode);
          }
          existingUser = userManager.getUserById(created.id);
        }

        if (!existingUser || existingUser.status !== 'active') {
          res.status(403).json({ error: 'Account is not active.' });
          return;
        }

        const mintedToken = userManager.getUserToken(existingUser.id);
        if (!mintedToken) {
          res.status(500).json({ error: 'User token is not available. Contact your administrator.' });
          return;
        }

        forgeToken = mintedToken;
        break;
      }

      // ------------------------------------------------------------------
      case 'token':
      default: {
        const { forge_token } = req.body as { forge_token?: string };
        if (!forge_token) {
          res.status(400).json({ error: 'Token is required.' });
          return;
        }
        forgeToken = forge_token;
        break;
      }
    }

    if (!forgeToken) {
      res.status(400).json({ error: 'Authentication failed.' });
      return;
    }

    // Generate auth code that maps to the forge token
    const code = crypto.randomBytes(32).toString('hex');
    authCodes.set(code, {
      forgeToken,
      clientId: client_id ?? '',
      redirectUri: redirect_uri ?? '',
      codeChallenge: code_challenge,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    try {
      const url = new URL(redirect_uri ?? '');
      url.searchParams.set('code', code);
      if (oauthState) url.searchParams.set('state', oauthState);
      res.redirect(302, url.toString());
    } catch {
      res.status(400).json({ error: 'invalid_request', error_description: 'Invalid redirect_uri.' });
    }
  });

  // --- SSO (OIDC) callback — completes a pending OAuth authorization ---
  app.get('/authorize/sso-callback', async (req: Request, res: Response) => {
    const { code, state: ssoState, error: oidcError } = req.query as Record<string, string | undefined>;

    if (oidcError) {
      res.status(400).send(buildErrorPage(`SSO provider returned error: ${escapeHtml(oidcError)}`));
      return;
    }

    if (!code || !ssoState) {
      res.status(400).send(buildErrorPage('Missing code or state parameter from SSO provider.'));
      return;
    }

    const pending = pendingOAuthAuthorizations.get(ssoState);
    if (!pending || Date.now() > pending.expiresAt) {
      pendingOAuthAuthorizations.delete(ssoState);
      res.status(400).send(buildErrorPage('Authorization session expired. Please try again.'));
      return;
    }

    pendingOAuthAuthorizations.delete(ssoState);

    const oidcProvider = buildOidcProvider(state);
    if (!oidcProvider) {
      res.status(503).send(buildErrorPage('SSO is not configured on this server.'));
      return;
    }

    try {
      const { idToken } = await oidcProvider.exchangeCode(code, pending.codeVerifier);
      const payload = await oidcProvider.verifyIdToken(idToken);

      const subject = payload.sub;
      if (!subject) {
        res.status(400).send(buildErrorPage('SSO token missing sub claim.'));
        return;
      }

      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).send(buildErrorPage('User manager not initialized.'));
        return;
      }

      const user = userManager.getUserByOidcSubject(subject);
      if (!user || user.status !== 'active') {
        res.status(403).send(buildErrorPage('No active account found for your SSO identity.'));
        return;
      }

      const forgeToken = userManager.getUserToken(user.id);
      if (!forgeToken) {
        res.status(500).send(buildErrorPage('User token is not available. Contact your administrator.'));
        return;
      }

      await userManager.save();

      const authCode = crypto.randomBytes(32).toString('hex');
      authCodes.set(authCode, {
        forgeToken,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      const url = new URL(pending.redirectUri);
      url.searchParams.set('code', authCode);
      if (pending.oauthState) url.searchParams.set('state', pending.oauthState);
      res.redirect(302, url.toString());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      state.logger?.error('[OAuth/SSO] Callback processing failed', { error: msg });
      res.status(500).send(buildErrorPage('SSO authentication failed. Please try again.'));
    }
  });

  // --- OAuth provider callback — completes a pending OAuth authorization ---
  app.get('/authorize/oauth-callback', async (req: Request, res: Response) => {
    const { code, state: providerState, error: providerError } = req.query as Record<string, string | undefined>;

    if (providerError) {
      res.status(400).send(buildErrorPage(`OAuth provider returned error: ${escapeHtml(providerError)}`));
      return;
    }

    if (!code || !providerState) {
      res.status(400).send(buildErrorPage('Missing code or state parameter from OAuth provider.'));
      return;
    }

    const pending = pendingOAuthAuthorizations.get(providerState);
    if (!pending || Date.now() > pending.expiresAt) {
      pendingOAuthAuthorizations.delete(providerState);
      res.status(400).send(buildErrorPage('Authorization session expired. Please try again.'));
      return;
    }

    pendingOAuthAuthorizations.delete(providerState);

    const profile = pending.profileName ? state.serveProfiles[pending.profileName] : undefined;
    const oauthConfig = profile?.oauthConfig;
    if (!oauthConfig) {
      res.status(500).send(buildErrorPage('OAuth provider configuration not found for this profile.'));
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).send(buildErrorPage('User manager not initialized.'));
      return;
    }

    try {
      const providerConfig = getOAuthProvider(oauthConfig.provider, {
        authorizationUrl: oauthConfig.authorizationUrl,
        tokenUrl: oauthConfig.tokenUrl,
        userinfoUrl: oauthConfig.userinfoUrl,
      });

      const baseUrl = getBaseUrl(req);
      const redirectUri = `${baseUrl}/authorize/oauth-callback`;

      // Exchange authorization code for provider access token
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
        redirect_uri: redirectUri,
        code_verifier: pending.codeVerifier,
      });

      const tokenResponse = await fetch(providerConfig.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      });

      if (!tokenResponse.ok) {
        throw new Error(`Token exchange failed with status ${tokenResponse.status}`);
      }

      const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
      const providerAccessToken = tokenData['access_token'];
      if (typeof providerAccessToken !== 'string' || !providerAccessToken) {
        throw new Error('Token exchange response did not include an access_token');
      }

      // Fetch user info from provider
      const userInfoResponse = await fetch(providerConfig.userinfoUrl, {
        headers: { Authorization: `Bearer ${providerAccessToken}`, Accept: 'application/json' },
      });

      if (!userInfoResponse.ok) {
        throw new Error(`Userinfo request failed with status ${userInfoResponse.status}`);
      }

      const userInfo = (await userInfoResponse.json()) as Record<string, unknown>;
      const providerId = userInfo[providerConfig.userIdField];
      const providerIdStr = providerId != null ? String(providerId) : null;

      if (!providerIdStr) {
        res.status(400).send(buildErrorPage('OAuth provider did not return a user identifier.'));
        return;
      }

      const oidcSubject = `oauth:${oauthConfig.provider}:${providerIdStr}`;
      const existingUser = userManager.getUserByOidcSubject(oidcSubject);

      let forgeToken: string | null = null;

      if (existingUser) {
        if (existingUser.status !== 'active') {
          res.status(403).send(buildErrorPage('Your account has been disabled. Contact your administrator.'));
          return;
        }
        forgeToken = userManager.getUserToken(existingUser.id);
      } else {
        // No existing user — cannot auto-create in an OAuth2 MCP authorize context
        // because we have no email from the spec path, and auto-creation is a security risk.
        // Admins should pre-create users or use the profile-oauth route instead.
        res.status(403).send(
          buildErrorPage('No account found for your OAuth identity. Ask your administrator to create an account for you.'),
        );
        return;
      }

      if (!forgeToken) {
        res.status(500).send(buildErrorPage('User token is not available. Contact your administrator.'));
        return;
      }

      await userManager.save();

      const authCode = crypto.randomBytes(32).toString('hex');
      authCodes.set(authCode, {
        forgeToken,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      const url = new URL(pending.redirectUri);
      url.searchParams.set('code', authCode);
      if (pending.oauthState) url.searchParams.set('state', pending.oauthState);
      res.redirect(302, url.toString());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      state.logger?.error('[OAuth] Callback processing failed', { error: msg });
      res.status(500).send(buildErrorPage('OAuth authentication failed. Please try again.'));
    }
  });

  // --- Token Endpoint ---
  app.post('/token', (req: Request, res: Response) => {
    const { grant_type, code, code_verifier } = req.body as Record<string, string | undefined>;

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    const entry = code ? authCodes.get(code) : undefined;
    if (!entry) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code.' });
      return;
    }

    // Check expiry
    if (Date.now() > entry.expiresAt) {
      if (code) authCodes.delete(code);
      res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired.' });
      return;
    }

    // Verify PKCE code_verifier if code_challenge was provided
    if (entry.codeChallenge && code_verifier) {
      const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
      if (hash !== entry.codeChallenge) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid code_verifier.' });
        return;
      }
    }

    // Consume the code (one-time use)
    if (code) authCodes.delete(code);

    // Return the forge token as the OAuth access token.
    // '__open__' is a special marker for open-mode profiles — serve.ts accepts it.
    res.json({
      access_token: entry.forgeToken,
      token_type: 'Bearer',
      expires_in: 86400, // 24h — forge tokens do not actually expire, but OAuth requires this field
      scope: 'mcp:read',
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBaseUrl(req: Request): string {
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return `${proto}://${host}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Generate a PKCE code verifier (43–128 URL-safe characters). */
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Derive the PKCE code challenge from a verifier (S256 method). */
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Build an OidcProvider from app-state OIDC config (DB config preferred over env vars).
 *
 * Returns `null` when the SSO runtime is not loaded (EE package absent) or when
 * neither the DB config nor the env-var config have OIDC enabled. The callers that
 * receive `null` already return 503 "SSO is not configured", so the apache-only
 * code path is fully graceful.
 */
function buildOidcProvider(state: AppState): OidcProvider | null {
  const Oidc = state.ssoRuntime?.OidcProvider;
  if (!Oidc) return null;

  const dbConfig = state.oidcConfigManager?.getConfig() as OidcSettingsConfig | null | undefined;
  if (dbConfig?.enabled && dbConfig.issuerUrl && dbConfig.clientId) {
    return new Oidc({
      issuerUrl: dbConfig.issuerUrl,
      clientId: dbConfig.clientId,
      clientSecret: dbConfig.clientSecret || undefined,
      redirectUri: dbConfig.redirectUri,
      scopes: dbConfig.scopes,
      groupClaim: dbConfig.groupClaim,
      groupToProfile: dbConfig.groupToProfile,
      autoCreateUsers: dbConfig.autoCreateUsers,
    });
  }

  const cfg = state.config;
  if (!cfg?.oidcEnabled) return null;
  if (!cfg.oidcIssuerUrl || !cfg.oidcClientId || !cfg.oidcRedirectUri) return null;

  let groupToProfile: Record<string, string> = {};
  if (cfg.oidcGroupMap) {
    try {
      groupToProfile = JSON.parse(cfg.oidcGroupMap) as Record<string, string>;
    } catch {
      // Invalid JSON — ignore
    }
  }

  return new Oidc({
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

// ---------------------------------------------------------------------------
// HTML page builders
// ---------------------------------------------------------------------------

/** Shared inline CSS used by all auth pages. */
const PAGE_STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f1117;
    color: #e5e7eb;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 1rem;
  }
  .card {
    background: #1a1d27;
    border: 1px solid #2d3748;
    border-radius: 12px;
    padding: 2rem;
    max-width: 420px;
    width: 100%;
  }
  h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
  .subtitle { color: #9ca3af; font-size: 0.875rem; margin-bottom: 1.5rem; }
  label { display: block; font-size: 0.875rem; color: #9ca3af; margin-bottom: 0.375rem; }
  label + label { margin-top: 1rem; }
  input[type="text"],
  input[type="email"],
  input[type="password"] {
    width: 100%;
    padding: 0.625rem 0.75rem;
    border-radius: 8px;
    border: 1px solid #374151;
    background: #111827;
    color: #f3f4f6;
    font-size: 0.875rem;
    outline: none;
  }
  input[type="text"] { font-family: monospace; }
  input[type="text"]:focus,
  input[type="email"]:focus,
  input[type="password"]:focus { border-color: #6d28d9; }
  button {
    width: 100%;
    margin-top: 1rem;
    padding: 0.625rem;
    border-radius: 8px;
    border: none;
    background: #6d28d9;
    color: white;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: #5b21b6; }
  .hint { color: #6b7280; font-size: 0.75rem; margin-top: 0.75rem; }
  .error {
    background: #450a0a;
    border: 1px solid #7f1d1d;
    border-radius: 8px;
    color: #fca5a5;
    font-size: 0.875rem;
    padding: 0.625rem 0.75rem;
    margin-bottom: 1rem;
  }
`;

interface AuthPageParams {
  clientId: string;
  redirectUri: string;
  oauthState: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  profileName: string;
}

/** Token-based auth page — default / backward-compat. */
function buildTokenAuthPage(params: AuthPageParams): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calame - Authorize</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <h1>Authorize MCP Access</h1>
    <p class="subtitle">Enter your Calame token to grant access to your database tools.</p>
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(params.oauthState)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
      <input type="hidden" name="auth_mode" value="token">
      <input type="hidden" name="profile" value="${escapeHtml(params.profileName)}">
      <label for="forge_token">Calame Token</label>
      <input type="text" id="forge_token" name="forge_token" placeholder="fmcp_..." required autofocus>
      <button type="submit">Authorize</button>
      <p class="hint">Generate tokens in the Calame admin UI under the Tokens tab.</p>
    </form>
  </div>
</body>
</html>`;
}

/** Calame email + password auth page. */
function buildCalameAuthPage(params: AuthPageParams & { error: string }): string {
  const profileLabel = params.profileName ? ` to access <strong>${escapeHtml(params.profileName)}</strong>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calame - Sign In</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <h1>Sign in to Calame</h1>
    <p class="subtitle">Enter your Calame credentials${profileLabel}.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ''}
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(params.oauthState)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
      <input type="hidden" name="auth_mode" value="calame">
      <input type="hidden" name="profile" value="${escapeHtml(params.profileName)}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required autofocus>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="••••••••" required>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}

interface ExternalAuthPageParams extends AuthPageParams {
  profileLabel: string;
  error: string;
}

/** External token auth page — user enters a token from their company's system. */
function buildExternalAuthPage(params: ExternalAuthPageParams): string {
  const profileLabel = params.profileLabel || params.profileName;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calame - Authorize</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <h1>Authorize MCP Access</h1>
    <p class="subtitle">Enter your access token to connect to <strong>${escapeHtml(profileLabel)}</strong>.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ''}
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(params.oauthState)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
      <input type="hidden" name="auth_mode" value="external">
      <input type="hidden" name="profile" value="${escapeHtml(params.profileName)}">
      <label for="forge_token">Access Token</label>
      <input type="text" id="forge_token" name="forge_token" placeholder="Your external token..." required autofocus>
      <button type="submit">Authorize</button>
      <p class="hint">Contact your administrator if you do not have an access token.</p>
    </form>
  </div>
</body>
</html>`;
}

/** Generic error page for mid-flow failures. */
function buildErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calame - Authorization Error</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <h1>Authorization Error</h1>
    <div class="error" style="margin-top:1rem;">${escapeHtml(message)}</div>
    <p class="hint" style="margin-top:1rem;">Close this window and try again. If the problem persists, contact your administrator.</p>
  </div>
</body>
</html>`;
}
