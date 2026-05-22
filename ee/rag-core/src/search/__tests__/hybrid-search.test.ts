// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';

import { runRagMigrations } from '../../storage/schema.js';
import { HybridSearchIndex, escapeFtsQuery } from '../hybrid-search.js';
import type { EmbeddingClient, VectorStore } from '../../types.js';

// ---------------------------------------------------------------------------
// Test fixtures — in-memory SQLite + the v5 RAG schema + a handful of
// canned `rag_documents` / `rag_chunks` rows we can search against.
// ---------------------------------------------------------------------------

interface ChunkSeed {
	chunkId: string;
	documentId: string;
	text: string;
	position?: number;
}

interface DocumentSeed {
	id: string;
	sourceId: string;
	folderId?: string | null;
	path: string;
	name: string;
	mimeType?: string;
}

interface FolderSeed {
	id: string;
	sourceId: string;
	path: string;
	name: string;
	parentId?: string | null;
}

function makeDb(): BetterSqlite3Database {
	const db = new Database(':memory:');
	runRagMigrations({ raw: db });
	// Insert a default source so rag_search has an embedding_setting_name to
	// resolve. The resolver is mocked below, so the value of the column
	// doesn't matter — it just needs to be non-null.
	db.prepare(
		`INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
		  embedding_dimensions, created_at, updated_at)
		 VALUES (?, ?, 'local', '{}', 'mock-setting', 'mock-1', 3, datetime('now'), datetime('now'))`,
	).run('src-1', 'Test KB');
	return db;
}

function insertFolder(db: BetterSqlite3Database, seed: FolderSeed): void {
	db.prepare(
		`INSERT INTO rag_folders (id, source_id, parent_id, path, name)
		 VALUES (?, ?, ?, ?, ?)`,
	).run(seed.id, seed.sourceId, seed.parentId ?? null, seed.path, seed.name);
}

function insertDocument(db: BetterSqlite3Database, seed: DocumentSeed): void {
	db.prepare(
		`INSERT INTO rag_documents
		 (id, source_id, folder_id, path, name, mime_type, size, hash, etag,
		  last_indexed_at, deleted_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)`,
	).run(
		seed.id,
		seed.sourceId,
		seed.folderId ?? null,
		seed.path,
		seed.name,
		seed.mimeType ?? 'text/plain',
		seed.path.length,
		'hash-' + seed.id,
		null,
	);
}

function insertChunk(db: BetterSqlite3Database, seed: ChunkSeed): void {
	db.prepare(
		`INSERT INTO rag_chunks
		 (id, document_id, position, text, token_count, embedding_dimensions, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
	).run(seed.chunkId, seed.documentId, seed.position ?? 0, seed.text, seed.text.split(/\s+/).length, 3);
}

/**
 * Build a deterministic mock VectorStore that returns a caller-controlled
 * ranking. Distances are derived from rank order (i / 100) so callers don't
 * have to fiddle with them. Implements all four interface methods (delete
 * variants are no-ops).
 */
function makeMockVectorStore(ranked: string[]): VectorStore {
	return {
		search: vi
			.fn()
			.mockImplementation((_q: Float32Array, topK: number) =>
				ranked.slice(0, topK).map((chunkId, i) => ({ chunkId, distance: i / 100 })),
			),
		upsert: vi.fn(),
		delete: vi.fn(),
		deleteByDocument: vi.fn(),
	};
}

function makeMockEmbeddingClient(): EmbeddingClient {
	return {
		dimensions: 3,
		modelName: 'mock-embed',
		embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HybridSearchIndex', () => {
	let db: BetterSqlite3Database;

	beforeEach(() => {
		db = makeDb();
	});

	// 1. Keyword-only match → returned via FTS branch
	it('returns a chunk that only matches the keyword branch', async () => {
		insertDocument(db, { id: 'doc-1', sourceId: 'src-1', path: 'a.md', name: 'a.md' });
		insertChunk(db, {
			chunkId: 'c-keyword',
			documentId: 'doc-1',
			text: 'The KubernetesOperator pattern simplifies cluster management.',
		});
		insertChunk(db, {
			chunkId: 'c-other',
			documentId: 'doc-1',
			text: 'Unrelated content about cooking recipes.',
			position: 1,
		});

		// Vector branch returns NOTHING for this query.
		const vectorStore = makeMockVectorStore([]);
		const index = new HybridSearchIndex({
			db,
			vectorStore,
			resolveEmbeddingClient: () => makeMockEmbeddingClient(),
		});

		const result = await index.search('src-1', 'KubernetesOperator', { topK: 5 });
		expect(result.chunks.map((c) => c.text)).toContain(
			'The KubernetesOperator pattern simplifies cluster management.',
		);
		// And the unrelated chunk is absent.
		expect(result.chunks.find((c) => c.text.includes('cooking'))).toBeUndefined();
	});

	// 2. Vector-only match → returned via vector branch
	it('returns a chunk that only matches the vector branch', async () => {
		insertDocument(db, { id: 'doc-1', sourceId: 'src-1', path: 'a.md', name: 'a.md' });
		insertChunk(db, {
			chunkId: 'c-semantic',
			documentId: 'doc-1',
			text: 'Container orchestration is a complex topic.',
		});

		// Vector returns the chunk; FTS query won't match because the words
		// differ (we search for "Kubernetes" but the text only mentions
		// "Container orchestration").
		const vectorStore = makeMockVectorStore(['c-semantic']);
		const index = new HybridSearchIndex({
			db,
			vectorStore,
			resolveEmbeddingClient: () => makeMockEmbeddingClient(),
		});

		const result = await index.search('src-1', 'Kubernetes', { topK: 5 });
		expect(result.chunks).toHaveLength(1);
		expect(result.chunks[0]!.documentId).toBe('doc-1');
	});

	// 3. Chunk in both sets ranks higher than chunk in only one set
	it('ranks chunks present in both branches higher than single-branch chunks', async () => {
		insertDocument(db, { id: 'doc-1', sourceId: 'src-1', path: 'a.md', name: 'a.md' });
		insertChunk(db, {
			chunkId: 'c-both',
			documentId: 'doc-1',
			text: 'The Kubernetes Operator is a cluster pattern.',
		});
		insertChunk(db, {
			chunkId: 'c-vector-only',
			documentId: 'doc-1',
			text: 'Container scheduling at scale.',
			position: 1,
		});
		insertChunk(db, {
			chunkId: 'c-keyword-only',
			documentId: 'doc-1',
			// Same keyword presence as c-both, but vector won't list it.
			text: 'The Kubernetes Operator pattern.',
			position: 2,
		});

		// Vector ranks c-both first, c-vector-only second. c-keyword-only NOT
		// returned by vector.
		const vectorStore = makeMockVectorStore(['c-both', 'c-vector-only']);
		const index = new HybridSearchIndex({
			db,
			vectorStore,
			resolveEmbeddingClient: () => makeMockEmbeddingClient(),
		});

		const result = await index.search('src-1', 'Kubernetes', { topK: 5 });
		const ids = result.chunks.map((c) => c.documentId);
		expect(ids).toHaveLength(3);
		// c-both must be first — it gets both branches' contributions.
		// We assert the top result's text contains the both-match content.
		expect(result.chunks[0]!.text).toContain('The Kubernetes Operator is a cluster pattern.');
		// And its score is strictly greater than each of the single-branch
		// chunks.
		const both = result.chunks.find(
			(c) => c.text === 'The Kubernetes Operator is a cluster pattern.',
		)!;
		const other1 = result.chunks.find((c) => c.text === 'Container scheduling at scale.')!;
		const other2 = result.chunks.find((c) => c.text === 'The Kubernetes Operator pattern.')!;
		expect(both.score).toBeGreaterThan(other1.score);
		expect(both.score).toBeGreaterThan(other2.score);
	});

	// 4. RRF with k=60 and rank=1 in both branches → score ≈ 2/61
	it('produces RRF score = 2/(k+1) for chunks at rank 1 in both branches', async () => {
		insertDocument(db, { id: 'doc-1', sourceId: 'src-1', path: 'a.md', name: 'a.md' });
		insertChunk(db, {
			chunkId: 'c-top',
			documentId: 'doc-1',
			text: 'singletoken',
		});
		const vectorStore = makeMockVectorStore(['c-top']);
		const index = new HybridSearchIndex({
			db,
			vectorStore,
			resolveEmbeddingClient: () => makeMockEmbeddingClient(),
			rrfK: 60,
		});

		const result = await index.search('src-1', 'singletoken', { topK: 1 });
		expect(result.chunks).toHaveLength(1);
		// rank 1 in vector branch (1/61) + rank 1 in keyword branch (1/61).
		const expected = 1 / 61 + 1 / 61;
		expect(result.chunks[0]!.score).toBeCloseTo(expected, 6);
	});

	// 5. folders filter applied to both branches
	it('respects the folders filter on both branches', async () => {
		insertFolder(db, { id: 'f-allowed', sourceId: 'src-1', path: 'docs/faq', name: 'faq' });
		insertFolder(db, {
			id: 'f-blocked',
			sourceId: 'src-1',
			path: 'docs/internal',
			name: 'internal',
		});
		insertDocument(db, {
			id: 'doc-allowed',
			sourceId: 'src-1',
			folderId: 'f-allowed',
			path: 'docs/faq/a.md',
			name: 'a.md',
		});
		insertDocument(db, {
			id: 'doc-blocked',
			sourceId: 'src-1',
			folderId: 'f-blocked',
			path: 'docs/internal/b.md',
			name: 'b.md',
		});
		insertChunk(db, {
			chunkId: 'c-allowed',
			documentId: 'doc-allowed',
			text: 'KubernetesOperator content allowed.',
		});
		insertChunk(db, {
			chunkId: 'c-blocked',
			documentId: 'doc-blocked',
			text: 'KubernetesOperator content blocked.',
		});

		const vectorStore = makeMockVectorStore(['c-blocked', 'c-allowed']);
		const index = new HybridSearchIndex({
			db,
			vectorStore,
			resolveEmbeddingClient: () => makeMockEmbeddingClient(),
		});

		const result = await index.search('src-1', 'KubernetesOperator', {
			topK: 5,
			folders: ['docs/faq'],
		});
		expect(result.chunks).toHaveLength(1);
		expect(result.chunks[0]!.documentId).toBe('doc-allowed');
	});

	// 6. fileTypes filter applied to both branches
	it('respects the fileTypes filter on both branches', async () => {
		insertDocument(db, {
			id: 'doc-pdf',
			sourceId: 'src-1',
			path: 'a.pdf',
			name: 'a.pdf',
			mimeType: 'application/pdf',
		});
		insertDocument(db, {
			id: 'doc-md',
			sourceId: 'src-1',
			path: 'b.md',
			name: 'b.md',
			mimeType: 'text/markdown',
		});
		insertChunk(db, {
			chunkId: 'c-pdf',
			documentId: 'doc-pdf',
			text: 'AcronymXYZ inside a pdf.',
		});
		insertChunk(db, {
			chunkId: 'c-md',
			documentId: 'doc-md',
			text: 'AcronymXYZ inside a markdown file.',
		});

		const vectorStore = makeMockVectorStore(['c-md', 'c-pdf']);
		const index = new HybridSearchIndex({
			db,
			vectorStore,
			resolveEmbeddingClient: () => makeMockEmbeddingClient(),
		});

		const result = await index.search('src-1', 'AcronymXYZ', {
			topK: 5,
			fileTypes: ['.pdf'],
		});
		expect(result.chunks).toHaveLength(1);
		expect(result.chunks[0]!.documentId).toBe('doc-pdf');
	});

	// 7. Special characters in query don't crash FTS
	it('does not crash on queries with FTS5 syntax characters', async () => {
		insertDocument(db, { id: 'doc-1', sourceId: 'src-1', path: 'a.md', name: 'a.md' });
		insertChunk(db, {
			chunkId: 'c-1',
			documentId: 'doc-1',
			text: 'select star from users where id equals one.',
		});
		const vectorStore = makeMockVectorStore(['c-1']);
		const index = new HybridSearchIndex({
			db,
			vectorStore,
			resolveEmbeddingClient: () => makeMockEmbeddingClient(),
		});

		// FTS5 reserved syntax: ()-*"^:
		await expect(
			index.search('src-1', 'SELECT * FROM users WHERE id = (1)', { topK: 5 }),
		).resolves.toBeDefined();
	});

	// 8. Empty query after escape → fallback to vector-only, no crash
	it('falls back to vector-only when the escaped query is empty', async () => {
		insertDocument(db, { id: 'doc-1', sourceId: 'src-1', path: 'a.md', name: 'a.md' });
		insertChunk(db, { chunkId: 'c-1', documentId: 'doc-1', text: 'some content' });
		const vectorStore = makeMockVectorStore(['c-1']);
		const index = new HybridSearchIndex({
			db,
			vectorStore,
			resolveEmbeddingClient: () => makeMockEmbeddingClient(),
		});

		// All punctuation: escapeFtsQuery returns '', so FTS is skipped.
		const result = await index.search('src-1', '(){}[]!?', { topK: 5 });
		expect(result.chunks).toHaveLength(1);
		// Single-branch ranking → score = 1/(k+1) with k=60 → 1/61
		expect(result.chunks[0]!.score).toBeCloseTo(1 / 61, 6);
	});

	// 9. Pre-v5 DB (no FTS table) → fallback vector-only, warn once
	it('falls back gracefully and warns once when rag_chunks_fts is missing', async () => {
		insertDocument(db, { id: 'doc-1', sourceId: 'src-1', path: 'a.md', name: 'a.md' });
		insertChunk(db, { chunkId: 'c-1', documentId: 'doc-1', text: 'kubernetes content' });
		// Simulate a pre-v5 DB by dropping the FTS table.
		db.exec('DROP TABLE rag_chunks_fts');

		const vectorStore = makeMockVectorStore(['c-1']);
		const warn = vi.fn();
		const index = new HybridSearchIndex({
			db,
			vectorStore,
			resolveEmbeddingClient: () => makeMockEmbeddingClient(),
			logger: { warn },
		});

		const r1 = await index.search('src-1', 'kubernetes', { topK: 5 });
		expect(r1.chunks).toHaveLength(1);
		const r2 = await index.search('src-1', 'kubernetes', { topK: 5 });
		expect(r2.chunks).toHaveLength(1);

		// Warn called exactly once across two invocations.
		const ftsWarnings = warn.mock.calls.filter((args) =>
			String(args[0]).includes('rag_chunks_fts is missing'),
		);
		expect(ftsWarnings).toHaveLength(1);
	});

	// 10. topK > total chunks → returns all, no padding
	it('returns at most as many chunks as exist when topK exceeds the corpus size', async () => {
		insertDocument(db, { id: 'doc-1', sourceId: 'src-1', path: 'a.md', name: 'a.md' });
		insertChunk(db, { chunkId: 'c-1', documentId: 'doc-1', text: 'apple banana cherry' });
		insertChunk(db, {
			chunkId: 'c-2',
			documentId: 'doc-1',
			text: 'apple delta echo',
			position: 1,
		});
		insertChunk(db, {
			chunkId: 'c-3',
			documentId: 'doc-1',
			text: 'apple foxtrot golf',
			position: 2,
		});

		const vectorStore = makeMockVectorStore(['c-1', 'c-2', 'c-3']);
		const index = new HybridSearchIndex({
			db,
			vectorStore,
			resolveEmbeddingClient: () => makeMockEmbeddingClient(),
		});

		const result = await index.search('src-1', 'apple', { topK: 10 });
		expect(result.chunks).toHaveLength(3);
	});

	// 11. Soft-deleted documents are excluded from both branches
	it('excludes soft-deleted documents from both branches', async () => {
		insertDocument(db, { id: 'doc-1', sourceId: 'src-1', path: 'a.md', name: 'a.md' });
		insertChunk(db, { chunkId: 'c-1', documentId: 'doc-1', text: 'AcronymXYZ live content' });
		insertDocument(db, { id: 'doc-2', sourceId: 'src-1', path: 'b.md', name: 'b.md' });
		insertChunk(db, { chunkId: 'c-2', documentId: 'doc-2', text: 'AcronymXYZ deleted content' });
		db.prepare(`UPDATE rag_documents SET deleted_at = datetime('now') WHERE id = ?`).run('doc-2');

		const vectorStore = makeMockVectorStore(['c-2', 'c-1']);
		const index = new HybridSearchIndex({
			db,
			vectorStore,
			resolveEmbeddingClient: () => makeMockEmbeddingClient(),
		});

		const result = await index.search('src-1', 'AcronymXYZ', { topK: 5 });
		expect(result.chunks).toHaveLength(1);
		expect(result.chunks[0]!.documentId).toBe('doc-1');
	});

	// 12. escapeFtsQuery — unit coverage for the escape helper
	describe('escapeFtsQuery', () => {
		it('strips FTS5 syntax characters', () => {
			expect(escapeFtsQuery('hello (world)')).toContain('"hello"');
			expect(escapeFtsQuery('hello (world)')).toContain('"world"');
		});

		it('preserves Unicode letters with diacritics', () => {
			expect(escapeFtsQuery('café résumé')).toContain('"café"');
			expect(escapeFtsQuery('café résumé')).toContain('"résumé"');
		});

		it('returns empty string for punctuation-only input', () => {
			expect(escapeFtsQuery('()[]{}!?@#$%^&*')).toBe('');
		});

		it('joins multiple terms with OR for bag-of-words matching', () => {
			expect(escapeFtsQuery('foo bar')).toBe('"foo" OR "bar"');
		});
	});

	// 13. tenantId filtering — defense-in-depth at the SQL layer
	describe('tenantId filtering', () => {
		function insertSource(dbArg: BetterSqlite3Database, id: string, tenantId = 'default'): void {
			dbArg.prepare(
				`INSERT OR IGNORE INTO rag_sources
				 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
				  embedding_dimensions, tenant_id, created_at, updated_at)
				 VALUES (?, ?, 'local', '{}', 'mock-setting', 'mock-1', 3, ?, datetime('now'), datetime('now'))`,
			).run(id, `KB-${id}`, tenantId);
		}

		function insertDocumentWithTenant(
			dbArg: BetterSqlite3Database,
			seed: DocumentSeed & { tenantId?: string },
		): void {
			dbArg.prepare(
				`INSERT INTO rag_documents
				 (id, source_id, folder_id, path, name, mime_type, size, hash, etag,
				  tenant_id, last_indexed_at, deleted_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)`,
			).run(
				seed.id,
				seed.sourceId,
				seed.folderId ?? null,
				seed.path,
				seed.name,
				seed.mimeType ?? 'text/plain',
				seed.path.length,
				'hash-' + seed.id,
				null,
				seed.tenantId ?? 'default',
			);
		}

		function insertChunkWithTenant(
			dbArg: BetterSqlite3Database,
			seed: ChunkSeed & { tenantId?: string },
		): void {
			dbArg.prepare(
				`INSERT INTO rag_chunks
				 (id, document_id, position, text, token_count, embedding_dimensions, tenant_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
			).run(
				seed.chunkId,
				seed.documentId,
				seed.position ?? 0,
				seed.text,
				seed.text.split(/\s+/).length,
				3,
				seed.tenantId ?? 'default',
			);
		}

		it('vector branch: excludes chunks whose tenant_id differs from the filter', async () => {
			// Two sources: src-a (tenant A) and src-b (tenant B) — both registered
			// but we only query with tenantId='tenant-a'.
			insertSource(db, 'src-a', 'tenant-a');
			insertSource(db, 'src-b', 'tenant-b');
			insertDocumentWithTenant(db, { id: 'doc-a', sourceId: 'src-a', path: 'a.md', name: 'a.md', tenantId: 'tenant-a' });
			insertDocumentWithTenant(db, { id: 'doc-b', sourceId: 'src-b', path: 'b.md', name: 'b.md', tenantId: 'tenant-b' });
			insertChunkWithTenant(db, { chunkId: 'c-a', documentId: 'doc-a', text: 'tenant-a content', tenantId: 'tenant-a' });
			insertChunkWithTenant(db, { chunkId: 'c-b', documentId: 'doc-b', text: 'tenant-a content', tenantId: 'tenant-b' });

			// Vector returns both chunks, but the tenantId filter should exclude c-b.
			const vectorStore = makeMockVectorStore(['c-a', 'c-b']);
			const index = new HybridSearchIndex({
				db,
				vectorStore,
				resolveEmbeddingClient: () => makeMockEmbeddingClient(),
			});

			const result = await index.search('src-a', 'content', { topK: 5, tenantId: 'tenant-a' });
			const chunkIds = result.chunks.map((c) => c.documentId);
			expect(chunkIds).toContain('doc-a');
			expect(chunkIds).not.toContain('doc-b');
		});

		it('FTS branch: excludes chunks whose tenant_id differs from the filter', async () => {
			insertSource(db, 'src-c', 'tenant-c');
			insertSource(db, 'src-d', 'tenant-d');
			insertDocumentWithTenant(db, { id: 'doc-c', sourceId: 'src-c', path: 'c.md', name: 'c.md', tenantId: 'tenant-c' });
			insertDocumentWithTenant(db, { id: 'doc-d', sourceId: 'src-d', path: 'd.md', name: 'd.md', tenantId: 'tenant-d' });
			insertChunkWithTenant(db, { chunkId: 'c-c', documentId: 'doc-c', text: 'uniquewordxxx', tenantId: 'tenant-c' });
			insertChunkWithTenant(db, { chunkId: 'c-d', documentId: 'doc-d', text: 'uniquewordxxx', tenantId: 'tenant-d' });

			// Vector returns nothing → keyword branch only.
			const vectorStore = makeMockVectorStore([]);
			const index = new HybridSearchIndex({
				db,
				vectorStore,
				resolveEmbeddingClient: () => makeMockEmbeddingClient(),
			});

			const result = await index.search('src-c', 'uniquewordxxx', { topK: 5, tenantId: 'tenant-c' });
			const docIds = result.chunks.map((c) => c.documentId);
			expect(docIds).toContain('doc-c');
			expect(docIds).not.toContain('doc-d');
		});

		it('no tenantId filter → returns chunks from all tenants (backward compat)', async () => {
			insertSource(db, 'src-e', 'tenant-e');
			insertDocumentWithTenant(db, { id: 'doc-e1', sourceId: 'src-e', path: 'e1.md', name: 'e1.md', tenantId: 'tenant-e' });
			insertDocumentWithTenant(db, { id: 'doc-e2', sourceId: 'src-e', path: 'e2.md', name: 'e2.md', tenantId: 'tenant-other' });
			insertChunkWithTenant(db, { chunkId: 'c-e1', documentId: 'doc-e1', text: 'sharedword', tenantId: 'tenant-e' });
			insertChunkWithTenant(db, { chunkId: 'c-e2', documentId: 'doc-e2', text: 'sharedword', tenantId: 'tenant-other' });

			const vectorStore = makeMockVectorStore(['c-e1', 'c-e2']);
			const index = new HybridSearchIndex({
				db,
				vectorStore,
				resolveEmbeddingClient: () => makeMockEmbeddingClient(),
			});

			// No tenantId — backward compat: both chunks should appear.
			const result = await index.search('src-e', 'sharedword', { topK: 5 });
			const docIds = result.chunks.map((c) => c.documentId);
			expect(docIds).toContain('doc-e1');
			expect(docIds).toContain('doc-e2');
		});
	});
});
