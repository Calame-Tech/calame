// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, vi } from 'vitest';
import { RerankingSearchIndex, type RerankAuditEntry } from '../reranking-search-index.js';
import type { DocumentSearchIndex } from '../../source-adapter.js';
import type { Reranker, RerankerResult } from '../reranker.js';
import type { RagSearchResult } from '../../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a canned `RagSearchResult` from a list of (text, score) tuples. */
function buildBaseHits(texts: Array<{ text: string; score: number }>): RagSearchResult {
	return {
		chunks: texts.map((t, i) => ({
			text: t.text,
			score: t.score,
			sourceId: 'src-1',
			folder: 'docs',
			fileName: `f${i}.md`,
			position: i,
			documentId: `doc-${i}`,
		})),
	};
}

function makeMockBase(result: RagSearchResult): DocumentSearchIndex & { search: ReturnType<typeof vi.fn> } {
	return {
		search: vi.fn(async () => result),
	};
}

function makeMockReranker(orderedIndices: number[], score = 0.9): Reranker {
	return {
		model: 'rerank-multilingual-v3.0',
		rerank: vi.fn(async (input): Promise<RerankerResult> => {
			return {
				results: orderedIndices.map((idx, rank) => ({
					id: input.documents[idx]?.id ?? `${idx}`,
					// Strictly decreasing so the wrapper's order matches `orderedIndices`.
					score: score - rank * 0.01,
				})),
			};
		}),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RerankingSearchIndex', () => {
	it('reorders base hits according to the reranker verdict and overrides scores', async () => {
		const base = makeMockBase(
			buildBaseHits([
				{ text: 'first', score: 0.5 },
				{ text: 'second', score: 0.4 },
				{ text: 'third', score: 0.3 },
				{ text: 'fourth', score: 0.2 },
				{ text: 'fifth', score: 0.1 },
			]),
		);
		// Reranker prefers 2, then 0, then 1 (top-3 with topK=3).
		const reranker = makeMockReranker([2, 0, 1], 0.95);

		const index = new RerankingSearchIndex({ base, reranker });
		const result = await index.search('src-1', 'query', { topK: 3 });

		expect(result.chunks).toHaveLength(3);
		expect(result.chunks.map((c) => c.text)).toEqual(['third', 'first', 'second']);
		// Scores are now the reranker's, not the base's RRF.
		expect(result.chunks[0]!.score).toBeCloseTo(0.95, 5);
		expect(result.chunks[1]!.score).toBeCloseTo(0.94, 5);
		expect(result.chunks[2]!.score).toBeCloseTo(0.93, 5);
		// Rich metadata is preserved.
		expect(result.chunks[0]!.documentId).toBe('doc-2');
		expect(result.chunks[1]!.documentId).toBe('doc-0');
	});

	it('falls back to base results when reranker throws, emitting rag.rerank.failed', async () => {
		const base = makeMockBase(
			buildBaseHits([
				{ text: 'first', score: 0.9 },
				{ text: 'second', score: 0.6 },
				{ text: 'third', score: 0.3 },
			]),
		);
		const reranker: Reranker = {
			model: 'rerank-multilingual-v3.0',
			rerank: vi.fn(async () => {
				throw new Error('boom');
			}),
		};
		const audits: RerankAuditEntry[] = [];

		const index = new RerankingSearchIndex({
			base,
			reranker,
			onAudit: (e) => audits.push(e),
		});

		const result = await index.search('src-1', 'q', { topK: 2 });
		// Order preserved from the base index (we don't re-rank on failure).
		expect(result.chunks.map((c) => c.text)).toEqual(['first', 'second']);
		// Scores untouched (base RRF, not overridden).
		expect(result.chunks[0]!.score).toBeCloseTo(0.9, 5);
		// Audit emitted with the failure metadata.
		expect(audits).toHaveLength(1);
		expect(audits[0]!.type).toBe('rag.rerank.failed');
		expect(audits[0]!.payload).toMatchObject({
			sourceId: 'src-1',
			model: 'rerank-multilingual-v3.0',
			error: 'boom',
			candidates: 3,
		});
	});

	it('calls base.search with candidatesPerSearch and reranker with topK=topN', async () => {
		const base = makeMockBase(
			buildBaseHits(
				Array.from({ length: 50 }, (_, i) => ({ text: `chunk ${i}`, score: 1 - i * 0.01 })),
			),
		);
		const reranker = makeMockReranker([0, 1, 2, 3, 4]);

		const index = new RerankingSearchIndex({
			base,
			reranker,
			candidatesPerSearch: 50,
		});

		await index.search('src-1', 'q', { topK: 10 });

		// base.search received topK=50 (the candidate budget).
		expect(base.search).toHaveBeenCalledTimes(1);
		const baseCallArgs = base.search.mock.calls[0]!;
		expect(baseCallArgs[2]).toMatchObject({ topK: 50 });

		// reranker.rerank received topN=10 (the caller's topK).
		const rerankerSpy = reranker.rerank as ReturnType<typeof vi.fn>;
		expect(rerankerSpy).toHaveBeenCalledTimes(1);
		expect(rerankerSpy.mock.calls[0]![0]).toMatchObject({ topN: 10 });
	});

	it('returns [] without calling the reranker when base returns no hits', async () => {
		const base = makeMockBase({ chunks: [] });
		const reranker = makeMockReranker([]);

		const index = new RerankingSearchIndex({ base, reranker });
		const result = await index.search('src-1', 'q', { topK: 5 });

		expect(result.chunks).toEqual([]);
		expect((reranker.rerank as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
	});

	it('returns at most topK chunks when the reranker emits more results than asked', async () => {
		// Defensive cap. Cohere may return more than top_n if we ask for fewer
		// than the server's minimum; the wrapper must clamp.
		const base = makeMockBase(
			buildBaseHits([
				{ text: 'a', score: 0.5 },
				{ text: 'b', score: 0.4 },
				{ text: 'c', score: 0.3 },
				{ text: 'd', score: 0.2 },
				{ text: 'e', score: 0.1 },
			]),
		);
		const reranker = makeMockReranker([4, 3, 2, 1, 0]);

		const index = new RerankingSearchIndex({ base, reranker });
		const result = await index.search('src-1', 'q', { topK: 2 });

		expect(result.chunks).toHaveLength(2);
		expect(result.chunks.map((c) => c.text)).toEqual(['e', 'd']);
	});

	it('emits rag.rerank.applied audit on success', async () => {
		const base = makeMockBase(
			buildBaseHits([
				{ text: 'first', score: 0.5 },
				{ text: 'second', score: 0.4 },
			]),
		);
		const reranker = makeMockReranker([1, 0]);
		const audits: RerankAuditEntry[] = [];

		const index = new RerankingSearchIndex({
			base,
			reranker,
			onAudit: (e) => audits.push(e),
		});
		await index.search('src-1', 'q', { topK: 2 });

		expect(audits).toHaveLength(1);
		expect(audits[0]!.type).toBe('rag.rerank.applied');
		expect(audits[0]!.payload).toMatchObject({
			sourceId: 'src-1',
			model: 'rerank-multilingual-v3.0',
			candidates: 2,
			returned: 2,
		});
	});

	it('passes folders and fileTypes through to the base index', async () => {
		const base = makeMockBase(buildBaseHits([{ text: 'x', score: 0.5 }]));
		const reranker = makeMockReranker([0]);

		const index = new RerankingSearchIndex({ base, reranker });
		await index.search('src-1', 'q', {
			topK: 3,
			folders: ['docs/faq'],
			fileTypes: ['.pdf'],
		});

		expect(base.search.mock.calls[0]![2]).toMatchObject({
			folders: ['docs/faq'],
			fileTypes: ['.pdf'],
		});
	});
});
