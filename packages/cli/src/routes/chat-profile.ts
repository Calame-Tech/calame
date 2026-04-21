/**
 * Public endpoint for per-profile chat entry page.
 *
 * GET /api/chat-profile/:profileName
 *
 * Returns the public metadata a chat frontend needs to render the correct
 * login flow for a given serve profile.  This route is intentionally PUBLIC —
 * it must be registered BEFORE the admin session middleware in app.ts.
 *
 * Sensitive data (tokens, connection strings, OAuth secrets) is never returned.
 */

import type { Express } from 'express';
import type { AppState } from '../state.js';
import type { ServeProfile } from '@calame/core';

/** Shape of the response profile object. */
interface ChatProfileInfo {
  name: string;
  label: string;
  authMode: 'open' | 'token' | 'calame' | 'sso' | 'oauth' | 'external';
  active: boolean;
  oauthProvider?: 'github' | 'google' | 'gitlab' | 'custom';
}

/**
 * Load a single profile from SQLite by name.
 * Returns null if the DB is unavailable or the profile does not exist.
 */
async function loadProfileFromDb(
  state: AppState,
  profileName: string,
): Promise<ServeProfile | null> {
  if (!state.db) return null;

  try {
    const row = state.db.raw
      .prepare("SELECT data FROM profiles WHERE key = 'main'")
      .get() as { data: string } | undefined;

    if (!row) return null;

    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    if (!parsed.profiles || typeof parsed.profiles !== 'object') return null;

    const profilesRaw = parsed.profiles as Record<string, unknown>;
    const profileRaw = profilesRaw[profileName];
    if (!profileRaw || typeof profileRaw !== 'object') return null;

    const p = profileRaw as Record<string, unknown>;

    return {
      name: profileName,
      label: (p.label as string) ?? profileName,
      configurations: p.configurations as string[] | undefined,
      selectedTables: (p.selectedTables as Record<string, string[]>) ?? {},
      tableOptions: p.tableOptions,
      columnMasking: p.columnMasking,
      authMode: (p.authMode as ServeProfile['authMode']) ?? undefined,
      oauthConfig: p.oauthConfig as ServeProfile['oauthConfig'] | undefined,
      externalAuthConfig: p.externalAuthConfig as ServeProfile['externalAuthConfig'] | undefined,
    } as ServeProfile;
  } catch (err: unknown) {
    state.logger?.warn(`Failed to load profile "${profileName}" from DB`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function registerChatProfileRoute(app: Express, state: AppState): void {
  /**
   * GET /api/chat-profile/:profileName
   *
   * Public endpoint — no admin session required.
   * Returns lightweight profile info for the chat entry / login page.
   */
  app.get('/api/chat-profile/:profileName', async (req, res) => {
    const { profileName } = req.params as { profileName: string };

    // Sanitize: profile names should be alphanumeric + hyphens/underscores only
    if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) {
      res.status(400).json({ success: false, message: 'Invalid profile name.' });
      return;
    }

    try {
      // Prefer the in-memory serve profile (already loaded and active)
      let profile: ServeProfile | null = state.serveProfiles[profileName] ?? null;

      // Fall back to DB lookup so the endpoint works before serve/start is called
      if (!profile) {
        profile = await loadProfileFromDb(state, profileName);
      }

      if (!profile) {
        res.status(404).json({ success: false, message: 'Profile not found or not active.' });
        return;
      }

      const active = state.activeProfileNames.has(profileName);

      // Determine the effective authMode (default to 'token' — backward compatible)
      const authMode: ChatProfileInfo['authMode'] =
        (profile.authMode as ChatProfileInfo['authMode']) ?? 'token';

      const info: ChatProfileInfo = {
        name: profile.name,
        label: profile.label,
        authMode,
        active,
      };

      // Only expose the OAuth provider name — never expose client_id or client_secret
      if (authMode === 'oauth' && profile.oauthConfig?.provider) {
        info.oauthProvider = profile.oauthConfig.provider;
      }

      res.json({ success: true, profile: info });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error(`[GET /api/chat-profile/${profileName}] ${message}`);
      res.status(500).json({ success: false, message: 'Failed to load profile info.' });
    }
  });
}
