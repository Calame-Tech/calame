import type { Express } from 'express';
import type { AppState } from '../state.js';
import { getProfileTableNames } from '@calame/core';

export function registerOnboardingRoute(app: Express, state: AppState): void {
  /**
   * GET /api/onboarding/:code — Validate an onboarding code and return user info.
   * Public endpoint (no admin session required).
   */
  app.get('/api/onboarding/:code', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const { code } = req.params;
      const user = userManager.getUserByOnboardingCode(code);
      if (!user) {
        res.status(404).json({
          success: false,
          message: 'Invalid or expired onboarding code.',
        });
        return;
      }

      // Build profile info for all user's profiles
      const host = req.headers.host ?? `localhost:${req.socket.localPort ?? 4567}`;
      const protocol = req.secure ? 'https' : 'http';

      const profilesInfo = user.profiles.map((pa) => {
        const profile = state.serveProfiles[pa.profileName];
        const tableNames = profile ? getProfileTableNames(profile) : [];
        const tables = tableNames.filter((t) => !pa.allowedTables || pa.allowedTables.includes(t));
        const mcpUrl = `${protocol}://${host}/mcp/${pa.profileName}`;
        return {
          profileName: pa.profileName,
          accessMode: pa.accessMode,
          tables,
          mcpUrl: pa.accessMode !== 'chat' ? mcpUrl : null,
        };
      });

      res.json({
        success: true,
        user: {
          name: user.name,
          profiles: profilesInfo,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, message });
    }
  });

  /**
   * POST /api/onboarding/:code/activate — Consume the onboarding code and activate the user.
   * Returns the plaintext token (shown once, never again).
   */
  app.post('/api/onboarding/:code/activate', async (req, res) => {
    try {
      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const { code } = req.params;
      const { password } = req.body as { password?: string };

      if (!password || typeof password !== 'string' || password.length < 8) {
        res.status(400).json({
          success: false,
          message: 'Password is required (minimum 8 characters).',
        });
        return;
      }

      const user = userManager.getUserByOnboardingCode(code);
      if (!user) {
        res.status(404).json({
          success: false,
          message: 'Invalid or expired onboarding code.',
        });
        return;
      }

      // Set password, activate the user, and generate a fresh token
      userManager.setPassword(user.id, password);
      const result = userManager.enableUser(user.id);
      if (!result) {
        res.status(500).json({ success: false, message: 'Failed to activate user.' });
        return;
      }

      // Clear the onboarding code
      userManager.consumeOnboardingCode(code);
      await userManager.save();

      // Build MCP URLs for all profiles
      const host = req.headers.host ?? `localhost:${req.socket.localPort ?? 4567}`;
      const protocol = req.secure ? 'https' : 'http';

      const mcpUrls = result.profiles
        .filter((p) => p.accessMode !== 'chat')
        .map((p) => ({
          profileName: p.profileName,
          url: `${protocol}://${host}/mcp/${p.profileName}`,
        }));

      res.json({
        success: true,
        plaintextToken: result._plaintextToken,
        mcpUrls,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, message });
    }
  });
}
