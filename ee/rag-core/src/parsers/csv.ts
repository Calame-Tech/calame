// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import Papa from 'papaparse';
import type { ParsedDocument } from './types.js';

/**
 * Parse a CSV buffer into a chunker-friendly text representation.
 *
 * The output contract is:
 *   - line 1 = a single header line listing the column names (comma-joined).
 *   - lines 2..N = one record per line, formatted as `col: value, col: value, …`.
 *
 * The CSV chunker reads this structure verbatim: it repeats line 1 in every
 * emitted chunk and packs as many subsequent lines as fit under `maxTokens`.
 *
 * Empty values are skipped per row to keep the embedding signal dense.
 */
export async function parse(buffer: Buffer): Promise<ParsedDocument> {
  const csvText = buffer.toString('utf8');
  const result = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const rows = result.data;
  const columns: string[] = Array.isArray(result.meta.fields) ? result.meta.fields : [];

  const headerLine = columns.join(', ');
  const lines: string[] = headerLine.length > 0 ? [headerLine] : [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const parts: string[] = [];
    for (const col of columns) {
      const value = row[col];
      if (value === undefined || value === null || value === '') continue;
      parts.push(`${col}: ${String(value)}`);
    }
    if (parts.length > 0) lines.push(parts.join(', '));
  }

  return {
    text: lines.join('\n'),
    format: 'csv',
    metadata: {
      rowCount: rows.length,
      columns,
    },
  };
}
