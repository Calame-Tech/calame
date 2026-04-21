/**
 * Token-based authentication for per-profile chat pages.
 *
 * POST /api/chat-auth/token
 *
 * Validates a Calame user token, verifies the user has access to the
 * requested profile, and creates a user session.  Intended for profiles
 * with authMode === 'token' where the user pastes their token on the chat
 * login page.
 *
 * This route is PUBLIC — registered BEFORE the admin session middleware.
 */

import type { Express } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import type { AppState } from '../state.js';
import {
  createSession,
  setUserSessionCookie,
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
} from '../session.js';

const tokenAuthSchema = z.object({
  token: z.string().min(1, 'Token is required.'),
  profileName: z.string().min(1, 'Profile name is required.'),
});

export function registerChatAuthRoute(app: Express, state: AppState): void {
  /**
   * POST /api/chat-auth/token
   *
   * Body: { token: string, profileName: string }
   *
   * Validates the token against the user store, checks profile access,
   * and returns a session cookie + safe user info.
   */
  app.post('/api/chat-auth/token', async (req, res) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    if (isRateLimited(ip)) {
      res.status(429).json({
        success: false,
        message: 'Too many attempts. Please wait 1 minute.',
      });
      return;
    }

    const parsed = tokenAuthSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message ?? 'Invalid request body.',
      });
      return;
    }

    const { token, profileName } = parsed.data;

    // Sanitize profile name
    if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) {
      res.status(400).json({ success: false, message: 'Invalid profile name.' });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    // Verify the profile exists — allow any authMode that accepts tokens
    const serveProfile = state.serveProfiles[profileName];
    if (serveProfile) {
      const authMode = serveProfile.authMode ?? 'token';
      // Only reject if the profile explicitly disallows token-based access
      if (authMode === 'open') {
        res.status(403).json({
          success: false,
          message: 'This profile is open — no token needed.',
        });
        return;
      }
    }

    // Try 1: Validate as a user token (UserManager)
    const user = userManager.verifyToken(token);
    if (user) {
      if (user.status !== 'active') {
        recordFailedAttempt(ip);
        res.status(403).json({
          success: false,
          message: 'Your account has been disabled. Contact your administrator.',
        });
        return;
      }

      // Verify the user has access to this profile
      const profileAccess = user.profiles.find((p) => p.profileName === profileName);
      if (!profileAccess) {
        recordFailedAttempt(ip);
        res.status(403).json({
          success: false,
          message: 'You do not have access to this profile.',
        });
        return;
      }

      if (profileAccess.accessMode === 'mcp') {
        res.status(403).json({
          success: false,
          message: 'Chat access is not enabled for this profile.',
        });
        return;
      }

      clearFailedAttempts(ip);
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
      return;
    }

    // Try 2: Validate as a legacy profile token (TokenManager)
    const tokenManager = state.tokenManager;
    if (tokenManager) {
      const tokenEntry = tokenManager.verifyToken(token);
      if (tokenEntry && tokenEntry.profileName === profileName) {
        clearFailedAttempts(ip);

        // Legacy tokens don't have a user — create a session with the token ID
        const sessionId = createSession(tokenEntry.id);
        setUserSessionCookie(res, sessionId);

        res.json({
          success: true,
          user: {
            id: tokenEntry.id,
            name: tokenEntry.label || 'Token User',
            email: '',
            role: 'user',
            profiles: [{ profileName: tokenEntry.profileName, allowedTables: null, allowedTools: null, accessMode: 'both' as const }],
          },
        });
        return;
      }
    }

    // Try 3: External token validation (for 'external' authMode)
    if (serveProfile?.authMode === 'external' && serveProfile.externalAuthConfig) {
      const { validateExternalToken } = await import('../external-auth.js');
      const result = await validateExternalToken(token, serveProfile.externalAuthConfig);

      if (result.valid) {
        clearFailedAttempts(ip);

        const email = result.email;
        const displayName = result.name || 'External User';
        const autoCreate = serveProfile.externalAuthConfig.autoCreateUsers !== false; // default true

        // Try to find existing user by email
        let existingUser = email ? userManager.getUserByEmail(email) : null;

        if (!existingUser && !autoCreate) {
          // Auto-create disabled — reject unknown users
          res.status(403).json({
            success: false,
            message: 'Your external account is valid but you do not have a Calame account. Contact your administrator.',
          });
          return;
        }

        if (!existingUser) {
          // Auto-create user with access to this profile
          const userEmail = email || `external_${crypto.randomUUID()}@calame.local`;
          const created = userManager.createUser({
            name: displayName,
            email: userEmail,
            role: 'user',
            profiles: [
              {
                profileName,
                allowedTables: null,
                allowedTools: null,
                accessMode: 'both',
              },
            ],
          });
          // Activate immediately (skip onboarding)
          if (created.onboardingCode) {
            userManager.consumeOnboardingCode(created.onboardingCode);
          }
          existingUser = userManager.getUserById(created.id);
          if (!existingUser) {
            res.status(500).json({ success: false, message: 'Failed to create user account.' });
            return;
          }
        }

        if (existingUser && existingUser.status === 'active') {
          const sessionId = createSession(existingUser.id);
          setUserSessionCookie(res, sessionId);

          res.json({
            success: true,
            user: {
              id: existingUser.id,
              name: existingUser.name,
              email: existingUser.email,
              role: existingUser.role,
              profiles: existingUser.profiles,
            },
          });
          return;
        }

        if (existingUser && existingUser.status !== 'active') {
          res.status(403).json({
            success: false,
            message: 'Your account has been disabled. Contact your administrator.',
          });
          return;
        }
      }
    }

    // Neither user token nor legacy token matched
    recordFailedAttempt(ip);
    res.status(401).json({ success: false, message: 'Invalid token.' });
  });
}
