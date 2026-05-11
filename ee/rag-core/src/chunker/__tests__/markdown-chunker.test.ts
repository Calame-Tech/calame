// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../markdown-chunker.js';
import { countTokens } from '../tokenizer.js';

describe('chunkMarkdown (structure-aware markdown chunker)', () => {
	it('returns one chunk per leaf section when sections fit under maxTokens', () => {
		const doc = [
			'# Guide',
			'',
			'Introduction paragraph.',
			'',
			'## Installation',
			'',
			'Run `pnpm install` to install dependencies.',
			'',
			'## Configuration',
			'',
			'Edit `config.json` to suit your needs.',
		].join('\n');

		const chunks = chunkMarkdown(doc, { maxTokens: 512, minTokens: 0 });

		expect(chunks.length).toBeGreaterThanOrEqual(3);
		// Each section's preamble should be present in its chunk.
		expect(chunks.some((c) => c.text.includes('# Guide') && c.text.includes('Introduction'))).toBe(
			true,
		);
		expect(
			chunks.some((c) => c.text.includes('## Installation') && c.text.includes('pnpm install')),
		).toBe(true);
		expect(
			chunks.some((c) => c.text.includes('## Configuration') && c.text.includes('config.json')),
		).toBe(true);
	});

	it('splits an oversized section into sub-chunks that all keep the hierarchy preamble', () => {
		const longBody = ('Lorem ipsum dolor sit amet. '.repeat(50) + '\n\n').repeat(8);
		const doc = `# Big Guide\n\n## Long Section\n\n${longBody}`;

		const chunks = chunkMarkdown(doc, { maxTokens: 200, minTokens: 0 });

		expect(chunks.length).toBeGreaterThan(1);
		// Every chunk from this section should start with the heading breadcrumb.
		for (const chunk of chunks) {
			expect(chunk.text).toContain('# Big Guide > ## Long Section');
			expect(chunk.tokenCount).toBeLessThanOrEqual(200);
		}
		// Positions are monotonically increasing.
		for (let i = 0; i < chunks.length; i++) {
			expect(chunks[i]!.position).toBe(i);
		}
	});

	it('merges two consecutive small sections sharing the same parent', () => {
		const doc = [
			'# Topic',
			'',
			'## Notes',
			'',
			'Tiny.',
			'',
			'## Notes', // same heading on purpose: same preamble → mergeable
			'',
			'Also tiny.',
		].join('\n');

		const merged = chunkMarkdown(doc, { maxTokens: 512, minTokens: 100 });
		// With aggressive min-threshold, the two tiny sections must collapse.
		const notesChunks = merged.filter((c) => c.text.includes('## Notes'));
		expect(notesChunks).toHaveLength(1);
		expect(notesChunks[0]!.text).toContain('Tiny.');
		expect(notesChunks[0]!.text).toContain('Also tiny.');
	});

	it('prefixes every chunk with the full "## H > ### Sub" breadcrumb', () => {
		const doc = [
			'## Installation',
			'',
			'### Linux',
			'',
			'Use the package manager.',
			'',
			'### Windows',
			'',
			'Use the installer.',
		].join('\n');

		const chunks = chunkMarkdown(doc, { maxTokens: 512, minTokens: 0 });

		const linux = chunks.find((c) => c.text.includes('Linux'));
		const windows = chunks.find((c) => c.text.includes('Windows'));
		expect(linux).toBeDefined();
		expect(windows).toBeDefined();
		expect(linux!.text.startsWith('## Installation > ### Linux')).toBe(true);
		expect(windows!.text.startsWith('## Installation > ### Windows')).toBe(true);
	});

	it('falls back to paragraph + token splitting when the document has no headings', () => {
		const doc = `${'word '.repeat(400)}\n\n${'word '.repeat(400)}\n\n${'word '.repeat(400)}`;

		const chunks = chunkMarkdown(doc, { maxTokens: 200, minTokens: 0 });

		expect(chunks.length).toBeGreaterThan(1);
		// None of the chunks should carry a heading preamble (no `#` and no ` > ` arrow on the first line).
		for (const chunk of chunks) {
			const firstLine = chunk.text.split('\n')[0]!;
			expect(firstLine.startsWith('#')).toBe(false);
			expect(firstLine.includes(' > ')).toBe(false);
			expect(chunk.tokenCount).toBeLessThanOrEqual(200);
		}
	});

	it('keeps a fenced code block atomic when it fits in maxTokens', () => {
		const code = '```js\n' + 'console.log("hi");\n'.repeat(5) + '```';
		const doc = `# Doc\n\n## Example\n\nSee the code below:\n\n${code}\n\nThat was it.`;

		const chunks = chunkMarkdown(doc, { maxTokens: 512, minTokens: 0 });

		// The full code block survives as a single substring in at least one chunk.
		const found = chunks.find((c) => c.text.includes('```js') && c.text.includes('```'));
		expect(found).toBeDefined();
		// Ensure the opening fence and closing fence are on different lines and
		// no chunk contains just the opener without its closer (would mean it
		// was split mid-fence).
		for (const chunk of chunks) {
			const opens = (chunk.text.match(/```js/g) ?? []).length;
			const closes = (chunk.text.match(/```\s*$/gm) ?? []).length;
			// If the chunk contains the opener, it must also contain *a* closer.
			if (opens > 0) expect(closes).toBeGreaterThanOrEqual(opens);
		}
	});

	it('ignores YAML front-matter and starts indexing at the first real section', () => {
		const doc = [
			'---',
			'title: Hello',
			'tags: [a, b]',
			'---',
			'',
			'# Real Title',
			'',
			'Body content here.',
		].join('\n');

		const chunks = chunkMarkdown(doc, { maxTokens: 512, minTokens: 0 });

		expect(chunks.length).toBeGreaterThanOrEqual(1);
		const all = chunks.map((c) => c.text).join('\n');
		expect(all).not.toContain('title: Hello');
		expect(all).not.toContain('tags: [a, b]');
		expect(chunks[0]!.text).toContain('# Real Title');
		expect(chunks[0]!.text).toContain('Body content here.');
	});

	it('reports tokenCount that matches countTokens(chunk.text) exactly', () => {
		const doc = '# Section\n\nThe content of section one.\n\n## Sub\n\nMore content here.';
		const chunks = chunkMarkdown(doc, { maxTokens: 512, minTokens: 0 });
		for (const chunk of chunks) {
			expect(chunk.tokenCount).toBe(countTokens(chunk.text));
		}
	});

	it('returns an empty array on an empty document', () => {
		expect(chunkMarkdown('')).toEqual([]);
		expect(chunkMarkdown('   ')).toEqual([]);
		expect(chunkMarkdown('\n\n')).toEqual([]);
	});

	it('skips a heading whose body is empty', () => {
		const doc = '# Title Only\n\n## Empty Section\n\n## Real Section\n\nReal content here.';
		const chunks = chunkMarkdown(doc, { maxTokens: 512, minTokens: 0 });
		// No chunk should be just the preamble (heading with no body).
		for (const chunk of chunks) {
			const lines = chunk.text.split('\n').filter((l) => l.trim().length > 0);
			expect(lines.length).toBeGreaterThanOrEqual(2);
		}
		const all = chunks.map((c) => c.text).join('\n');
		expect(all).toContain('Real content here.');
	});

	it('preserves chunk-level token budget even when packing multiple small paragraphs', () => {
		const doc = [
			'# Doc',
			'',
			...Array.from({ length: 20 }, (_, i) => `Para ${i} ${'tokens '.repeat(20)}`).flatMap((p) => [
				p,
				'',
			]),
		].join('\n');

		const chunks = chunkMarkdown(doc, { maxTokens: 150, minTokens: 0 });
		for (const chunk of chunks) {
			expect(chunk.tokenCount).toBeLessThanOrEqual(150);
		}
	});
});
