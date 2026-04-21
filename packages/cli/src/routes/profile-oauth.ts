/**
 * Per-profile OAuth 2.0 login flow.
 *
 * Routes registered:
 *   GET  /mcp/:profile/oauth/login    — Redirect to OAuth provider authorization URL.
 *   GET  /mcp/:profile/oauth/callback — Exchange code for token, find/create user, return Bearer.
 *
 * These routes are public (registered before the admin session middleware).
 */

import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import type { AppState } from '../state.js';
import { getOAuthProvider } from '../oauth-providers.js';
import type { UserProfileAccess } from '../user.js';

/** PKCE state entry stored while the OAuth round-trip is in flight. */
interface PendingOAuthState {
  codeVerifier: string;
  profileName: string;
  expiresAt: number;
}

/** In-memory store for pending OAuth states (cleared on restart — intentional). */
const pendingStates = new Map<string, PendingOAuthState>();

/** Clean up entries that have expired (older than 10 minutes). */
function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [key, value] of pendingStates.entries()) {
    if (now > value.expiresAt) {
      pendingStates.delete(key);
    }
  }
}

/** Generate a PKCE code verifier (43–128 chars of URL-safe characters). */
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Derive the PKCE code challenge from a verifier (S256 method). */
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Exchange an authorization code for an access token at the provider's token endpoint. */
async function exchangeCodeForToken(
  tokenUrl: string,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed with status ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const accessToken = data['access_token'];
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('Token exchange response did not include an access_token');
  }
  return accessToken;
}

/** Fetch user information from the provider's userinfo endpoint. */
async function fetchUserInfo(
  userinfoUrl: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(userinfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Userinfo request failed with status ${response.status}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

export function registerProfileOAuthRoutes(app: Express, state: AppState): void {
  /**
   * GET /mcp/:profile/oauth/login
   *
   * Validates that the profile exists and has authMode === 'oauth', then builds the
   * authorization URL with PKCE and redirects the user to the OAuth provider.
   */
  app.get('/mcp/:profile/oauth/login', async (req: Request, res: Response) => {
    const profileName = req.params.profile as string;

    const profile = state.serveProfiles[profileName];
    if (!profile) {
      res.status(404).json({ error: `Profile "${profileName}" not found.` });
      return;
    }

    if (profile.authMode !== 'oauth') {
      res.status(400).json({ error: `Profile "${profileName}" does not use OAuth authentication.` });
      return;
    }

    const oauthConfig = profile.oauthConfig;
    if (!oauthConfig) {
      res.status(500).json({ error: `Profile "${profileName}" has authMode 'oauth' but no oauthConfig.` });
      return;
    }

    try {
      const providerConfig = getOAuthProvider(oauthConfig.provider, {
        authorizationUrl: oauthConfig.authorizationUrl,
        tokenUrl: oauthConfig.tokenUrl,
        userinfoUrl: oauthConfig.userinfoUrl,
      });

      cleanupExpiredStates();

      const stateParam = crypto.randomBytes(16).toString('hex');
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      pendingStates.set(stateParam, {
        codeVerifier,
        profileName,
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
      });

      const baseUrl = getBaseUrl(req);
      const redirectUri = `${baseUrl}/mcp/${encodeURIComponent(profileName)}/oauth/callback`;

      const authUrl = new URL(providerConfig.authorizationUrl);
      authUrl.searchParams.set('client_id', oauthConfig.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', providerConfig.scopes);
      authUrl.searchParams.set('state', stateParam);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      res.redirect(authUrl.toString());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error(`[OAuth] Login initiation failed for profile "${profileName}"`, {
        error: message,
      });
      res.status(500).json({ error: 'Failed to initiate OAuth login.' });
    }
  });

  /**
   * GET /mcp/:profile/oauth/callback
   *
   * Handles the redirect from the OAuth provider. Validates state, exchanges the
   * authorization code for an access token, fetches user info, finds or creates a
   * Calame user, and returns a Bearer token the client can use for MCP requests.
   */
  app.get('/mcp/:profile/oauth/callback', async (req: Request, res: Response) => {
    const profileName = req.params.profile as string;

    const {
      code,
      state: stateParam,
      error: oauthError,
    } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    if (oauthError) {
      res.status(400).json({ error: `OAuth provider returned error: ${oauthError}` });
      return;
    }

    if (!code || !stateParam) {
      res.status(400).json({ error: 'Missing code or state parameter.' });
      return;
    }

    const pendingState = pendingStates.get(stateParam);
    if (!pendingState || Date.now() > pendingState.expiresAt) {
      pendingStates.delete(stateParam);
      res.status(400).json({ error: 'Invalid or expired state parameter.' });
      return;
    }

    // Consume state (one-time use)
    pendingStates.delete(stateParam);

    if (pendingState.profileName !== profileName) {
      res.status(400).json({ error: 'State parameter does not match the requested profile.' });
      return;
    }

    const profile = state.serveProfiles[profileName];
    if (!profile) {
      res.status(404).json({ error: `Profile "${profileName}" not found.` });
      return;
    }

    const oauthConfig = profile.oauthConfig;
    if (!oauthConfig) {
      res.status(500).json({ error: `Profile "${profileName}" has no OAuth configuration.` });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ error: 'User manager not initialized.' });
      return;
    }

    try {
      const providerConfig = getOAuthProvider(oauthConfig.provider, {
        authorizationUrl: oauthConfig.authorizationUrl,
        tokenUrl: oauthConfig.tokenUrl,
        userinfoUrl: oauthConfig.userinfoUrl,
      });

      const baseUrl = getBaseUrl(req);
      const redirectUri = `${baseUrl}/mcp/${encodeURIComponent(profileName)}/oauth/callback`;

      // Exchange authorization code for provider access token
      const providerAccessToken = await exchangeCodeForToken(
        providerConfig.tokenUrl,
        code,
        oauthConfig.clientId,
        oauthConfig.clientSecret,
        redirectUri,
        pendingState.codeVerifier,
      );

      // Fetch user info from provider
      const userInfo = await fetchUserInfo(providerConfig.userinfoUrl, providerAccessToken);

      const providerId = userInfo[providerConfig.userIdField];
      const providerIdStr = providerId != null ? String(providerId) : null;

      if (!providerIdStr) {
        res.status(400).json({ error: 'OAuth provider did not return a user identifier.' });
        return;
      }

      const email =
        typeof userInfo[providerConfig.emailField] === 'string'
          ? (userInfo[providerConfig.emailField] as string)
          : null;
      const name =
        typeof userInfo[providerConfig.nameField] === 'string'
          ? (userInfo[providerConfig.nameField] as string)
          : email ?? 'OAuth User';

      // Build an OIDC-style subject: "<provider>:<id>"
      const oidcSubject = `oauth:${oauthConfig.provider}:${providerIdStr}`;

      let plaintextToken: string | null = null;

      // Find existing user linked to this OAuth subject
      const existingBySubject = userManager.getUserByOidcSubject(oidcSubject);

      if (existingBySubject) {
        if (existingBySubject.status !== 'active') {
          res.status(403).json({ error: 'Your account has been disabled. Contact your administrator.' });
          return;
        }
        plaintextToken = userManager.getUserToken(existingBySubject.id);
        await userManager.save();
      } else {
        // Security: do NOT auto-link by email — an attacker could create an OAuth
        // account with a victim's email and hijack their Calame account.
        // Instead, only match by oidcSubject (set during first OAuth login).
        // If no subject match, create a new account.

        // Auto-create user if not found
        if (!plaintextToken) {
          if (!email) {
            res.status(400).json({
              error: 'Cannot create account: OAuth provider did not return an email address.',
            });
            return;
          }

          const profileAccesses: UserProfileAccess[] = [
            {
              profileName,
              allowedTables: null,
              allowedTools: null,
              accessMode: 'both',
            },
          ];

          const newUser = userManager.createUser({
            name,
            email,
            role: 'user',
            profiles: profileAccesses,
          });

          // Activate immediately (no onboarding for OAuth users)
          userManager.consumeOnboardingCode(newUser.onboardingCode!);
          userManager.setOidcSubject(newUser.id, oidcSubject);
          await userManager.save();

          plaintextToken = newUser._plaintextToken;
        }
      }

      if (!plaintextToken) {
        res.status(500).json({ error: 'Failed to retrieve user token.' });
        return;
      }

      // Return the Calame Bearer token — the client uses this for subsequent MCP requests.
      res.json({
        success: true,
        token: plaintextToken,
        profileName,
        message: `Authenticated via ${providerConfig.name}. Use the token as a Bearer for MCP requests.`,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error(`[OAuth] Callback failed for profile "${profileName}"`, {
        error: message,
      });
      res.status(500).json({ error: 'OAuth authentication failed. Please try again.' });
    }
  });
}

function getBaseUrl(req: Request): string {
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return `${proto}://${host}`;
}
