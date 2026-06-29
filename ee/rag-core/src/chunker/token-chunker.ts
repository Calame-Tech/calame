// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Backwards-compatibility shim.
 *
 * Older callers import `chunkText` / `TokenChunk` / `TokenChunkOptions` from
 * this module. The actual implementation now lives in `plain-chunker.ts`
 * (renamed to make room for the structure-aware variants). Re-export the
 * legacy names so external consumers and tests keep working.
 */

import { chunkPlainText } from './plain-chunker.js';
import type { Chunk, ChunkOptions } from './types.js';

export type TokenChunk = Chunk;
export type TokenChunkOptions = ChunkOptions;

/** @deprecated Use `chunkPlainText` (or `pickChunker(format)`) instead. */
export function chunkText(text: string, opts: TokenChunkOptions = {}): TokenChunk[] {
  return chunkPlainText(text, opts);
}
