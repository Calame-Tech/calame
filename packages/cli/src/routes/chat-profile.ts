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
import { upgradeProfileShape } from '@calame/core';
import { DEFAULT_TENANT_ID } from '../tenancy.js';

/** Shape of the response profile object. */
interface ChatProfileInfo {
  name: string;
  label: string;
  authMode: 'open' | 'token' | 'calame' | 'sso' | 'oauth' | 'external';
  active: boolean;
  oauthProvider?: 'github' | 'google' | 'gitlab' | 'custom';
  /** AI settings the client may pick from. First entry is the default. */
  aiSettings?: Array<{ name: string; label: string }>;
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
    // Phase B multi-tenancy: this is a PUBLIC endpoint consumed by login
    // pages that cannot inject an `X-Tenant-Id` header. We pin the lookup
    // to the default tenant for the MVP. Phase C will revisit this when
    // the session-derived tenant is available before this handler runs.
    const row = state.db.raw
      .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
      .get(DEFAULT_TENANT_ID) as { data: string } | undefined;

    if (!row) return null;

    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    if (!parsed.profiles || typeof parsed.profiles !== 'object') return null;

    const profilesRaw = parsed.profiles as Record<string, unknown>;
    const profileRaw = profilesRaw[profileName];
    if (!profileRaw || typeof profileRaw !== 'object') return null;

    // Run the raw JSON through the shape migrator so legacy and unified
    // profiles emerge with the same structure. Field names from the storage
    // (e.g. `selectedTables`, `tableOptions`) are preserved when present so
    // they remain visible to legacy consumers reading the result directly.
    return upgradeProfileShape({ ...profileRaw, name: profileName });
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

      // Resolve the AI settings the client may pick from (label only — no API key, no provider).
      const mgr = state.aiSettingsManager;
      if (mgr) {
        const allowed = (profile.aiSettingNames ?? []).filter(Boolean);
        if (allowed.length > 0) {
          const resolved = allowed
            .map((name) => mgr.getSetting(name))
            .filter((s): s is NonNullable<typeof s> => s !== null)
            .map((s) => ({ name: s.name, label: s.label }));
          if (resolved.length > 0) info.aiSettings = resolved;
        } else {
          // No explicit list → expose the global fallback (first one) so the client knows what is used.
          const fallback = mgr.listSettings()[0];
          if (fallback) info.aiSettings = [{ name: fallback.name, label: fallback.label }];
        }
      }

      res.json({ success: true, profile: info });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error(`[GET /api/chat-profile/${profileName}] ${message}`);
      res.status(500).json({ success: false, message: 'Failed to load profile info.' });
    }
  });
}
