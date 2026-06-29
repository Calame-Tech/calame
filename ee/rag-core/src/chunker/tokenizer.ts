// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { encode, decode } from 'gpt-tokenizer/encoding/o200k_base';

/**
 * Centralized access to the `o200k_base` tokenizer — the same encoding used
 * by OpenAI `text-embedding-3-*` models. Every chunker counts tokens through
 * these helpers so estimates stay consistent across strategies.
 */

/** Encode text to token IDs. Empty input → empty array. */
export function encodeTokens(text: string): number[] {
  if (!text) return [];
  return encode(text);
}

/** Decode a token slice back to text. */
export function decodeTokens(tokens: number[]): string {
  if (tokens.length === 0) return '';
  return decode(tokens);
}

/**
 * Count tokens in `text` without materializing the slice. Used by every
 * chunker for the same reason: a structure-aware split still needs a hard
 * cap to keep us under the embedding model's context window.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}
