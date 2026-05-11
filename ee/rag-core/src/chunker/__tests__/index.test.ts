// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import { pickChunker, chunkPlainText, chunkMarkdown, chunkCsv } from '../index.js';

describe('pickChunker(format)', () => {
	it('returns the markdown chunker for format="markdown"', () => {
		expect(pickChunker('markdown')).toBe(chunkMarkdown);
	});

	it('returns the CSV chunker for format="csv"', () => {
		expect(pickChunker('csv')).toBe(chunkCsv);
	});

	it('returns the plain chunker for format="plain"', () => {
		expect(pickChunker('plain')).toBe(chunkPlainText);
	});

	it('falls back to the plain chunker for unknown formats', () => {
		expect(pickChunker('unknown' as unknown as 'plain')).toBe(chunkPlainText);
		expect(pickChunker(undefined)).toBe(chunkPlainText);
		expect(pickChunker('')).toBe(chunkPlainText);
	});

	it('produces a shape-compatible Chunk[] regardless of which chunker is picked', () => {
		const markdownChunker = pickChunker('markdown');
		const csvChunker = pickChunker('csv');
		const plainChunker = pickChunker('plain');

		const mdChunks = markdownChunker('# Hi\n\nBody.', { maxTokens: 512 });
		const csvChunks = csvChunker('a, b\na: 1, b: 2', { maxTokens: 512 });
		const plainChunks = plainChunker('Hello world.', { maxTokens: 512 });

		for (const set of [mdChunks, csvChunks, plainChunks]) {
			for (const chunk of set) {
				expect(chunk).toHaveProperty('position');
				expect(chunk).toHaveProperty('text');
				expect(chunk).toHaveProperty('tokenCount');
				expect(typeof chunk.position).toBe('number');
				expect(typeof chunk.text).toBe('string');
				expect(typeof chunk.tokenCount).toBe('number');
			}
		}
	});
});
