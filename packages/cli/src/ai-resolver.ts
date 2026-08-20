import type { AppState } from './state.js';
import type { AiSetting } from './ai-config.js';
import { settingSupports } from './ai-config.js';

/** An AiSetting known to support chat — see {@link isChatCapable}. */
export type ChatCapableAiSetting = AiSetting & { provider: 'anthropic' | 'openrouter' | 'custom' };

export type AiResolution =
  | { ok: true; setting: ChatCapableAiSetting }
  | { ok: false; status: number; message: string };

/**
 * True when `setting` can be used for a chat turn. Excludes embeddings-only
 * settings (today: only `provider: 'local'`, enforced at the DB layer by
 * `validateCapabilities` in ai-config.ts — a local setting can never have
 * the `chat` capability) — but also any OTHER setting explicitly configured
 * as embeddings-only (e.g. an OpenRouter setting with
 * `capabilities: ['embeddings']`), which was already a latent bug before
 * `local` existed: `listSettings()[0]` could silently be a non-chat setting.
 *
 * The `provider !== 'local'` check is redundant with `settingSupports(...,
 * 'chat')` in principle (a local setting can never pass it), but it's what
 * gives TypeScript the control-flow narrowing to `ChatCapableAiSetting`
 * without a cast — see the callers below.
 */
export function isChatCapable(setting: AiSetting): setting is ChatCapableAiSetting {
  return setting.provider !== 'local' && settingSupports(setting, 'chat');
}

/**
 * Resolve which AI setting to use for a chat turn against a given MCP profile.
 *
 * Order of precedence:
 *   1. If `requestedName` is provided, it must be one of the profile's `aiSettingNames`
 *      (or, when the profile has no list, must exist globally). Otherwise 403.
 *      It must also support chat — otherwise 400.
 *   2. Otherwise use the first entry of `profile.aiSettingNames` that supports chat.
 *   3. Otherwise fall back to the first globally configured chat-capable setting
 *      (legacy / single-config).
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
    if (!isChatCapable(setting)) {
      return {
        ok: false,
        status: 400,
        message: `AI setting "${requestedName}" does not support chat.`,
      };
    }
    return { ok: true, setting };
  }

  for (const name of allowed) {
    const setting = mgr.getSetting(name);
    if (setting && isChatCapable(setting)) return { ok: true, setting };
  }

  const fallback = mgr.listSettings().find(isChatCapable);
  if (fallback) return { ok: true, setting: fallback };

  return {
    ok: false,
    status: 503,
    message: 'AI chat is not configured. Go to AI Settings to set up a provider.',
  };
}
