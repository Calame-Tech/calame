// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * End-to-end RAG happy-path: real IngestionPipeline → real SQLite storage →
 * DocumentSourceAdapter → `rag_search` MCP tool handler → PII-masked response.
 *
 * This test closes the "ingest → search → MCP" gap the integration plan
 * flagged as the priority-haute follow-up after Phase 4 (rag-integration-plan.md,
 * "Tests E2E manquants"). Previous suites mock either the pipeline OR the search
 * index OR the storage layer — none exercise the chain together with the actual
 * SQL JOINs and the actual chunker.
 *
 * Out of scope (intentional):
 *   - HTTP multipart parsing in `rag-upload.ts`: formidable requires a real
 *     HTTP request stream and `ee/rag-core` doesn't ship supertest. The upload
 *     route's only logic beyond `pipeline.ingestDocument(...)` is a 404 check,
 *     a type='local' gate and the multipart parse. The pipeline call is the
 *     part the unit tests didn't cover; we drive it directly here exactly as
 *     `rag-upload.ts:183` does in production.
 *   - sqlite-vec native loader: the host runtime uses it, but the load fails
 *     intermittently on dev machines (NODE_MODULE_VERSION mismatches). We
 *     substitute an in-memory `VectorStore` that mirrors its contract — the
 *     pipeline and adapter code paths are identical.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
	Source,
	ScopeSelection,
	McpRegistrationContext,
	AuditLogEntry,
	PiiCategory,
} from '@calame/core';

import { runRagMigrations } from '../storage/schema.js';
import { IngestionPipeline } from '../pipeline/ingest.js';
import { buildDocumentSourceAdapter } from '../source-adapter.js';
import type {
	DocumentAdapterDeps,
	DocumentSearchIndex,
	DocumentStorage,
	ConnectorLike,
} from '../source-adapter.js';
import type {
	RagSource,
	RagDocument,
	RagFolder,
	VectorStore,
	EmbeddingClient,
} from '../types.js';
import { parseRagPiiConfig } from '../pii-masking.js';

// ---------------------------------------------------------------------------
// Fakes — deterministic, in-process versions of the host-side dependencies.
// ---------------------------------------------------------------------------

/**
 * Map-backed VectorStore. Mirrors the `SqliteVecStore` contract from
 * `storage/sqlite-vec-store.ts` but avoids the native sqlite-vec loader.
 * `deleteByDocument` is intentionally NOT wired to a doc→chunks index because
 * the pipeline only calls it when re-ingesting (hash mismatch on an existing
 * row); this test exercises first-time ingestion only.
 */
function makeVectorStore(): VectorStore {
	const vectors = new Map<string, Float32Array>();
	return {
		upsert(chunkId, embedding) {
			vectors.set(chunkId, embedding);
		},
		delete(chunkId) {
			vectors.delete(chunkId);
		},
		deleteByDocument() {
			// No-op for first-time-only ingestion. Re-ingestion paths are
			// covered by the unit tests in `pipeline/__tests__/ingest.test.ts`.
		},
		search(query, topK) {
			const results: Array<{ chunkId: string; distance: number }> = [];
			for (const [chunkId, vec] of vectors) {
				// Cosine-distance proxy: 1 − dot product over equally-shaped
				// vectors. We don't normalize because the deterministic
				// embedder below already produces vectors of stable magnitude.
				let dot = 0;
				for (let i = 0; i < query.length; i++) {
					dot += (query[i] ?? 0) * (vec[i] ?? 0);
				}
				results.push({ chunkId, distance: 1 - dot });
			}
			results.sort((a, b) => a.distance - b.distance);
			return results.slice(0, topK);
		},
	};
}

/**
 * Character-frequency embedding. Texts that share characters land close in
 * vector space, which is enough to make the search deterministic and
 * ranking-meaningful for this E2E test. Two identical strings produce
 * identical vectors (so an embedded query exactly matching a chunk text
 * ranks first).
 */
const EMBED_DIM = 16;
function makeEmbeddingClient(): EmbeddingClient {
	return {
		dimensions: EMBED_DIM,
		modelName: 'mock-embedding-v1',
		async embed(texts) {
			return texts.map((t) => {
				const v = new Array(EMBED_DIM).fill(0) as number[];
				for (let i = 0; i < t.length; i++) {
					v[t.charCodeAt(i) % EMBED_DIM] += 1;
				}
				// L2-normalize so the cosine proxy in `vectorStore.search`
				// stays in a sensible range.
				let norm = 0;
				for (const x of v) norm += x * x;
				norm = Math.sqrt(norm) || 1;
				return v.map((x) => x / norm);
			});
		},
	};
}

function makeConnector(): ConnectorLike {
	return {
		type: 'local',
		async testConnection() {
			/* always succeeds for the test fixture */
		},
	};
}

// ---------------------------------------------------------------------------
// Real storage + search index implementations over the in-memory DB.
// These mirror the host-side closures in `packages/cli/src/rag-runtime.ts`
// (the legacy vector-only branch + the `storage` factory) — keeping them in
// sync isn't possible without re-exporting them from the host, which would
// pull Apache code into BUSL. We reproduce the minimum surface here.
// ---------------------------------------------------------------------------

interface RagFolderRow {
	id: string;
	source_id: string;
	parent_id: string | null;
	path: string;
	name: string;
	tenant_id: string | null;
	created_at: string;
}
interface RagDocumentRow {
	id: string;
	source_id: string;
	folder_id: string | null;
	path: string;
	name: string;
	mime_type: string;
	size: number;
	hash: string;
	etag: string | null;
	tenant_id: string | null;
	last_indexed_at: string;
	deleted_at: string | null;
}
interface ChunkJoinRow {
	chunk_id: string;
	chunk_text: string;
	chunk_position: number;
	doc_id: string;
	doc_source_id: string;
	doc_name: string;
	folder_path: string | null;
}

function buildStorage(db: BetterSqlite3Database): DocumentStorage {
	const rowToFolder = (r: RagFolderRow): RagFolder => ({
		id: r.id,
		sourceId: r.source_id,
		parentId: r.parent_id,
		path: r.path,
		name: r.name,
		tenantId: r.tenant_id ?? 'default',
		createdAt: r.created_at,
	});
	const rowToDoc = (r: RagDocumentRow): RagDocument => ({
		id: r.id,
		sourceId: r.source_id,
		folderId: r.folder_id,
		path: r.path,
		name: r.name,
		mimeType: r.mime_type,
		size: r.size,
		hash: r.hash,
		etag: r.etag,
		tenantId: r.tenant_id ?? 'default',
		lastIndexedAt: r.last_indexed_at,
		deletedAt: r.deleted_at,
	});
	return {
		async listFolders(sourceId, parent) {
			const rows: RagFolderRow[] =
				parent !== undefined
					? db
							.prepare<[string, string], RagFolderRow>(
								`SELECT * FROM rag_folders WHERE source_id = ? AND parent_id = ? ORDER BY path ASC`,
							)
							.all(sourceId, parent)
					: db
							.prepare<[string], RagFolderRow>(
								`SELECT * FROM rag_folders WHERE source_id = ? ORDER BY path ASC`,
							)
							.all(sourceId);
			return rows.map(rowToFolder);
		},
		async listDocuments(sourceId, folder) {
			const rows: RagDocumentRow[] =
				folder !== undefined
					? db
							.prepare<[string, string], RagDocumentRow>(
								`SELECT * FROM rag_documents WHERE source_id = ? AND folder_id = ? AND deleted_at IS NULL ORDER BY path ASC`,
							)
							.all(sourceId, folder)
					: db
							.prepare<[string], RagDocumentRow>(
								`SELECT * FROM rag_documents WHERE source_id = ? AND deleted_at IS NULL ORDER BY path ASC`,
							)
							.all(sourceId);
			return rows.map(rowToDoc);
		},
		async getDocument(documentId) {
			const row = db
				.prepare<[string], RagDocumentRow>(`SELECT * FROM rag_documents WHERE id = ?`)
				.get(documentId);
			if (!row) return null;
			const chunks = db
				.prepare<[string], { text: string }>(
					`SELECT text FROM rag_chunks WHERE document_id = ? ORDER BY position ASC`,
				)
				.all(documentId);
			return { doc: rowToDoc(row), text: chunks.map((c) => c.text).join('\n') };
		},
		async listSources() {
			interface AggRow {
				id: string;
				name: string;
				type: string;
				folder_count: number;
				document_count: number;
			}
			const rows = db
				.prepare<[], AggRow>(
					`SELECT
					   s.id, s.name, s.type,
					   (SELECT COUNT(*) FROM rag_folders f WHERE f.source_id = s.id) AS folder_count,
					   (SELECT COUNT(*) FROM rag_documents d
					     WHERE d.source_id = s.id AND d.deleted_at IS NULL) AS document_count
					 FROM rag_sources s
					 WHERE s.deleted_at IS NULL
					 ORDER BY s.created_at ASC`,
				)
				.all();
			return rows.map((r) => ({
				id: r.id,
				name: r.name,
				type: r.type,
				folderCount: r.folder_count,
				documentCount: r.document_count,
			}));
		},
	};
}

function buildSearchIndex(
	db: BetterSqlite3Database,
	vectorStore: VectorStore,
	embeddingClient: EmbeddingClient,
): DocumentSearchIndex {
	return {
		async search(sourceId, query, opts) {
			const queryVec = new Float32Array((await embeddingClient.embed([query]))[0] ?? []);
			const topK = Math.min(opts.topK ?? 5, 10);
			const vecResults = vectorStore.search(queryVec, topK * 4);
			if (vecResults.length === 0) return { chunks: [] };

			const placeholders = vecResults.map(() => '?').join(',');
			const chunkIds = vecResults.map((r) => r.chunkId);
			const rows = db
				.prepare<string[], ChunkJoinRow>(
					`SELECT
					   c.id        AS chunk_id,
					   c.text      AS chunk_text,
					   c.position  AS chunk_position,
					   d.id        AS doc_id,
					   d.source_id AS doc_source_id,
					   d.name      AS doc_name,
					   f.path      AS folder_path
					 FROM rag_chunks c
					 JOIN rag_documents d ON d.id = c.document_id
					 LEFT JOIN rag_folders f ON f.id = d.folder_id
					 WHERE c.id IN (${placeholders})
					   AND d.source_id = ?
					   AND d.deleted_at IS NULL`,
				)
				.all(...chunkIds, sourceId);

			const filtered = rows.filter((row) => {
				if (!opts.folders || opts.folders.length === 0) return true;
				const fp = row.folder_path ?? '';
				return opts.folders.some((f) => fp === f || fp.startsWith(f + '/'));
			});

			const distanceMap = new Map(vecResults.map((r) => [r.chunkId, r.distance]));
			return {
				chunks: filtered
					.sort(
						(a, b) =>
							(distanceMap.get(a.chunk_id) ?? 1) - (distanceMap.get(b.chunk_id) ?? 1),
					)
					.slice(0, topK)
					.map((row) => ({
						text: row.chunk_text,
						score: 1 - (distanceMap.get(row.chunk_id) ?? 1),
						sourceId: row.doc_source_id,
						folder: row.folder_path ?? '',
						fileName: row.doc_name,
						position: row.chunk_position,
						documentId: row.doc_id,
					})),
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function insertSource(db: BetterSqlite3Database, overrides?: Partial<RagSource>): RagSource {
	const source: RagSource = {
		id: 'src-e2e',
		name: 'E2E Knowledge Base',
		type: 'local',
		configEncrypted: '{}',
		embeddingSettingName: 'mock',
		embeddingModelVersion: 'mock-embedding-v1',
		tenantId: 'default',
		deletedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
	db.prepare(
		`INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
		  embedding_dimensions, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		source.id,
		source.name,
		source.type,
		source.configEncrypted,
		source.embeddingSettingName,
		source.embeddingModelVersion,
		EMBED_DIM,
		source.createdAt,
		source.updatedAt,
	);
	return source;
}

function makeMcpServer(): McpServer {
	// Captures the `(name, description, schema, handler)` registrations.
	const calls: unknown[][] = [];
	const tool = (...args: unknown[]) => {
		calls.push(args);
		return undefined as unknown as ReturnType<McpServer['tool']>;
	};
	(tool as unknown as { calls: unknown[][] }).calls = calls;
	return { tool } as unknown as McpServer;
}

type RagSearchHandler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
}>;

function findToolHandler(server: McpServer, toolName: string): RagSearchHandler {
	const calls = (server.tool as unknown as { calls: unknown[][] }).calls;
	const call = calls.find((c) => c[0] === toolName);
	if (!call) throw new Error(`Tool "${toolName}" was not registered`);
	return call[3] as RagSearchHandler;
}

function makeAllowAllScope(): Extract<ScopeSelection, { kind: 'document' }> {
	return { kind: 'document', mode: 'allowAll', allowedFolders: [], allowedDocuments: [] };
}

function makeAllowListScope(
	allowedFolders: string[],
	allowedDocuments: string[] = [],
): Extract<ScopeSelection, { kind: 'document' }> {
	return { kind: 'document', mode: 'allowList', allowedFolders, allowedDocuments };
}

function makeCtx(
	source: RagSource,
	server: McpServer,
	selection: ScopeSelection,
	auditEntries: AuditLogEntry[],
): McpRegistrationContext<{ root: string }, Extract<import('@calame/core').SourceSchema, { kind: 'document' }>> {
	const adapterSource: Source = {
		id: source.id,
		name: source.name,
		type: source.type,
		configEncrypted: source.configEncrypted,
		capabilities: [],
		createdAt: source.createdAt,
		updatedAt: source.updatedAt,
	};
	return {
		server,
		source: adapterSource,
		config: { root: '/data' },
		schema: { kind: 'document', folders: [], documents: [] },
		selection,
		profileName: 'e2e-profile',
		toolNamespace: '',
		responseMode: 'raw',
		onAuditLog: (entry) => auditEntries.push(entry),
	};
}

// ---------------------------------------------------------------------------
// The E2E test
// ---------------------------------------------------------------------------

describe('RAG end-to-end — ingest → search → MCP', () => {
	let db: BetterSqlite3Database;
	let vectorStore: VectorStore;
	let embeddingClient: EmbeddingClient;
	let pipeline: IngestionPipeline;
	let source: RagSource;

	beforeEach(() => {
		db = new Database(':memory:');
		runRagMigrations({ raw: db });
		vectorStore = makeVectorStore();
		embeddingClient = makeEmbeddingClient();
		pipeline = new IngestionPipeline({ db, vectorStore, embeddingClient });
		source = insertSource(db);
	});

	// -------------------------------------------------------------------------
	// Path A: ingest a single .txt and assert `rag_search` returns its chunk.
	// -------------------------------------------------------------------------
	it('ingests a document and returns it through rag_search', async () => {
		const buffer = Buffer.from(
			'Welcome to the knowledge base. Authentication uses OAuth tokens. ' +
				'Sessions persist for thirty days.',
			'utf8',
		);
		// Mirrors `packages/cli/.../routes/rag-upload.ts:183-192`.
		const doc = await pipeline.ingestDocument({
			source,
			folder: null,
			path: 'guides/auth.txt',
			mimeType: 'text/plain',
			buffer,
		});
		expect(doc.id).toBeTruthy();

		// The pipeline persisted chunks AND wrote vectors.
		const chunkCount = db
			.prepare<[string], { c: number }>(
				`SELECT COUNT(*) AS c FROM rag_chunks WHERE document_id = ?`,
			)
			.get(doc.id);
		expect(chunkCount?.c).toBeGreaterThan(0);

		const adapter = buildDocumentSourceAdapter(
			{
				resolveConnector: () => makeConnector(),
				storage: buildStorage(db),
				searchIndex: buildSearchIndex(db, vectorStore, embeddingClient),
				// PII masking disabled here — Path B exercises the enabled branch.
				piiMasking: parseRagPiiConfig('off'),
			} satisfies DocumentAdapterDeps,
			'local',
			'Local folder',
		);
		const server = makeMcpServer();
		const audit: AuditLogEntry[] = [];
		adapter.registerMcpTools!(makeCtx(source, server, makeAllowAllScope(), audit));

		const handler = findToolHandler(server, 'rag_search');
		const response = await handler({ query: 'OAuth authentication tokens' });
		const payload = JSON.parse(response.content[0].text) as {
			chunks: Array<{ text: string; documentId: string; fileName: string }>;
		};

		expect(payload.chunks.length).toBeGreaterThan(0);
		expect(payload.chunks[0].documentId).toBe(doc.id);
		expect(payload.chunks[0].fileName).toBe('auth.txt');
		expect(payload.chunks[0].text).toContain('OAuth');

		expect(audit).toHaveLength(1);
		expect(audit[0].toolName).toBe('rag_search');
		expect(audit[0].result).toBe('success');
	});

	// -------------------------------------------------------------------------
	// Path B: PII masking enabled — email in chunk text is redacted on the way
	// out, and the audit entry carries a non-zero `piiRedacted.email` count.
	// -------------------------------------------------------------------------
	it('masks PII in chunk text before returning through rag_search', async () => {
		const buffer = Buffer.from(
			'Account recovery: contact support at support@example.com for assistance. ' +
				'Internal escalations go to oncall@example.com.',
			'utf8',
		);
		await pipeline.ingestDocument({
			source,
			folder: null,
			path: 'support/recovery.txt',
			mimeType: 'text/plain',
			buffer,
		});

		// Default-on PII config (mode='replace', includes 'email').
		const adapter = buildDocumentSourceAdapter(
			{
				resolveConnector: () => makeConnector(),
				storage: buildStorage(db),
				searchIndex: buildSearchIndex(db, vectorStore, embeddingClient),
				piiMasking: parseRagPiiConfig(undefined),
			} satisfies DocumentAdapterDeps,
			'local',
			'Local folder',
		);
		const server = makeMcpServer();
		const audit: AuditLogEntry[] = [];
		adapter.registerMcpTools!(makeCtx(source, server, makeAllowAllScope(), audit));

		const handler = findToolHandler(server, 'rag_search');
		const response = await handler({ query: 'support email address' });
		const payload = JSON.parse(response.content[0].text) as {
			chunks: Array<{ text: string }>;
		};

		expect(payload.chunks.length).toBeGreaterThan(0);
		const joined = payload.chunks.map((c) => c.text).join(' ');
		expect(joined).not.toContain('support@example.com');
		expect(joined).not.toContain('oncall@example.com');
		expect(joined).toContain('[EMAIL]');

		// Raw chunk text in SQL still carries the email — masking is response-time only.
		const dbChunks = db
			.prepare<[], { text: string }>(`SELECT text FROM rag_chunks`)
			.all();
		const rawJoined = dbChunks.map((r) => r.text).join(' ');
		expect(rawJoined).toContain('support@example.com');

		// Audit entry exposes the redaction count (counts only, never values).
		expect(audit).toHaveLength(1);
		const args = audit[0].toolArgs as { piiRedacted?: Partial<Record<PiiCategory, number>> };
		expect(args.piiRedacted?.email ?? 0).toBeGreaterThanOrEqual(2);
	});

	// -------------------------------------------------------------------------
	// Path C: allowList scope — `rag_search` filters out chunks whose document
	// lives in a folder NOT covered by the profile's allowedFolders.
	// -------------------------------------------------------------------------
	it('filters out chunks from documents outside the allowList scope', async () => {
		// Two documents, in two different folders. We seed the folder rows
		// directly because the pipeline doesn't create folders by itself
		// (folder creation is the connector's responsibility — out of scope
		// for the pipeline-only E2E driver).
		const publicFolderId = nanoid();
		const internalFolderId = nanoid();
		db.prepare(
			`INSERT INTO rag_folders (id, source_id, parent_id, path, name, created_at)
			 VALUES (?, ?, NULL, ?, ?, ?)`,
		).run(publicFolderId, source.id, 'docs/public', 'public', '2026-01-01T00:00:00.000Z');
		db.prepare(
			`INSERT INTO rag_folders (id, source_id, parent_id, path, name, created_at)
			 VALUES (?, ?, NULL, ?, ?, ?)`,
		).run(internalFolderId, source.id, 'docs/internal', 'internal', '2026-01-01T00:00:00.000Z');

		const publicFolder: RagFolder = {
			id: publicFolderId,
			sourceId: source.id,
			parentId: null,
			path: 'docs/public',
			name: 'public',
			tenantId: 'default',
			createdAt: '2026-01-01T00:00:00.000Z',
		};
		const internalFolder: RagFolder = {
			id: internalFolderId,
			sourceId: source.id,
			parentId: null,
			path: 'docs/internal',
			name: 'internal',
			tenantId: 'default',
			createdAt: '2026-01-01T00:00:00.000Z',
		};

		await pipeline.ingestDocument({
			source,
			folder: publicFolder,
			path: 'docs/public/welcome.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('Welcome to our public product documentation portal.', 'utf8'),
		});
		const internalDoc = await pipeline.ingestDocument({
			source,
			folder: internalFolder,
			path: 'docs/internal/playbook.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('Internal incident playbook: page the oncall first.', 'utf8'),
		});

		const adapter = buildDocumentSourceAdapter(
			{
				resolveConnector: () => makeConnector(),
				storage: buildStorage(db),
				searchIndex: buildSearchIndex(db, vectorStore, embeddingClient),
				piiMasking: parseRagPiiConfig('off'),
			} satisfies DocumentAdapterDeps,
			'local',
			'Local folder',
		);
		const server = makeMcpServer();
		const audit: AuditLogEntry[] = [];
		const scope = makeAllowListScope(['docs/public']);
		adapter.registerMcpTools!(makeCtx(source, server, scope, audit));

		const handler = findToolHandler(server, 'rag_search');
		// Use a query that would match BOTH documents on character overlap.
		const response = await handler({ query: 'documentation playbook portal incident' });
		const payload = JSON.parse(response.content[0].text) as {
			chunks: Array<{ documentId: string; folder: string }>;
		};

		// Every returned chunk must be from the public folder. The internal
		// doc is reachable in the underlying SQL but the allowList filter
		// (post-search) removes it.
		expect(payload.chunks.length).toBeGreaterThan(0);
		for (const chunk of payload.chunks) {
			expect(chunk.folder).toBe('docs/public');
			expect(chunk.documentId).not.toBe(internalDoc.id);
		}
	});
});
