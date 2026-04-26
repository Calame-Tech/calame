import type { AppState } from './state.js';
import type { AiSetting } from './ai-config.js';

export type AiResolution =
  | { ok: true; setting: AiSetting }
  | { ok: false; status: number; message: string };

/**
 * Resolve which AI setting to use for a chat turn against a given MCP profile.
 *
 * Order of precedence:
 *   1. If `requestedName` is provided, it must be one of the profile's `aiSettingNames`
 *      (or, when the profile has no list, must exist globally). Otherwise 403.
 *   2. Otherwise use the first entry of `profile.aiSettingNames`.
 *   3. Otherwise fall back to the first globally configured setting (legacy / single-config).
 */
export function resolveAiSetting(
  state: AppState,
  profileName: string | null | undefined,
  requestedName?: string,
): AiResolution {
  const mgr = state.aiSettingsManager;
  if (!mgr) {
    return { ok: false, status: 500, message: 'AI settings manager not initialized.' };
  }

  const profile = profileName ? state.serveProfiles[profileName] : undefined;
  const allowed = (profile?.aiSettingNames ?? []).filter(Boolean);

  if (requestedName) {
    if (allowed.length > 0 && !allowed.includes(requestedName)) {
      return {
        ok: false,
        status: 403,
        message: `AI setting "${requestedName}" is not allowed for this MCP.`,
      };
    }
    const setting = mgr.getSetting(requestedName);
    if (!setting) {
      return { ok: false, status: 404, message: `AI setting "${requestedName}" not found.` };
    }
    return { ok: true, setting };
  }

  for (const name of allowed) {
    const setting = mgr.getSetting(name);
    if (setting) return { ok: true, setting };
  }

  const fallback = mgr.listSettings()[0];
  if (fallback) return { ok: true, setting: fallback };

  return {
    ok: false,
    status: 503,
    message: 'AI chat is not configured. Go to AI Settings to set up a provider.',
  };
}
