// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * PII masking for RAG search responses.
 *
 * Composes the Apache-2.0 text scanner from `@calame/core` and exposes:
 *   - {@link parseRagPiiConfig}: env-var → typed config parser.
 *   - {@link maskSearchResult}:  apply masking to every chunk in a
 *     {@link RagSearchResult} and return aggregate redaction counts.
 *
 * Only RESPONSES to the LLM are masked. The user's query is never masked
 * (the LLM wrote it — there's nothing to hide from itself).
 */

import {
  applyPiiMasking,
  DEFAULT_TEXT_PII_CATEGORIES,
  type PiiCategory,
  type TextMaskingMode,
} from '@calame/core';
import type { RagSearchResult } from './types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RagPiiMaskingConfig {
  enabled: boolean;
  mode: TextMaskingMode;
  /** Categories to mask. */
  categories: PiiCategory[];
}

const ALLOWED_MODES = new Set<TextMaskingMode>(['replace', 'hash', 'truncate', 'none']);

// Categories accepted in the env var. We only allow the ones our text scanner
// actually understands well — `name`/`address` are intentionally excluded.
const ALLOWED_CATEGORIES = new Set<PiiCategory>([...DEFAULT_TEXT_PII_CATEGORIES]);

function defaultConfig(): RagPiiMaskingConfig {
  return {
    enabled: true,
    mode: 'replace',
    categories: [...DEFAULT_TEXT_PII_CATEGORIES],
  };
}

function disabledConfig(): RagPiiMaskingConfig {
  return { enabled: false, mode: 'none', categories: [] };
}

/**
 * Parse `process.env.CALAME_RAG_PII_MASK` into a typed config.
 *
 * Accepted syntax (case-insensitive):
 *   - undefined / `''`     → defaults: enabled, mode=replace, default categories.
 *   - `'on'`               → defaults.
 *   - `'off'`              → disabled (mask nothing, audit counts empty).
 *   - `'<mode>'`           → mode override, default categories.
 *                            (`<mode>` ∈ replace | hash | truncate | none)
 *   - `'<mode>:<cats>'`    → mode + category subset.
 *                            `<cats>` is comma-separated. The token `all`
 *                            expands to all default categories.
 *
 * Any unrecognised input falls back to the safe DEFAULT (enabled, replace,
 * defaults). The fallback is deliberate: a typo in production must NOT
 * silently disable PII masking.
 */
export function parseRagPiiConfig(envValue: string | undefined): RagPiiMaskingConfig {
  if (envValue === undefined) return defaultConfig();
  const raw = envValue.trim();
  if (raw === '' || raw.toLowerCase() === 'on') return defaultConfig();
  if (raw.toLowerCase() === 'off') return disabledConfig();

  const [modePart, catsPart] = raw.split(':', 2);
  const mode = modePart.trim().toLowerCase() as TextMaskingMode;
  if (!ALLOWED_MODES.has(mode)) {
    // Unknown mode → safe default. We still respect the operator's INTENT
    // to configure something (vs. leaving it undefined) by logging would
    // be ideal; the caller can warn after seeing `.enabled` differs from
    // what they wrote.
    return defaultConfig();
  }

  let categories: PiiCategory[];
  if (catsPart === undefined || catsPart.trim() === '' || catsPart.trim().toLowerCase() === 'all') {
    categories = [...DEFAULT_TEXT_PII_CATEGORIES];
  } else {
    const parsed = catsPart
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
      .filter((s): s is PiiCategory => ALLOWED_CATEGORIES.has(s as PiiCategory));
    if (parsed.length === 0) {
      // All tokens invalid → fall back to defaults (safe).
      categories = [...DEFAULT_TEXT_PII_CATEGORIES];
    } else {
      categories = parsed;
    }
  }

  return {
    enabled: mode !== 'none',
    mode,
    categories,
  };
}

// ---------------------------------------------------------------------------
// Apply masking
// ---------------------------------------------------------------------------

/**
 * Apply PII masking to every chunk in a {@link RagSearchResult}.
 *
 * Returns a NEW result (no mutation of the input) plus the aggregated
 * redaction counts across all chunks. The counts are safe to log — they
 * never contain the redacted values themselves.
 *
 * When `config.enabled` is false, the function is a structural no-op:
 * it returns the input `result` unchanged and an empty count map. It does
 * NOT scan in this case (saves CPU on hot search paths when an operator
 * deliberately disabled the feature).
 */
export function maskSearchResult(
  result: RagSearchResult,
  config: RagPiiMaskingConfig,
): {
  result: RagSearchResult;
  redactionCounts: Partial<Record<PiiCategory, number>>;
} {
  if (!config.enabled || result.chunks.length === 0) {
    return { result, redactionCounts: {} };
  }

  const aggregate: Partial<Record<PiiCategory, number>> = {};
  const maskedChunks = result.chunks.map((chunk) => {
    const { text, redactionCounts } = applyPiiMasking(chunk.text, config.mode, config.categories);
    for (const [cat, count] of Object.entries(redactionCounts)) {
      if (count === undefined) continue;
      const key = cat as PiiCategory;
      aggregate[key] = (aggregate[key] ?? 0) + count;
    }
    return { ...chunk, text };
  });

  return { result: { ...result, chunks: maskedChunks }, redactionCounts: aggregate };
}
