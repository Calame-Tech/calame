// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { countTokens } from './tokenizer.js';
import { DEFAULT_MAX_TOKENS, type Chunk, type ChunkOptions } from './types.js';

/**
 * Structure-aware chunker for CSV-formatted input.
 *
 * The CSV parser (see `parsers/csv.ts`) emits text whose first line is the
 * header (column names joined with `, ` or rendered as `col1, col2, …`) and
 * each subsequent line is a row in `Header: value, …` form. This chunker
 * relies on that contract:
 *
 *   1. The first non-empty line is the header — kept verbatim and prepended
 *      to every emitted chunk so each chunk is self-describing.
 *   2. Subsequent lines are packed into chunks until adding the next row
 *      would push the chunk over `maxTokens`. Rows are atomic: they are
 *      never split across chunks.
 *   3. No overlap between chunks — rows are independent records.
 *
 * Edge cases:
 *   - Empty text / header only → 0 chunks.
 *   - A single row that on its own (with the header) exceeds `maxTokens` is
 *     still emitted as one chunk; we prefer slightly oversized chunks to
 *     splitting a record across boundaries.
 */
export function chunkCsv(text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`chunkCsv: maxTokens must be a positive integer, got ${maxTokens}`);
  }

  if (!text || text.trim().length === 0) return [];

  const lines = text.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const header = lines[headerIdx]!;
  const rows: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    rows.push(line);
  }

  if (rows.length === 0) return [];

  const headerTokens = countTokens(header);
  const chunks: Chunk[] = [];
  let position = 0;
  let acc: string[] = [];
  let accTokens = headerTokens;
  // Each appended row costs `+1` token for the joining newline. We over-
  // estimate slightly (newline can encode as a different token width
  // depending on context) to stay safely below the limit.
  const NEWLINE_COST = 1;

  const flush = (): void => {
    if (acc.length === 0) return;
    const text = `${header}\n${acc.join('\n')}`;
    chunks.push({
      position,
      text,
      tokenCount: countTokens(text),
    });
    position += 1;
    acc = [];
    accTokens = headerTokens;
  };

  for (const row of rows) {
    const rowTokens = countTokens(row);

    // If a single row + header alone exceeds the cap, emit it as its own
    // chunk (oversized but never split mid-record).
    if (acc.length === 0 && headerTokens + NEWLINE_COST + rowTokens > maxTokens) {
      acc.push(row);
      flush();
      continue;
    }

    if (accTokens + NEWLINE_COST + rowTokens > maxTokens) {
      flush();
    }
    acc.push(row);
    accTokens += NEWLINE_COST + rowTokens;
  }

  flush();
  return chunks;
}
