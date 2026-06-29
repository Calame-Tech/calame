// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { decodeTokens, encodeTokens } from './tokenizer.js';
import { DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP, type Chunk, type ChunkOptions } from './types.js';

/**
 * Token-based sliding-window chunker using the o200k_base encoding (the
 * tokenizer used by OpenAI text-embedding-3-* models).
 *
 * This is the fallback strategy used when the document has no exploitable
 * structure (plain text, raw PDF). The behaviour matches the historic
 * `chunkText` implementation and is preserved on purpose so plain-text
 * documents continue to chunk identically across versions.
 *
 * Algorithm:
 *  1. Encode the entire input text to tokens.
 *  2. Walk through tokens with a window of `maxTokens`, advancing by
 *     `maxTokens - overlap` each step (so each window overlaps the previous
 *     by `overlap` tokens).
 *  3. Decode each window back to text and emit a chunk.
 *
 * Edge cases:
 *  - Empty / whitespace-only text → empty array.
 *  - Text shorter than `maxTokens` → a single chunk.
 *
 * @throws if `overlap >= maxTokens` (would loop forever).
 */
export function chunkPlainText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`chunkPlainText: maxTokens must be a positive integer, got ${maxTokens}`);
  }
  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new Error(`chunkPlainText: overlap must be a non-negative integer, got ${overlap}`);
  }
  if (overlap >= maxTokens) {
    throw new Error(
      `chunkPlainText: overlap (${overlap}) must be strictly less than maxTokens (${maxTokens})`,
    );
  }

  if (!text || text.trim().length === 0) {
    return [];
  }

  const tokens = encodeTokens(text);
  if (tokens.length === 0) {
    return [];
  }

  const step = maxTokens - overlap;
  const chunks: Chunk[] = [];
  let position = 0;

  for (let start = 0; start < tokens.length; start += step) {
    const end = Math.min(start + maxTokens, tokens.length);
    const slice = tokens.slice(start, end);
    chunks.push({
      position,
      text: decodeTokens(slice),
      tokenCount: slice.length,
    });
    position += 1;
    if (end === tokens.length) break;
  }

  return chunks;
}
