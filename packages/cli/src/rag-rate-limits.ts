// Parse `CALAME_RAG_RATE_LIMIT_<TYPE>` env vars into a `RateLimit` map suitable
// for `RateLimiter`'s `limits` constructor option. Lives in a dedicated module
// so unit tests can exercise the parser without booting the rag runtime.
//
// Format: `CALAME_RAG_RATE_LIMIT_<TYPE>=<refillPerSec>:<capacity>`
//   - Example: `CALAME_RAG_RATE_LIMIT_NOTION=3:9` → notion bucket allows a 9
//     burst, sustained at 3 req/sec.
//   - Both numbers must be > 0 and finite. Invalid values are logged and
//     skipped — the runtime falls back to the built-in DEFAULT_LIMITS for
//     that type so a typo never silently disables throttling.

/** Shape echoed by `@calame-ee/rag-core`'s `RateLimit`. Duplicated to keep
 * this module synchronously importable without forcing the EE dep on
 * apache-only builds. */
export interface ParsedRateLimit {
  capacity: number;
  refillPerSec: number;
}

const ENV_PREFIX = 'CALAME_RAG_RATE_LIMIT_';

/** Known connector types — used to print a helpful "did you mean" warning when
 * an env var sets a limit for a type that won't be respected. We do NOT
 * filter unknown types out (forward-compat: future connectors should pick up
 * their env overrides without a code change in this file) — we only warn. */
const KNOWN_TYPES = new Set(['notion', 'cohere', 'sharepoint', 'gdrive', 'gsheets', 's3', 'http']);

/**
 * Parse every `CALAME_RAG_RATE_LIMIT_*` env var on the supplied `env` map
 * and return a `{ type: RateLimit }` partial. Logs a warning for each invalid
 * entry but never throws — the caller treats this as best-effort overrides
 * layered on top of the built-in `DEFAULT_LIMITS`.
 *
 * @param env    Object whose keys are env-var names. Defaults to
 *               `process.env` for the typical wiring; tests inject a fixture.
 * @param logger Optional logger used for malformed entries (falls back to
 *               console).
 */
export function parseRateLimitEnv(
  env: Record<string, string | undefined> = process.env,
  logger?: { warn: (msg: string) => void },
): Record<string, ParsedRateLimit> {
  const out: Record<string, ParsedRateLimit> = {};
  const warn = (msg: string): void => {
    if (logger) logger.warn(msg);
    else console.warn(msg);
  };

  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX)) continue;
    if (typeof rawValue !== 'string' || rawValue.length === 0) continue;

    const type = key.slice(ENV_PREFIX.length).toLowerCase();
    if (type.length === 0) {
      warn(`Ignoring env var "${key}": connector type is empty after prefix.`);
      continue;
    }

    const parts = rawValue.split(':');
    if (parts.length !== 2) {
      warn(
        `Ignoring env var "${key}=${rawValue}": expected "<refillPerSec>:<capacity>" (e.g. "3:9").`,
      );
      continue;
    }

    const refillPerSec = Number(parts[0]);
    const capacity = Number(parts[1]);
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      warn(`Ignoring env var "${key}=${rawValue}": refillPerSec must be a positive finite number.`);
      continue;
    }
    if (!Number.isFinite(capacity) || capacity <= 0) {
      warn(`Ignoring env var "${key}=${rawValue}": capacity must be a positive finite number.`);
      continue;
    }

    if (!KNOWN_TYPES.has(type)) {
      warn(
        `Note: env var "${key}" sets a rate limit for an unknown connector type "${type}". ` +
          `Continuing — this is forward-compatible, but verify the type name matches a real connector.`,
      );
    }

    out[type] = { capacity, refillPerSec };
  }

  return out;
}
