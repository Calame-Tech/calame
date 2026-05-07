// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import Papa from 'papaparse';
import type { ParsedDocument } from './types.js';

/**
 * Parse a CSV buffer into plain text suitable for chunking. Each row is
 * rendered as `Header: value, Header: value, ...` on its own line so that
 * embedding models receive enough context to associate values with column
 * names.
 */
export async function parse(buffer: Buffer): Promise<ParsedDocument> {
	const csvText = buffer.toString('utf8');
	const result = Papa.parse<Record<string, string>>(csvText, {
		header: true,
		skipEmptyLines: true,
	});

	const rows = result.data;
	const columns: string[] = Array.isArray(result.meta.fields) ? result.meta.fields : [];

	const lines: string[] = [];
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
		metadata: {
			rowCount: rows.length,
			columns,
		},
	};
}
