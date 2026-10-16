import type { AppState } from './state.js';
import type { AiSetting } from './ai-config.js';
import { isSettingConfigured, settingSupports } from './ai-config.js';

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
 *
 * In steps 2 and 3 a setting with its credentials filled in wins over one
 * without. A setting that would be used but lacks its API key (or base URL for
 * `custom`) yields a 503 telling what to fill in, instead of letting the
 * provider call fail with an opaque authentication error.
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
    return checkCredentials(setting);
  }

  const allowedChat = allowed
    .map((name) => mgr.getSetting(name))
    .filter((s): s is AiSetting => s !== null)
    .filter(isChatCapable);
  const profileChoice = allowedChat.find(isSettingConfigured) ?? allowedChat[0];
  if (profileChoice) return checkCredentials(profileChoice);

  const globalChat = mgr.listSettings().filter(isChatCapable);
  const fallback = globalChat.find(isSettingConfigured) ?? globalChat[0];
  if (fallback) return checkCredentials(fallback);

  return {
    ok: false,
    status: 503,
    message: 'AI chat is not configured. Go to AI Settings to set up a provider.',
  };
}

const PROVIDER_NAMES: Record<ChatCapableAiSetting['provider'], string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  custom: 'custom endpoint',
};

/** Reject a chat setting whose credentials are missing, saying what to fill in and where. */
function checkCredentials(setting: ChatCapableAiSetting): AiResolution {
  if (isSettingConfigured(setting)) return { ok: true, setting };
  const missing = setting.provider === 'custom' ? 'base URL' : 'API key';
  return {
    ok: false,
    status: 503,
    message:
      `AI setting "${setting.label}" (${PROVIDER_NAMES[setting.provider]}) has no ${missing}. ` +
      `Go to Settings → AI, edit "${setting.label}" and enter its ${missing}.`,
  };
}
