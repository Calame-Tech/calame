/**
 * Per-profile "AI instructions" (`ServeProfile.aiInstructions`).
 *
 * Plain text / Markdown, at most {@link AI_INSTRUCTIONS_MAX_LENGTH} characters
 * (UTF-16 code units, the same unit as a browser `<textarea maxlength>`),
 * counted after trimming. Over the limit the save is refused — never truncated.
 * Absent, empty or whitespace-only values mean "no instructions".
 *
 * The text itself must never reach logs, audit entries or error messages.
 */
export const AI_INSTRUCTIONS_MAX_LENGTH = 4000;

export type AiInstructionsValidation =
  | { ok: true; value: string }
  | { ok: false; code: 'ai_instructions_invalid' | 'ai_instructions_too_long'; message: string };

/**
 * Validate a raw `aiInstructions` value coming from the API.
 * `undefined` / `null` normalize to `''` (cleared). On success `value` is trimmed.
 */
export function validateAiInstructions(raw: unknown): AiInstructionsValidation {
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'ai_instructions_invalid',
      message: 'AI instructions must be a text value.',
    };
  }
  const value = raw.trim();
  if (value.length > AI_INSTRUCTIONS_MAX_LENGTH) {
    return {
      ok: false,
      code: 'ai_instructions_too_long',
      message: `AI instructions are limited to ${AI_INSTRUCTIONS_MAX_LENGTH} characters (received ${value.length}). Nothing was saved.`,
    };
  }
  return { ok: true, value };
}

/** Effective instructions of a profile: trimmed text, or `undefined` when none. */
export function getProfileAiInstructions(
  profile: { aiInstructions?: unknown } | null | undefined,
): string | undefined {
  const raw = profile?.aiInstructions;
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}
