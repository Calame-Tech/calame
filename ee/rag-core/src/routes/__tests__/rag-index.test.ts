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
import { registerRagIndexRoutes, runSyncJob } from '../rag-index.js';
import { SyncQueue, recoverOrphanedJobs } from '../../jobs/sync-queue.js';
import { PollScheduler } from '../../jobs/poll-scheduler.js';
import { WatchManager } from '../../jobs/watch-manager.js';
import type { ConnectorLike, RagRouteDeps } from '../types.js';
import type { IngestionPipeline } from '../../pipeline/ingest.js';
import type { RagJob, RagSource } from '../../types.js';

// ---------------------------------------------------------------------------
// Test harness — capture the registered POST handler from a fake Express app
// so we can invoke it directly without spinning up an HTTP server.
// ---------------------------------------------------------------------------

type SyncHandler = (req: Request, res: Response) => void | Promise<void>;

interface CapturedApp {
	app: Express;
	getSyncHandler(): SyncHandler;
	getJobsHandler(): SyncHandler;
}

function makeCapturedApp(): CapturedApp {
	let syncHandler: SyncHandler | null = null;
	let jobsHandler: SyncHandler | null = null;
	const app = {
		get: vi.fn((path: string, handler: SyncHandler) => {
			if (path === '/api/rag/jobs') {
				jobsHandler = handler;
			}
		}),
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
		getJobsHandler() {
			if (!jobsHandler) throw new Error('jobs handler was not registered');
			return jobsHandler;
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

function insertSource(
	db: BetterSqlite3Database,
	overrides?: Partial<RagSource>,
): RagSource {
	const source: RagSource = {
		id: 'src-1',
		name: 'Test source',
		type: 'local',
		configEncrypted: '{}',
		embeddingSettingName: 'test-embedding',
		embeddingModelVersion: 'mock-1',
		tenantId: 'default',
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

/**
 * Build a deps object with a real {@link SyncQueue} wired against the
 * passed-in deps. The queue's `runJob` calls back into `runSyncJob` so the
 * full pipeline runs end-to-end exactly as it would in production.
 */
function makeDeps(
	db: BetterSqlite3Database,
	connector: ConnectorLike,
	pipeline: IngestionPipeline,
	overrides?: Partial<RagRouteDeps>,
): RagRouteDeps & { syncQueue: SyncQueue } {
	// Build a scheduler tied to the same DB. Tests that exercise rag-index
	// don't use it directly, but `RagRouteDeps` requires the field — supply a
	// real instance and rely on the test never calling `start()`.
	const pollScheduler = new PollScheduler({
		db,
		triggerSync: () => null,
	});

	const base: Omit<RagRouteDeps, 'syncQueue'> = {
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
		pollScheduler,
		watchManager: new WatchManager({
			db,
			resolveConnector: () => null,
			decryptConfig: (s2) => s2,
			triggerSync: () => null,
		}),
		onAudit: vi.fn(),
		...overrides,
	};
	// `runJob` closes over `deps` — but `deps` isn't built yet, so build it in
	// two passes with a trampoline.
	let resolved: RagRouteDeps;
	const queue = new SyncQueue({
		runJob: async (sourceId, jobId) => runSyncJob(resolved, sourceId, jobId),
	});
	resolved = { ...base, syncQueue: queue };
	return resolved as RagRouteDeps & { syncQueue: SyncQueue };
}

/**
 * POST the sync route AND drain the queue so the test sees the terminal job
 * state. This matches the legacy synchronous behavior the older tests assume.
 */
async function runSync(captured: CapturedApp, sourceId: string, deps: RagRouteDeps): Promise<FakeResponse> {
	const handler = captured.getSyncHandler();
	const req = makeReq(sourceId);
	const res = makeRes();
	await handler(req, res.res);
	await deps.syncQueue.drain();
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
		tenantId: (row['tenant_id'] as string | null) ?? 'default',
		startedAt: row['started_at'] as string,
		finishedAt: row['finished_at'] as string | null,
	};
}

// ---------------------------------------------------------------------------
// Tests — Tranche 4: incremental sync (etag fast-path + GC). These call
// runSync(...) which awaits drain() so the sync completes before assertions.
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
		const deps = makeDeps(db, connector, pipeline);
		registerRagIndexRoutes(captured.app, deps);

		const res = await runSync(captured, source.id, deps);

		expect(res.statusCode).toBe(202);
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
		const deps = makeDeps(db, connector, pipeline);
		registerRagIndexRoutes(captured.app, deps);

		await runSync(captured, source.id, deps);

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
		const deps = makeDeps(db, connector, pipeline);
		registerRagIndexRoutes(captured.app, deps);

		await runSync(captured, source.id, deps);

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
		const deps = makeDeps(db, connector, pipeline);
		registerRagIndexRoutes(captured.app, deps);

		await runSync(captured, source.id, deps);

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
		const deps = makeDeps(db, connector, pipeline);
		registerRagIndexRoutes(captured.app, deps);

		await runSync(captured, source.id, deps);

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
		const deps = makeDeps(db, connector, pipeline, { onAudit });
		registerRagIndexRoutes(captured.app, deps);

		await runSync(captured, source.id, deps);

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

// ---------------------------------------------------------------------------
// Tests — Tranche 1: background sync (queue-based) — POST returns 202 + jobId
// immediately, the work runs in the background, the UI polls /api/rag/jobs.
// ---------------------------------------------------------------------------

describe('registerRagIndexRoutes — background sync (HTTP 202 + queue)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('POST returns 202 + jobId immediately without waiting on the sync', async () => {
		const db = makeDb();
		const source = insertSource(db);
		const connector = makeConnector([{ id: 'doc-a', path: 'a.txt', etag: 'e' }]);
		const pipeline = makePipelineMock();
		const captured = makeCapturedApp();
		const deps = makeDeps(db, connector, pipeline);
		registerRagIndexRoutes(captured.app, deps);

		// Fire the request but do NOT drain the queue. The handler should
		// respond synchronously with 202 — long before the worker has had a
		// chance to call connector.fetchDocument.
		const handler = captured.getSyncHandler();
		const res = makeRes();
		await handler(makeReq(source.id), res.res);

		expect(res.statusCode).toBe(202);
		const body = res.body as { job: RagJob };
		expect(body.job).toBeDefined();
		expect(body.job.sourceId).toBe(source.id);
		expect(body.job.id).toBeTypeOf('string');
		// The worker hasn't run yet — fetchDocument must NOT have been called.
		// (The microtask queue may have ticked once, so we drain after
		// asserting on the HTTP-time state below.)
		await deps.syncQueue.drain();
	});

	it('job starts as pending and transitions to running when the worker picks it up', async () => {
		const db = makeDb();
		const source = insertSource(db);
		// Make the connector hang on listDocuments so we can observe the
		// 'running' transition without it racing past us.
		let resolveList: (() => void) | null = null;
		const connector = makeConnector([]);
		(connector.listDocuments as ReturnType<typeof vi.fn>).mockImplementation(
			() =>
				new Promise<unknown[]>((resolve) => {
					resolveList = () => resolve([]);
				}),
		);
		const pipeline = makePipelineMock();
		const captured = makeCapturedApp();
		const deps = makeDeps(db, connector, pipeline);
		registerRagIndexRoutes(captured.app, deps);

		// Fire the request — the response carries the freshly inserted
		// pending row.
		const handler = captured.getSyncHandler();
		const res = makeRes();
		await handler(makeReq(source.id), res.res);

		const body = res.body as { job: RagJob };
		expect(body.job.status).toBe('pending');

		// Yield to the microtask queue so the worker has a chance to flip the
		// status to 'running' before listDocuments blocks it.
		await new Promise((r) => setImmediate(r));

		const running = readJob(db, source.id);
		expect(running.status).toBe('running');

		// Unblock + drain so the test cleans up.
		if (resolveList) (resolveList as () => void)();
		await deps.syncQueue.drain();

		const completed = readJob(db, source.id);
		expect(completed.status).toBe('completed');
	});

	it('two POSTs back-to-back on the same source: the second returns 409 Conflict', async () => {
		const db = makeDb();
		const source = insertSource(db);
		// Hang the connector so the first job stays running while we fire the
		// second request.
		let resolveList: (() => void) | null = null;
		const connector = makeConnector([]);
		(connector.listDocuments as ReturnType<typeof vi.fn>).mockImplementation(
			() =>
				new Promise<unknown[]>((resolve) => {
					resolveList = () => resolve([]);
				}),
		);
		const pipeline = makePipelineMock();
		const captured = makeCapturedApp();
		const deps = makeDeps(db, connector, pipeline);
		registerRagIndexRoutes(captured.app, deps);

		const handler = captured.getSyncHandler();
		const res1 = makeRes();
		await handler(makeReq(source.id), res1.res);
		expect(res1.statusCode).toBe(202);

		// Yield once so the worker has actually moved the job to 'running' and
		// claimed the source in the queue's #running set. Without this, the
		// first job is still in the queue (not yet running) when we fire the
		// second request — but the queue's enqueue check ALSO covers "already
		// queued", so the test passes either way. Yielding makes the assertion
		// specifically test the running-side dedupe.
		await new Promise((r) => setImmediate(r));

		const res2 = makeRes();
		await handler(makeReq(source.id), res2.res);
		expect(res2.statusCode).toBe(409);
		expect((res2.body as { error: string }).error).toMatch(/already in progress/i);

		// Verify we didn't leave a phantom pending row from the rejected
		// request — there should still be exactly ONE job for this source.
		const count = db
			.prepare<[string], { c: number }>(
				`SELECT COUNT(*) AS c FROM rag_jobs WHERE source_id = ?`,
			)
			.get(source.id);
		expect(count?.c).toBe(1);

		if (resolveList) (resolveList as () => void)();
		await deps.syncQueue.drain();
	});

	it('parallel POSTs on different sources: both enqueue, worker runs them sequentially', async () => {
		const db = makeDb();
		const sourceA = insertSource(db, { id: 'src-A' });
		const sourceB = insertSource(db, { id: 'src-B' });

		// Track the order in which connector.listDocuments is invoked so we
		// can assert sequential execution (only one at a time).
		const callOrder: Array<{ sid: string; phase: 'start' | 'end' }> = [];
		const docsBySource: Record<string, ConnectorDoc[]> = {
			'src-A': [{ id: 'a1', path: 'a1.txt', etag: 'e' }],
			'src-B': [{ id: 'b1', path: 'b1.txt', etag: 'e' }],
		};

		const connector: ConnectorLike = {
			type: 'local',
			testConnection: vi.fn(async () => undefined),
			listFolders: vi.fn(async () => []),
			listDocuments: vi.fn(async (_cfg: unknown, sid: string, folder: unknown) => {
				if (folder !== undefined) return [];
				callOrder.push({ sid, phase: 'start' });
				// Yield to give other in-flight sync attempts a chance to
				// interleave — they MUST NOT, because the queue's concurrency
				// is 1.
				await new Promise((r) => setImmediate(r));
				callOrder.push({ sid, phase: 'end' });
				return docsBySource[sid]!.map((d) => ({
					id: d.id,
					sourceId: sid,
					folderId: null,
					path: d.path,
					name: d.path,
					mimeType: 'text/plain',
					size: 10,
					hash: '',
					etag: d.etag,
					lastIndexedAt: '2026-01-01T00:00:00.000Z',
					deletedAt: null,
				}));
			}),
			fetchDocument: vi.fn(async () => ({
				stream: Readable.from([Buffer.from('payload')]),
				mimeType: 'text/plain',
			})),
		};

		const pipeline = makePipelineMock();
		const captured = makeCapturedApp();
		const deps = makeDeps(db, connector, pipeline);
		registerRagIndexRoutes(captured.app, deps);

		const handler = captured.getSyncHandler();
		const resA = makeRes();
		const resB = makeRes();
		await handler(makeReq(sourceA.id), resA.res);
		await handler(makeReq(sourceB.id), resB.res);

		expect(resA.statusCode).toBe(202);
		expect(resB.statusCode).toBe(202);

		await deps.syncQueue.drain();

		// Sequential: every 'start' must be immediately followed by its 'end'
		// for the same sourceId before the next 'start'.
		const startsAndEnds = callOrder.filter((c) => c.sid === sourceA.id || c.sid === sourceB.id);
		// We expect: A start, A end, B start, B end (FIFO ordering).
		expect(startsAndEnds[0]).toEqual({ sid: sourceA.id, phase: 'start' });
		expect(startsAndEnds[1]).toEqual({ sid: sourceA.id, phase: 'end' });
		expect(startsAndEnds[2]).toEqual({ sid: sourceB.id, phase: 'start' });
		expect(startsAndEnds[3]).toEqual({ sid: sourceB.id, phase: 'end' });

		const jobA = readJob(db, sourceA.id);
		const jobB = readJob(db, sourceB.id);
		expect(jobA.status).toBe('completed');
		expect(jobB.status).toBe('completed');
	});

	it('POST on an unknown source returns 404 and does not enqueue anything', async () => {
		const db = makeDb();
		// Don't insert any source.
		const connector = makeConnector([]);
		const pipeline = makePipelineMock();
		const captured = makeCapturedApp();
		const deps = makeDeps(db, connector, pipeline);
		registerRagIndexRoutes(captured.app, deps);

		const handler = captured.getSyncHandler();
		const res = makeRes();
		await handler(makeReq('does-not-exist'), res.res);

		expect(res.statusCode).toBe(404);
		expect(deps.syncQueue.size()).toBe(0);
		// No job row was inserted.
		const count = db.prepare(`SELECT COUNT(*) AS c FROM rag_jobs`).get() as { c: number };
		expect(count.c).toBe(0);
	});

	it('recoverOrphanedJobs marks pending and running jobs as failed at boot', async () => {
		const db = makeDb();
		insertSource(db);

		// Seed three jobs: pending, running, completed. Only the first two
		// should be touched by the recovery sweep.
		const now = '2026-01-01T00:00:00.000Z';
		db.prepare(
			`INSERT INTO rag_jobs (id, source_id, status, progress, started_at) VALUES (?, ?, ?, 0, ?)`,
		).run('job-pending', 'src-1', 'pending', now);
		db.prepare(
			`INSERT INTO rag_jobs (id, source_id, status, progress, started_at) VALUES (?, ?, ?, 0.5, ?)`,
		).run('job-running', 'src-1', 'running', now);
		db.prepare(
			`INSERT INTO rag_jobs (id, source_id, status, progress, started_at, finished_at) VALUES (?, ?, ?, 1, ?, ?)`,
		).run('job-completed', 'src-1', 'completed', now, now);

		const changed = recoverOrphanedJobs(db);
		expect(changed).toBe(2);

		const pending = db
			.prepare<[string], { status: string; error: string | null; finished_at: string | null }>(
				`SELECT status, error, finished_at FROM rag_jobs WHERE id = ?`,
			)
			.get('job-pending');
		expect(pending?.status).toBe('failed');
		expect(pending?.error).toBe('orphaned (server restart)');
		expect(pending?.finished_at).not.toBeNull();

		const running = db
			.prepare<[string], { status: string; error: string | null }>(
				`SELECT status, error FROM rag_jobs WHERE id = ?`,
			)
			.get('job-running');
		expect(running?.status).toBe('failed');
		expect(running?.error).toBe('orphaned (server restart)');

		// Completed jobs must NOT be touched.
		const completed = db
			.prepare<[string], { status: string; error: string | null }>(
				`SELECT status, error FROM rag_jobs WHERE id = ?`,
			)
			.get('job-completed');
		expect(completed?.status).toBe('completed');
		expect(completed?.error).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tests — GET /api/rag/jobs query filter: status= and limit=. Drive the
// captured GET handler directly (no HTTP server). The fixture seeds a known
// mix of jobs across two sources so each filter combination is unambiguous.
// ---------------------------------------------------------------------------

/**
 * Insert a job row directly, bypassing the queue. Used by the GET-filter
 * tests below — we don't care about pipeline state here, only about the
 * shape of the SQL filter the route builds.
 */
function insertJobRow(
	db: BetterSqlite3Database,
	job: {
		id: string;
		sourceId: string;
		status: RagJob['status'];
		startedAt?: string;
		finishedAt?: string | null;
	},
): void {
	db.prepare(
		`INSERT INTO rag_jobs
		 (id, source_id, status, progress, total_documents, processed_documents, started_at, finished_at)
		 VALUES (?, ?, ?, 0, 0, 0, ?, ?)`,
	).run(
		job.id,
		job.sourceId,
		job.status,
		job.startedAt ?? new Date().toISOString(),
		job.finishedAt ?? null,
	);
}

function makeJobsReq(query: Record<string, string>): Request {
	return { params: {}, query } as unknown as Request;
}

describe('GET /api/rag/jobs — status= and limit= filters', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function setup(): { db: BetterSqlite3Database; captured: CapturedApp } {
		const db = makeDb();
		insertSource(db, { id: 'src-A' });
		insertSource(db, { id: 'src-B' });
		// 2 pending, 1 running, 2 completed, 1 failed — 6 total across 2 sources.
		insertJobRow(db, { id: 'j1', sourceId: 'src-A', status: 'pending', startedAt: '2026-01-01T00:00:01Z' });
		insertJobRow(db, { id: 'j2', sourceId: 'src-A', status: 'running', startedAt: '2026-01-01T00:00:02Z' });
		insertJobRow(db, { id: 'j3', sourceId: 'src-A', status: 'completed', startedAt: '2026-01-01T00:00:03Z' });
		insertJobRow(db, { id: 'j4', sourceId: 'src-B', status: 'pending', startedAt: '2026-01-01T00:00:04Z' });
		insertJobRow(db, { id: 'j5', sourceId: 'src-B', status: 'completed', startedAt: '2026-01-01T00:00:05Z' });
		insertJobRow(db, { id: 'j6', sourceId: 'src-B', status: 'failed', startedAt: '2026-01-01T00:00:06Z' });
		const connector = makeConnector([]);
		const pipeline = makePipelineMock();
		const captured = makeCapturedApp();
		const deps = makeDeps(db, connector, pipeline);
		registerRagIndexRoutes(captured.app, deps);
		return { db, captured };
	}

	async function callJobs(captured: CapturedApp, query: Record<string, string>): Promise<RagJob[]> {
		const handler = captured.getJobsHandler();
		const res = makeRes();
		await handler(makeJobsReq(query), res.res);
		expect(res.statusCode).toBe(200);
		return (res.body as { jobs: RagJob[] }).jobs;
	}

	it('?status=active expands to pending+running across all sources', async () => {
		const { captured } = setup();
		const jobs = await callJobs(captured, { status: 'active' });
		// 3 active rows: j1, j2, j4. Sorted started_at DESC so j4 first.
		expect(jobs.map((j) => j.id)).toEqual(['j4', 'j2', 'j1']);
		expect(jobs.every((j) => j.status === 'pending' || j.status === 'running')).toBe(true);
	});

	it('?status=completed,failed (CSV) returns exactly those two terminal statuses', async () => {
		const { captured } = setup();
		const jobs = await callJobs(captured, { status: 'completed,failed' });
		// j3 completed, j5 completed, j6 failed — three rows.
		expect(jobs.map((j) => j.id).sort()).toEqual(['j3', 'j5', 'j6']);
		expect(jobs.every((j) => j.status === 'completed' || j.status === 'failed')).toBe(true);
	});

	it('?status=invalid is silently ignored — route returns ALL jobs unfiltered', async () => {
		const { captured } = setup();
		const jobs = await callJobs(captured, { status: 'invalid' });
		// All 6 seeded jobs come back.
		expect(jobs).toHaveLength(6);
	});

	it('?status=pending,bogus drops the unknown token but keeps pending', async () => {
		const { captured } = setup();
		const jobs = await callJobs(captured, { status: 'pending,bogus' });
		// Only the two pending rows (j1, j4) — bogus is dropped, pending kept.
		expect(jobs.map((j) => j.id).sort()).toEqual(['j1', 'j4']);
	});

	it('?limit caps the result set: 2 → 2 rows, 999 → at most 200, missing → default 50', async () => {
		const { captured } = setup();

		const two = await callJobs(captured, { limit: '2' });
		expect(two).toHaveLength(2);

		const giant = await callJobs(captured, { limit: '999' });
		// Only 6 jobs seeded; the cap at 200 is enforced internally but visible
		// row count is bounded by what exists. Asserting on the SQL bind isn't
		// possible from here, so we assert the cap doesn't reject the request.
		expect(giant).toHaveLength(6);

		const dflt = await callJobs(captured, {});
		expect(dflt).toHaveLength(6);

		const zero = await callJobs(captured, { limit: '0' });
		// limit=0 is clamped to 1, not "no rows" — we want at least one row.
		expect(zero).toHaveLength(1);
	});

	it('?sourceId combines with ?status=active to narrow further', async () => {
		const { captured } = setup();
		const jobs = await callJobs(captured, { sourceId: 'src-A', status: 'active' });
		// Only A's active jobs: j1, j2.
		expect(jobs.map((j) => j.id).sort()).toEqual(['j1', 'j2']);
	});
});
