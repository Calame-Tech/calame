// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import { chunkCsv } from '../csv-chunker.js';
import { countTokens } from '../tokenizer.js';

/** Build a CSV-formatted text in the shape produced by `parsers/csv.ts`. */
function buildCsvText(columns: string[], rows: Record<string, string>[]): string {
	const header = columns.join(', ');
	const lines = rows.map((row) =>
		columns
			.filter((col) => row[col] !== undefined && row[col] !== '')
			.map((col) => `${col}: ${row[col]}`)
			.join(', '),
	);
	return [header, ...lines].join('\n');
}

describe('chunkCsv (structure-aware CSV chunker)', () => {
	it('splits a large CSV into multiple chunks, all carrying the header line', () => {
		const cols = ['id', 'name', 'email'];
		const rows = Array.from({ length: 100 }, (_, i) => ({
			id: String(i),
			name: `User ${i}`,
			email: `user${i}@example.com`,
		}));
		const text = buildCsvText(cols, rows);

		const chunks = chunkCsv(text, { maxTokens: 200 });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.text.startsWith('id, name, email\n')).toBe(true);
			expect(chunk.tokenCount).toBeLessThanOrEqual(220);
			// Position is monotonically increasing.
			expect(chunk.position).toBeGreaterThanOrEqual(0);
		}
	});

	it('emits a single chunk for a CSV with only one row', () => {
		const text = buildCsvText(
			['city', 'country'],
			[{ city: 'Montréal', country: 'Canada' }],
		);

		const chunks = chunkCsv(text, { maxTokens: 200 });

		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.text).toContain('city, country');
		expect(chunks[0]!.text).toContain('Montréal');
		expect(chunks[0]!.text).toContain('Canada');
	});

	it('repeats the header line as the first line of every emitted chunk', () => {
		const cols = ['a', 'b'];
		const rows = Array.from({ length: 50 }, (_, i) => ({
			a: `aaaa-${i}`,
			b: `bbbb-${i}`,
		}));
		const text = buildCsvText(cols, rows);

		const chunks = chunkCsv(text, { maxTokens: 100 });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			const firstLine = chunk.text.split('\n')[0]!;
			expect(firstLine).toBe('a, b');
		}
	});

	it('does not emit overlapping rows between consecutive chunks', () => {
		const cols = ['k'];
		const rows = Array.from({ length: 80 }, (_, i) => ({ k: `value-${i}` }));
		const text = buildCsvText(cols, rows);

		const chunks = chunkCsv(text, { maxTokens: 60 });

		// Collect every `value-N` substring across all chunks. Each value must
		// appear exactly once.
		const seen = new Set<string>();
		for (const chunk of chunks) {
			const matches = chunk.text.match(/value-\d+/g) ?? [];
			for (const m of matches) {
				expect(seen.has(m)).toBe(false);
				seen.add(m);
			}
		}
		expect(seen.size).toBe(80);
	});

	it('emits more chunks when maxTokens is lowered', () => {
		const cols = ['x', 'y', 'z'];
		const rows = Array.from({ length: 60 }, (_, i) => ({
			x: `xxx-${i}`,
			y: `yyy-${i}`,
			z: `zzz-${i}`,
		}));
		const text = buildCsvText(cols, rows);

		const wide = chunkCsv(text, { maxTokens: 500 });
		const narrow = chunkCsv(text, { maxTokens: 100 });

		expect(narrow.length).toBeGreaterThan(wide.length);
	});

	it('returns 0 chunks for an empty CSV or a header-only CSV', () => {
		expect(chunkCsv('')).toEqual([]);
		expect(chunkCsv('   ')).toEqual([]);
		expect(chunkCsv('id, name')).toEqual([]); // header only, no rows
		expect(chunkCsv('id, name\n')).toEqual([]);
	});

	it('reports tokenCount that matches countTokens(chunk.text)', () => {
		const text = buildCsvText(
			['id', 'value'],
			Array.from({ length: 10 }, (_, i) => ({ id: String(i), value: `value-${i}` })),
		);
		const chunks = chunkCsv(text, { maxTokens: 200 });
		for (const chunk of chunks) {
			expect(chunk.tokenCount).toBe(countTokens(chunk.text));
		}
	});
});
