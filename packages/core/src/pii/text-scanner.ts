// Free-text PII scanner and masking helpers.
//
// Companion to the column-based detector in `./detector.ts`. The column
// detector matches whole-value samples (anchored regexes) against a category;
// this scanner finds PII spans inside arbitrary free text (RAG chunks, log
// lines, ...). Both modules share the same `PiiCategory` taxonomy.
//
// Categories scanned by default: email, phone, credit_card, ip_address, ssn.
// `name` and `address` are intentionally excluded — heuristics on free text
// produce too many false positives (every capitalised word becomes a "name").
// A pluggable NER backend is a natural extension once the runtime cost is
// acceptable.

import { createHash } from 'crypto';
import type { PiiCategory } from './types.js';

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Free-text equivalents of `DATA_PATTERNS` from `./detector.ts`. The detector
 * uses `^...$` anchors (whole-value match for column samples); this scanner
 * uses word-boundary anchors so matches can sit anywhere in a larger string.
 *
 * Patterns are declared with the `g` flag so a single `matchAll` pass returns
 * every occurrence.
 */
const TEXT_PATTERNS: { pattern: RegExp; category: PiiCategory }[] = [
  // Email — RFC-loose but covers >99% of practical addresses.
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    category: 'email',
  },

  // SSN (US format) — kept BEFORE phone so the more specific shape wins
  // when the same digit sequence could match both.
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, category: 'ssn' },

  // Credit card — 13 to 19 digits, optionally separated by spaces or dashes.
  // No Luhn check (deliberate: keeps the regex hot-path simple; the
  // occasional false-positive 16-digit order-number is masked but the
  // audit count makes the operator aware). See JSDoc on `scanTextForPii`
  // for the rationale.
  { pattern: /\b(?:\d[ -]?){12,18}\d\b/g, category: 'credit_card' },

  // IPv4 only — IPv6 left out (rarely user-facing PII, would need a much
  // looser regex and a constraint check). Declared BEFORE phone because
  // the phone character class includes `.`, so an IP and a "phone" of the
  // same length would otherwise tie and phone's declOrder would win. We
  // want IP to win the tie since it is the more specific shape.
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, category: 'ip_address' },

  // Phone — international or local, 7+ digits with common separators.
  // Falls AFTER ssn, credit_card and ip_address so the more-specific spans
  // claim those digit sequences first via overlap resolution.
  { pattern: /(?:\+?\d[\d\s\-().]{6,18}\d)/g, category: 'phone' },
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PiiSpan {
  /** Start index in the source text (inclusive). */
  start: number;
  /** End index in the source text (exclusive). */
  end: number;
  category: PiiCategory;
  /** The matched substring — needed for hashed / truncated placeholders. */
  match: string;
}

export type TextMaskingMode = 'replace' | 'hash' | 'truncate' | 'none';

/**
 * Categories scanned by default. Excludes `name` and `address` (too noisy on
 * free text) and `password`/`encrypted` (column-only concepts).
 */
export const DEFAULT_TEXT_PII_CATEGORIES: readonly PiiCategory[] = [
  'email',
  'phone',
  'credit_card',
  'ip_address',
  'ssn',
];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan free text for PII patterns. Returns spans sorted by `start` ascending.
 *
 * Overlap policy: when two raw matches overlap, the LONGER one wins. Ties are
 * broken by category declaration order in {@link TEXT_PATTERNS} (so the more
 * specific category — e.g. ssn — wins over the more generic — phone — when
 * they have identical spans).
 *
 * Implementation note: we collect ALL candidate matches first, then sort by
 * (length desc, start asc) and accept greedily. This keeps the overlap rule
 * unambiguous regardless of pattern declaration order while still respecting
 * the tie-breaker via stable sort with `start` as secondary key.
 *
 * @param text       The text to scan. Empty / undefined returns [].
 * @param categories Subset of categories to scan. Defaults to
 *                   {@link DEFAULT_TEXT_PII_CATEGORIES}.
 */
export function scanTextForPii(text: string, categories?: readonly PiiCategory[]): PiiSpan[] {
  if (!text) return [];
  const active = new Set(categories ?? DEFAULT_TEXT_PII_CATEGORIES);

  type Candidate = PiiSpan & { length: number; declOrder: number };
  const candidates: Candidate[] = [];

  for (let i = 0; i < TEXT_PATTERNS.length; i++) {
    const { pattern, category } = TEXT_PATTERNS[i];
    if (!active.has(category)) continue;
    // Reset lastIndex defensively — TEXT_PATTERNS lives at module scope
    // and is shared across calls. A previous partially-consumed iterator
    // would otherwise skip matches.
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      if (m.index === undefined) continue;
      const match = m[0];
      candidates.push({
        start: m.index,
        end: m.index + match.length,
        category,
        match,
        length: match.length,
        declOrder: i,
      });
    }
  }

  // Sort: longer first, then earlier start, then earlier declaration order.
  candidates.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    if (a.start !== b.start) return a.start - b.start;
    return a.declOrder - b.declOrder;
  });

  // Greedy accept: keep a span iff it doesn't overlap one already accepted.
  const accepted: PiiSpan[] = [];
  for (const c of candidates) {
    const overlaps = accepted.some((a) => !(c.end <= a.start || c.start >= a.end));
    if (!overlaps) {
      accepted.push({
        start: c.start,
        end: c.end,
        category: c.category,
        match: c.match,
      });
    }
  }

  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

const REPLACE_LABEL: Record<PiiCategory, string> = {
  email: '[EMAIL]',
  phone: '[PHONE]',
  name: '[NAME]',
  address: '[ADDRESS]',
  credit_card: '[CREDIT_CARD]',
  password: '[PASSWORD]',
  ip_address: '[IP_ADDRESS]',
  ssn: '[SSN]',
  encrypted: '[ENCRYPTED]',
};

/** Short, stable hash prefix used as a deterministic id in 'hash' mode. */
function hashPrefix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Truncated placeholder. Keeps the first 2 and last 2 chars of the matched
 * value so the LLM has some grounding (e.g. "credit card ending in 9010")
 * without being able to reconstruct the original. Values shorter than 5 chars
 * are masked with the full replace label to avoid leaking the entire value.
 */
function truncatePlaceholder(category: PiiCategory, value: string): string {
  if (value.length < 5) return REPLACE_LABEL[category];
  const keep = 2;
  const head = value.slice(0, keep);
  const tail = value.slice(-keep);
  const tag = category.toUpperCase();
  return `[${tag}:${head}***${tail}]`;
}

/**
 * Apply masking to all PII spans found in `text`.
 *
 * @returns `{ text, redactionCounts }` where `redactionCounts` is keyed by
 *          category and reports how many spans were redacted. The counts are
 *          safe to log — they never contain the redacted values themselves.
 *
 * Modes:
 *  - `'replace'` (default for callers): `"[EMAIL]"` / `"[PHONE]"` / ...
 *  - `'hash'`:    `"[email:abc12345]"` — same input → same hash, useful when
 *                 the LLM benefits from knowing two chunks reference the
 *                 same individual.
 *  - `'truncate'`: `"[EMAIL:jo***om]"` — preserves head/tail. Most useful for
 *                 credit cards where the last 4 digits carry information.
 *  - `'none'`:    no-op, text returned unchanged. The function still scans
 *                 for the requested categories so the audit count is
 *                 reported faithfully. This is intentional: an operator
 *                 running with `'none'` may want to KNOW that PII was
 *                 present even though they chose not to redact it.
 */
export function applyPiiMasking(
  text: string,
  mode: TextMaskingMode = 'replace',
  categories?: readonly PiiCategory[],
): { text: string; redactionCounts: Partial<Record<PiiCategory, number>> } {
  const spans = scanTextForPii(text, categories);
  const redactionCounts: Partial<Record<PiiCategory, number>> = {};
  for (const span of spans) {
    redactionCounts[span.category] = (redactionCounts[span.category] ?? 0) + 1;
  }

  if (mode === 'none' || spans.length === 0) {
    return { text, redactionCounts };
  }

  // Rebuild text in one pass, walking spans in order.
  let result = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      result += text.slice(cursor, span.start);
    }
    result += renderPlaceholder(span, mode);
    cursor = span.end;
  }
  if (cursor < text.length) {
    result += text.slice(cursor);
  }
  return { text: result, redactionCounts };
}

function renderPlaceholder(span: PiiSpan, mode: TextMaskingMode): string {
  switch (mode) {
    case 'replace':
      return REPLACE_LABEL[span.category];
    case 'hash':
      return `[${span.category}:${hashPrefix(span.match)}]`;
    case 'truncate':
      return truncatePlaceholder(span.category, span.match);
    case 'none':
      // Unreachable (handled above) but kept for exhaustiveness.
      return span.match;
  }
}
