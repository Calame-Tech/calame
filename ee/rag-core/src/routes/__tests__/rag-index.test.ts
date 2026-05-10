// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { Readable } from 'node:stream';
import { nanoid } from 'nanoid';
import type { Express, Request, Response } from 'express';

import { runRagMigrations } from '../../storage/schema.js';
import { registerRagIndexRoutes } from '../rag-index.js';
import type { ConnectorLike, RagRouteDeps } from '../types.js';
import type { IngestionPipeline } from '../../pipeline/ingest.js';
import type { RagJob, RagSource } from '../../types.js';

// ---------------------------------------------------------------------------
// Test harness — capture the registered POST handler from a fake Express app
// so we can invoke it directly without spinning up an HTTP server.
// ---------------------------------------------------------------------------

type SyncHandler = (req: Request, res: Response) => Promise<void>;

interface CapturedApp {
	app: Express;
	getSyncHandler(): SyncHandler;
}

function makeCapturedApp(): CapturedApp {
	let syncHandler: SyncHandler | null = null;
	const app = {
		get: vi.fn(),
		post: vi.fn((path: string, handler: SyncHandler) => {
			if (path === '/api/rag/sources/:id/sync') {
				syncHandler = handler;
			}
		}),
	} as unknown as Express;
	return {
		app,
		getSyncHandler() {
			if (!syncHandler) throw new Error('sync handler was not registered');
			return syncHandler;
		},
	};
}

interface FakeResponse {
	statusCode: number;
	body: unknown;
	res: Response;
}

function makeRes(): FakeResponse {
	const r: FakeResponse = { statusCode: 200, body: undefined, res: {} as Response };
	(r.res as unknown as {
		status: (s: number) => Response;
		json: (b: unknown) => Response;
	}).status = (s: number) => {
		r.statusCode = s;
		return r.res;
	};
	(r.res as unknown as { json: (b: unknown) => Response }).json = (b: unknown) => {
		r.body = b;
		return r.res;
	};
	return r;
}

function makeReq(sourceId: string): Request {
	return { params: { id: sourceId }, query: {} } as unknown as Request;
}

// ---------------------------------------------------------------------------
// DB setup — in-memory better-sqlite3 + RAG migrations.
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3Database {
	const db = new Database(':memory:');
	runRagMigrations({ raw: db });
	return db;
}

function insertSource(db: BetterSqlite3Database, overrides?: Partial<RagSource>): RagSource {
	const source: RagSource = {
		id: 'src-1',
		name: 'Test source',
		type: 'local',
		configEncrypted: '{}',
		embeddingSettingName: 'test-embedding',
		embeddingModelVersion: 'mock-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
	db.prepare(
		`INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version, embedding_dimensions, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		source.id,
		source.name,
		source.type,
		source.configEncrypted,
		source.embeddingSettingName,
		source.embeddingModelVersion,
		16,
		source.createdAt,
		source.updatedAt,
	);
	return source;
}

interface PreseedDoc {
	path: string;
	etag: string | null;
	deleted?: boolean;
}

function preseedDocument(
	db: BetterSqlite3Database,
	sourceId: string,
	doc: PreseedDoc,
): string {
	const id = nanoid();
	db.prepare(
		`INSERT INTO rag_documents
		 (id, source_id, folder_id, path, name, mime_type, size, hash, etag, last_indexed_at, deleted_at)
		 VALUES (?, ?, NULL, ?, ?, 'text/plain', 10, 'hash-' || ?, ?, ?, ?)`,
	).run(
		id,
		sourceId,
		doc.path,
		doc.path.split('/').pop() ?? doc.path,
		doc.path,
		doc.etag,
		'2026-01-01T00:00:00.000Z',
		doc.deleted ? '2026-01-02T00:00:00.000Z' : null,
	);
	return id;
}

// ---------------------------------------------------------------------------
// Connector + pipeline mocks.
// ---------------------------------------------------------------------------

interface ConnectorDoc {
	id: string;
	path: string;
	etag: string | null;
}

function makeConnector(docs: ConnectorDoc[]): ConnectorLike & {
	fetchDocument: ReturnType<typeof vi.fn>;
} {
	const fetchDocument = vi.fn(async (_cfg: unknown, _sid: string, docId: string) => {
		const found = docs.find((d) => d.id === docId);
		if (!found) throw new Error(`unknown doc id: ${docId}`);
		return {
			stream: Readable.from([Buffer.from(`payload-${found.path}`)]),
			mimeType: 'text/plain',
		};
	});
	return {
		type: 'local',
		testConnection: vi.fn(async () => undefined),
		listFolders: vi.fn(async () => []),
		listDocuments: vi.fn(async (_cfg: unknown, sourceId: string, folder: unknown) => {
			// Only return docs at root for the simple test connector.
			if (folder !== undefined) return [];
			return docs.map((d) => ({
				id: d.id,
				sourceId,
				folderId: null,
				path: d.path,
				name: d.path.split('/').pop() ?? d.path,
				mimeType: 'text/plain',
				size: 10,
				hash: '',
				etag: d.etag,
				lastIndexedAt: '2026-01-01T00:00:00.000Z',
				deletedAt: null,
			}));
		}),
		fetchDocument,
	};
}

function makePipelineMock(): IngestionPipeline & {
	ingestDocument: ReturnType<typeof vi.fn>;
	markDocumentDeleted: ReturnType<typeof vi.fn>;
} {
	const ingestDocument = vi.fn(async () => ({}));
	const markDocumentDeleted = vi.fn();
	return {
		ingestDocument,
		markDocumentDeleted,
	} as unknown as IngestionPipeline & {
		ingestDocument: ReturnType<typeof vi.fn>;
		markDocumentDeleted: ReturnType<typeof vi.fn>;
	};
}

function makeDeps(
	db: BetterSqlite3Database,
	connector: ConnectorLike,
	pipeline: IngestionPipeline,
	overrides?: Partial<RagRouteDeps>,
): RagRouteDeps {
	return {
		db,
		pipeline,
		vectorStore: {
			upsert: vi.fn(),
			search: vi.fn(() => []),
			delete: vi.fn(),
			deleteByDocument: vi.fn(),
		},
		resolveEmbeddingClient: vi.fn(() => ({
			dimensions: 16,
			modelName: 'mock-1',
			embed: async () => [],
		})),
		resolveEmbeddingSetting: vi.fn(() => ({ embeddingModel: 'mock-1', dimensions: 16 })),
		encryptConfig: (s: string) => s,
		decryptConfig: (s: string) => s,
		resolveConnector: vi.fn(() => connector),
		onAudit: vi.fn(),
		...overrides,
	};
}

async function runSync(captured: CapturedApp, sourceId: string): Promise<FakeResponse> {
	const handler = captured.getSyncHandler();
	const req = makeReq(sourceId);
	const res = makeRes();
	await handler(req, res.res);
	return res;
}

function readJob(db: BetterSqlite3Database, sourceId: string): RagJob {
	const row = db
		.prepare(
			`SELECT * FROM rag_jobs WHERE source_id = ? ORDER BY started_at DESC LIMIT 1`,
		)
		.get(sourceId) as Record<string, unknown>;
	return {
		id: row['id'] as string,
		sourceId: row['source_id'] as string,
		status: row['status'] as RagJob['status'],
		progress: row['progress'] as number,
		totalDocuments: row['total_documents'] as number,
		processedDocuments: row['processed_documents'] as number,
		skippedByEtag: row['skipped_by_etag'] as number,
		gcDeleted: row['gc_deleted'] as number,
		error: row['error'] as string | null,
		startedAt: row['started_at'] as string,
		finishedAt: row['finished_at'] as string | null,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerRagIndexRoutes — incremental sync (etag fast-path + GC)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('skips fetch + ingest when every doc has a matching etag', async () => {
		const db = makeDb();
		const source = insertSource(db);
		preseedDocument(db, source.id, { path: 'a.txt', etag: 'etag-a' });
		preseedDocument(db, source.id, { path: 'b.txt', etag: 'etag-b' });

		const connector = makeConnector([
			{ id: 'doc-a', path: 'a.txt', etag: 'etag-a' },
			{ id: 'doc-b', path: 'b.txt', etag: 'etag-b' },
		]);
		const pipeline = makePipelineMock();
		const captured = makeCapturedApp();
		registerRagIndexRoutes(captured.app, makeDeps(db, connector, pipeline));

		const res = await runSync(captured, source.id);

		expect(res.statusCode).toBe(200);
		expect(connector.fetchDocument).not.toHaveBeenCalled();
		expect(pipeline.ingestDocument).not.toHaveBeenCalled();
		const job = readJob(db, source.id);
		expect(job.status).toBe('completed');
		expect(job.totalDocuments).toBe(2);
		expect(job.processedDocuments).toBe(2);
		expect(job.skippedByEtag).toBe(2);
		expect(job.gcDeleted).toBe(0);
	});

	it('fetches + re-ingests when a doc has a different etag', async () => {
		const db = makeDb();
		const source = insertSource(db);
		preseedDocument(db, source.id, { path: 'a.txt', etag: 'etag-old' });

		const connector = makeConnector([{ id: 'doc-a', path: 'a.txt', etag: 'etag-new' }]);
		const pipeline = makePipelineMock();
		const captured = makeCapturedApp();
		registerRagIndexRoutes(captured.app, makeDeps(db, connector, pipeline));

		await runSync(captured, source.id);

		expect(connector.fetchDocument).toHaveBeenCalledTimes(1);
		expect(pipeline.ingestDocument).toHaveBeenCalledTimes(1);
		const job = readJob(db, source.id);
		expect(job.skippedByEtag).toBe(0);
		expect(job.processedDocuments).toBe(1);
	});

	it('falls through to fetch when the doc has no etag (null)', async () => {
		const db = makeDb();
		const source = insertSource(db);
		preseedDocument(db, source.id, { path: 'a.txt', etag: null });

		const connector = makeConnector([{ id: 'doc-a', path: 'a.txt', etag: null }]);
		const pipeline = makePipelineMock();
		const captured = makeCapturedApp();
		registerRagIndexRoutes(captured.app, makeDeps(db, connector, pipeline));

		await runSync(captured, source.id);

		expect(connector.fetchDocument).toHaveBeenCalledTimes(1);
		expect(pipeline.ingestDocument).toHaveBeenCalledTimes(1);
		const job = readJob(db, source.id);
		expect(job.skippedByEtag).toBe(0);
	});

	it('does not skip a soft-deleted row even when the etag matches', async () => {
		const db = makeDb();
		const source = insertSource(db);
		preseedDocument(db, source.id, { path: 'a.txt', etag: 'etag-a', deleted: true });

		const connector = makeConnector([{ id: 'doc-a', path: 'a.txt', etag: 'etag-a' }]);
		const pipeline = makePipelineMock();
		const captured = makeCapturedApp();
		registerRagIndexRoutes(captured.app, makeDeps(db, connector, pipeline));

		await runSync(captured, source.id);

		// The connector listing reports the file again — a soft-deleted row must
		// be re-ingested, not silently skipped.
		expect(connector.fetchDocument).toHaveBeenCalledTimes(1);
		expect(pipeline.ingestDocument).toHaveBeenCalledTimes(1);
		const job = readJob(db, source.id);
		expect(job.skippedByEtag).toBe(0);
		// The soft-deleted row's path IS in the connector listing, so it must
		// NOT be GC'd.
		expect(job.gcDeleted).toBe(0);
	});

	it('GC: marks documents removed from the source as deleted', async () => {
		const db = makeDb();
		const source = insertSource(db);
		const keepId = preseedDocument(db, source.id, { path: 'keep.txt', etag: 'etag-k' });
		const goneId = preseedDocument(db, source.id, { path: 'gone.txt', etag: 'etag-g' });

		// The connector only reports keep.txt — gone.txt has been removed.
		const connector = makeConnector([{ id: 'doc-keep', path: 'keep.txt', etag: 'etag-k' }]);
		const pipeline = makePipelineMock();
		const captured = makeCapturedApp();
		registerRagIndexRoutes(captured.app, makeDeps(db, connector, pipeline));

		await runSync(captured, source.id);

		expect(pipeline.markDocumentDeleted).toHaveBeenCalledTimes(1);
		expect(pipeline.markDocumentDeleted).toHaveBeenCalledWith(goneId);
		// Sanity: keepId was NOT marked deleted.
		expect(pipeline.markDocumentDeleted).not.toHaveBeenCalledWith(keepId);
		const job = readJob(db, source.id);
		expect(job.gcDeleted).toBe(1);
		expect(job.skippedByEtag).toBe(1); // keep.txt skipped via etag
	});

	it('persists skippedByEtag and gcDeleted on the final job row and audit payload', async () => {
		const db = makeDb();
		const source = insertSource(db);
		preseedDocument(db, source.id, { path: 'keep.txt', etag: 'etag-k' });
		preseedDocument(db, source.id, { path: 'gone.txt', etag: 'etag-g' });
		preseedDocument(db, source.id, { path: 'updated.txt', etag: 'etag-old' });

		const connector = makeConnector([
			{ id: 'doc-keep', path: 'keep.txt', etag: 'etag-k' }, // skip
			{ id: 'doc-updated', path: 'updated.txt', etag: 'etag-new' }, // re-ingest
			// 'gone.txt' missing — should be GC'd
		]);
		const pipeline = makePipelineMock();
		const onAudit = vi.fn();
		const captured = makeCapturedApp();
		registerRagIndexRoutes(
			captured.app,
			makeDeps(db, connector, pipeline, { onAudit }),
		);

		await runSync(captured, source.id);

		const job = readJob(db, source.id);
		expect(job.status).toBe('completed');
		expect(job.totalDocuments).toBe(2); // entries from connector
		expect(job.processedDocuments).toBe(2);
		expect(job.skippedByEtag).toBe(1);
		expect(job.gcDeleted).toBe(1);
		expect(job.progress).toBe(1);

		// The completion audit must include the new counters.
		const completedCalls = onAudit.mock.calls.filter(
			(c) => (c[0] as { type: string }).type === 'rag.sync.completed',
		);
		expect(completedCalls).toHaveLength(1);
		const payload = (completedCalls[0]![0] as { payload: Record<string, unknown> }).payload;
		expect(payload).toMatchObject({
			sourceId: source.id,
			total: 2,
			processed: 2,
			skippedByEtag: 1,
			gcDeleted: 1,
			failures: 0,
		});
	});
});
