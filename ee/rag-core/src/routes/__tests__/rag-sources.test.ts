// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Express, Request, Response } from 'express';

import { runRagMigrations } from '../../storage/schema.js';
import { registerRagSourcesRoutes } from '../rag-sources.js';
import { SyncQueue } from '../../jobs/sync-queue.js';
import { PollScheduler } from '../../jobs/poll-scheduler.js';
import { WatchManager } from '../../jobs/watch-manager.js';
import type { RagRouteDeps } from '../types.js';

// ---------------------------------------------------------------------------
// Test harness — capture handlers from a fake Express app so we can drive
// them directly without an HTTP server.
// ---------------------------------------------------------------------------

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

interface CapturedApp {
	app: Express;
	get(path: string): RouteHandler;
	post(path: string): RouteHandler;
	patch(path: string): RouteHandler;
	delete(path: string): RouteHandler;
}

function makeCapturedApp(): CapturedApp {
	const handlers: Record<string, Record<string, RouteHandler>> = {
		get: {},
		post: {},
		patch: {},
		delete: {},
	};
	const app = {
		get: vi.fn((path: string, h: RouteHandler) => {
			handlers['get']![path] = h;
		}),
		post: vi.fn((path: string, h: RouteHandler) => {
			handlers['post']![path] = h;
		}),
		patch: vi.fn((path: string, h: RouteHandler) => {
			handlers['patch']![path] = h;
		}),
		delete: vi.fn((path: string, h: RouteHandler) => {
			handlers['delete']![path] = h;
		}),
	} as unknown as Express;

	const lookup = (verb: string) => (path: string): RouteHandler => {
		const h = handlers[verb]?.[path];
		if (!h) throw new Error(`no ${verb} handler registered for ${path}`);
		return h;
	};

	return {
		app,
		get: lookup('get'),
		post: lookup('post'),
		patch: lookup('patch'),
		delete: lookup('delete'),
	};
}

interface FakeResponse {
	statusCode: number;
	body: unknown;
	res: Response;
}

function makeRes(): FakeResponse {
	const r: FakeResponse = { statusCode: 200, body: undefined, res: {} as Response };
	(r.res as unknown as { status: (s: number) => Response }).status = (s: number) => {
		r.statusCode = s;
		return r.res;
	};
	(r.res as unknown as { json: (b: unknown) => Response }).json = (b: unknown) => {
		r.body = b;
		return r.res;
	};
	return r;
}

function makeReq(opts: { params?: Record<string, string>; body?: unknown }): Request {
	return {
		params: opts.params ?? {},
		body: opts.body ?? {},
		query: {},
	} as unknown as Request;
}

function makeDb(): BetterSqlite3Database {
	const db = new Database(':memory:');
	runRagMigrations({ raw: db });
	return db;
}

interface DepsBuild {
	deps: RagRouteDeps;
	pollScheduler: PollScheduler;
	watchManager: WatchManager;
	upsertSpy: ReturnType<typeof vi.spyOn>;
	removeSpy: ReturnType<typeof vi.spyOn>;
	watchUpsertSpy: ReturnType<typeof vi.spyOn>;
	watchRemoveSpy: ReturnType<typeof vi.spyOn>;
}

function makeDeps(db: BetterSqlite3Database): DepsBuild {
	const pollScheduler = new PollScheduler({
		db,
		triggerSync: () => null,
	});
	// Spy on the methods the route should call. We don't need to override
	// them — we just want to assert the calls.
	const upsertSpy = vi.spyOn(pollScheduler, 'upsert');
	const removeSpy = vi.spyOn(pollScheduler, 'remove');

	const watchManager = new WatchManager({
		db,
		resolveConnector: () => null,
		decryptConfig: (s2) => s2,
		triggerSync: () => null,
	});
	const watchUpsertSpy = vi.spyOn(watchManager, 'upsert');
	const watchRemoveSpy = vi.spyOn(watchManager, 'remove');

	const syncQueue = new SyncQueue({
		runJob: async () => undefined,
	});

	const deps: RagRouteDeps = {
		db,
		pipeline: {} as RagRouteDeps['pipeline'],
		vectorStore: {
			upsert: vi.fn(),
			search: vi.fn(() => []),
			delete: vi.fn(),
			deleteByDocument: vi.fn(),
		},
		resolveEmbeddingClient: vi.fn(),
		resolveEmbeddingSetting: vi.fn(() => ({ embeddingModel: 'mock-1', dimensions: 16 })),
		encryptConfig: (s: string) => s,
		decryptConfig: (s: string) => s,
		// No connector — bypasses the testConnection check at create time.
		resolveConnector: vi.fn(() => null),
		syncQueue,
		pollScheduler,
		watchManager,
		onAudit: vi.fn(),
	};

	return { deps, pollScheduler, watchManager, upsertSpy, removeSpy, watchUpsertSpy, watchRemoveSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerRagSourcesRoutes — polling integration', () => {
	let db: BetterSqlite3Database;
	let captured: CapturedApp;
	let build: DepsBuild;

	beforeEach(() => {
		db = makeDb();
		captured = makeCapturedApp();
		build = makeDeps(db);
		registerRagSourcesRoutes(captured.app, build.deps);
	});

	it('POST source with pollingIntervalSeconds calls pollScheduler.upsert', async () => {
		const handler = captured.post('/api/rag/sources');
		const req = makeReq({
			body: {
				name: 'Polled source',
				type: 'local',
				config: { rootPath: '/tmp/x' },
				embeddingSettingName: 'test',
				pollingIntervalSeconds: 900,
			},
		});
		const res = makeRes();
		await handler(req, res.res);

		expect(res.statusCode).toBe(201);
		expect(build.upsertSpy).toHaveBeenCalledTimes(1);
		const [sourceId, interval] = build.upsertSpy.mock.calls[0]!;
		expect(typeof sourceId).toBe('string');
		expect(interval).toBe(900);

		// Persisted column must match.
		const row = db
			.prepare('SELECT polling_interval_seconds FROM rag_sources WHERE id = ?')
			.get(sourceId) as { polling_interval_seconds: number };
		expect(row.polling_interval_seconds).toBe(900);
	});

	it('POST source without polling does NOT call upsert', async () => {
		const handler = captured.post('/api/rag/sources');
		const req = makeReq({
			body: {
				name: 'Manual source',
				type: 'local',
				config: { rootPath: '/tmp/x' },
				embeddingSettingName: 'test',
				// pollingIntervalSeconds omitted → null in DB, no scheduler call.
			},
		});
		const res = makeRes();
		await handler(req, res.res);

		expect(res.statusCode).toBe(201);
		expect(build.upsertSpy).not.toHaveBeenCalled();
	});

	it('POST rejects pollingIntervalSeconds below 60s', async () => {
		const handler = captured.post('/api/rag/sources');
		const req = makeReq({
			body: {
				name: 'Too fast',
				type: 'local',
				config: { rootPath: '/tmp/x' },
				embeddingSettingName: 'test',
				pollingIntervalSeconds: 30, // below min
			},
		});
		const res = makeRes();
		await handler(req, res.res);

		expect(res.statusCode).toBe(400);
		expect(build.upsertSpy).not.toHaveBeenCalled();
	});

	it('POST rejects pollingIntervalSeconds above 86400s', async () => {
		const handler = captured.post('/api/rag/sources');
		const req = makeReq({
			body: {
				name: 'Too slow',
				type: 'local',
				config: { rootPath: '/tmp/x' },
				embeddingSettingName: 'test',
				pollingIntervalSeconds: 86_401, // above max
			},
		});
		const res = makeRes();
		await handler(req, res.res);

		expect(res.statusCode).toBe(400);
		expect(build.upsertSpy).not.toHaveBeenCalled();
	});

	it('PATCH that changes pollingIntervalSeconds calls upsert with the new value', async () => {
		// Seed a polled source.
		const createRes = makeRes();
		await captured.post('/api/rag/sources')(
			makeReq({
				body: {
					name: 'Source A',
					type: 'local',
					config: { rootPath: '/tmp/x' },
					embeddingSettingName: 'test',
					pollingIntervalSeconds: 300,
				},
			}),
			createRes.res,
		);
		expect(createRes.statusCode).toBe(201);
		const created = (createRes.body as { source: { id: string } }).source;

		build.upsertSpy.mockClear();

		// PATCH with a new interval.
		const patchRes = makeRes();
		await captured.patch('/api/rag/sources/:id')(
			makeReq({ params: { id: created.id }, body: { pollingIntervalSeconds: 3600 } }),
			patchRes.res,
		);

		expect(patchRes.statusCode).toBe(200);
		expect(build.upsertSpy).toHaveBeenCalledTimes(1);
		expect(build.upsertSpy.mock.calls[0]).toEqual([created.id, 3600]);
	});

	it('PATCH that disables polling (null) calls upsert with null', async () => {
		const createRes = makeRes();
		await captured.post('/api/rag/sources')(
			makeReq({
				body: {
					name: 'Source A',
					type: 'local',
					config: { rootPath: '/tmp/x' },
					embeddingSettingName: 'test',
					pollingIntervalSeconds: 300,
				},
			}),
			createRes.res,
		);
		const created = (createRes.body as { source: { id: string } }).source;
		build.upsertSpy.mockClear();

		const patchRes = makeRes();
		await captured.patch('/api/rag/sources/:id')(
			makeReq({ params: { id: created.id }, body: { pollingIntervalSeconds: null } }),
			patchRes.res,
		);

		expect(patchRes.statusCode).toBe(200);
		expect(build.upsertSpy).toHaveBeenCalledTimes(1);
		expect(build.upsertSpy.mock.calls[0]).toEqual([created.id, null]);
	});

	it('PATCH without pollingIntervalSeconds does NOT call upsert', async () => {
		const createRes = makeRes();
		await captured.post('/api/rag/sources')(
			makeReq({
				body: {
					name: 'Source A',
					type: 'local',
					config: { rootPath: '/tmp/x' },
					embeddingSettingName: 'test',
					pollingIntervalSeconds: 300,
				},
			}),
			createRes.res,
		);
		const created = (createRes.body as { source: { id: string } }).source;
		build.upsertSpy.mockClear();

		// PATCH only the name → polling field is NOT in the body, so the
		// scheduler is left alone (avoids resetting an active timer).
		const patchRes = makeRes();
		await captured.patch('/api/rag/sources/:id')(
			makeReq({ params: { id: created.id }, body: { name: 'Renamed' } }),
			patchRes.res,
		);

		expect(patchRes.statusCode).toBe(200);
		expect(build.upsertSpy).not.toHaveBeenCalled();
	});

	it('DELETE source calls pollScheduler.remove', async () => {
		const createRes = makeRes();
		await captured.post('/api/rag/sources')(
			makeReq({
				body: {
					name: 'Source A',
					type: 'local',
					config: { rootPath: '/tmp/x' },
					embeddingSettingName: 'test',
					pollingIntervalSeconds: 300,
				},
			}),
			createRes.res,
		);
		const created = (createRes.body as { source: { id: string } }).source;

		const delRes = makeRes();
		await captured.delete('/api/rag/sources/:id')(
			makeReq({ params: { id: created.id } }),
			delRes.res,
		);

		expect(delRes.statusCode).toBe(200);
		expect(build.removeSpy).toHaveBeenCalledTimes(1);
		expect(build.removeSpy.mock.calls[0]).toEqual([created.id]);
	});

	it('GET source includes pollingIntervalSeconds in the response', async () => {
		const createRes = makeRes();
		await captured.post('/api/rag/sources')(
			makeReq({
				body: {
					name: 'Source A',
					type: 'local',
					config: { rootPath: '/tmp/x' },
					embeddingSettingName: 'test',
					pollingIntervalSeconds: 1800,
				},
			}),
			createRes.res,
		);
		const created = (createRes.body as { source: { id: string } }).source;

		const getRes = makeRes();
		await captured.get('/api/rag/sources/:id')(
			makeReq({ params: { id: created.id } }),
			getRes.res,
		);
		expect(getRes.statusCode).toBe(200);
		const body = getRes.body as { source: { pollingIntervalSeconds: number | null } };
		expect(body.source.pollingIntervalSeconds).toBe(1800);
	});

	it('GET source without polling returns pollingIntervalSeconds: null', async () => {
		const createRes = makeRes();
		await captured.post('/api/rag/sources')(
			makeReq({
				body: {
					name: 'Manual source',
					type: 'local',
					config: { rootPath: '/tmp/x' },
					embeddingSettingName: 'test',
				},
			}),
			createRes.res,
		);
		const created = (createRes.body as { source: { id: string } }).source;

		const getRes = makeRes();
		await captured.get('/api/rag/sources/:id')(
			makeReq({ params: { id: created.id } }),
			getRes.res,
		);
		expect(getRes.statusCode).toBe(200);
		const body = getRes.body as { source: { pollingIntervalSeconds: number | null } };
		expect(body.source.pollingIntervalSeconds).toBeNull();
	});
});

describe('schema migration — v4 idempotence', () => {
	it('runRagMigrations is safe to call twice', () => {
		const db = makeDb();
		// First call already happened in makeDb. Run it again — must not throw.
		expect(() => runRagMigrations({ raw: db })).not.toThrow();
		// And the column is present after both runs.
		const cols = db.pragma('table_info(rag_sources)') as Array<{ name: string }>;
		expect(cols.some((c) => c.name === 'polling_interval_seconds')).toBe(true);
	});

	it('upgrade path — v3 DB without the column gets it added by v4', () => {
		const db = new Database(':memory:');
		// Create a v3-shape rag_sources (no polling_interval_seconds) and stamp
		// the version table accordingly. Then re-run runRagMigrations and
		// confirm the column is added.
		db.exec(`CREATE TABLE rag_sources (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			type TEXT NOT NULL,
			config_encrypted TEXT NOT NULL,
			embedding_setting_name TEXT NOT NULL,
			embedding_model_version TEXT NOT NULL,
			embedding_dimensions INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_sync_at TEXT
		);`);
		db.exec(`CREATE TABLE rag_schema_version (key TEXT PRIMARY KEY, version INTEGER NOT NULL);`);
		db.prepare(`INSERT INTO rag_schema_version (key, version) VALUES ('rag', 3)`).run();

		// Pre-condition: column missing.
		let cols = db.pragma('table_info(rag_sources)') as Array<{ name: string }>;
		expect(cols.some((c) => c.name === 'polling_interval_seconds')).toBe(false);

		runRagMigrations({ raw: db });

		// Post-condition: column present, version bumped to the current head.
		cols = db.pragma('table_info(rag_sources)') as Array<{ name: string }>;
		expect(cols.some((c) => c.name === 'polling_interval_seconds')).toBe(true);
		const ver = db
			.prepare(`SELECT version FROM rag_schema_version WHERE key = 'rag'`)
			.get() as { version: number };
		// v5 added the FTS5 mirror, v6 added tenant_id — the migration is
		// no-op on this fixture's tables that aren't seeded, but the version
		// still advances to head (6).
		expect(ver.version).toBe(6);
	});
});

describe('schema migration — v6 tenant_id', () => {
	function hasIndex(db: BetterSqlite3Database, name: string): boolean {
		const row = db
			.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name = ?`)
			.get(name) as { name: string } | undefined;
		return row !== undefined;
	}

	it('adds tenant_id column to every RAG table on a fresh DB', () => {
		const db = makeDb();
		const tables = ['rag_sources', 'rag_folders', 'rag_documents', 'rag_chunks', 'rag_jobs'];
		for (const t of tables) {
			const cols = db.pragma(`table_info(${t})`) as Array<{ name: string }>;
			expect(cols.some((c) => c.name === 'tenant_id')).toBe(true);
		}
	});

	it('creates the per-table tenant indexes', () => {
		const db = makeDb();
		const expected = [
			'idx_rag_sources_tenant',
			'idx_rag_folders_tenant',
			'idx_rag_documents_tenant',
			'idx_rag_chunks_tenant',
			'idx_rag_jobs_tenant',
		];
		for (const name of expected) {
			expect(hasIndex(db, name)).toBe(true);
		}
	});

	it('upgrade path — v5 DB without the column gets it added by v6, existing rows default to "default"', () => {
		const db = new Database(':memory:');
		// Build a v5-shape DB by hand: every RAG table with the v5 column
		// set (no tenant_id yet) plus the version stamp.
		db.exec(`
			CREATE TABLE rag_sources (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				type TEXT NOT NULL,
				config_encrypted TEXT NOT NULL,
				embedding_setting_name TEXT NOT NULL,
				embedding_model_version TEXT NOT NULL,
				embedding_dimensions INTEGER NOT NULL DEFAULT 0,
				polling_interval_seconds INTEGER,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now')),
				last_sync_at TEXT
			);
			CREATE TABLE rag_folders (
				id TEXT PRIMARY KEY,
				source_id TEXT NOT NULL,
				parent_id TEXT,
				path TEXT NOT NULL,
				name TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE rag_documents (
				id TEXT PRIMARY KEY,
				source_id TEXT NOT NULL,
				folder_id TEXT,
				path TEXT NOT NULL,
				name TEXT NOT NULL,
				mime_type TEXT NOT NULL,
				size INTEGER NOT NULL,
				hash TEXT NOT NULL,
				etag TEXT,
				last_indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
				deleted_at TEXT
			);
			CREATE TABLE rag_chunks (
				id TEXT PRIMARY KEY,
				document_id TEXT NOT NULL,
				position INTEGER NOT NULL,
				text TEXT NOT NULL,
				token_count INTEGER NOT NULL,
				embedding_dimensions INTEGER NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE rag_jobs (
				id TEXT PRIMARY KEY,
				source_id TEXT NOT NULL,
				status TEXT NOT NULL,
				progress REAL NOT NULL DEFAULT 0,
				total_documents INTEGER NOT NULL DEFAULT 0,
				processed_documents INTEGER NOT NULL DEFAULT 0,
				skipped_by_etag INTEGER NOT NULL DEFAULT 0,
				gc_deleted INTEGER NOT NULL DEFAULT 0,
				error TEXT,
				started_at TEXT NOT NULL DEFAULT (datetime('now')),
				finished_at TEXT
			);
			CREATE TABLE rag_schema_version (key TEXT PRIMARY KEY, version INTEGER NOT NULL);
			INSERT INTO rag_schema_version (key, version) VALUES ('rag', 5);
			INSERT INTO rag_sources (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version)
				VALUES ('s-legacy', 'legacy', 'local', '{}', 'test', 'mock-1');
		`);

		// Pre-condition: tenant_id column absent on every table.
		const tables = ['rag_sources', 'rag_folders', 'rag_documents', 'rag_chunks', 'rag_jobs'];
		for (const t of tables) {
			const cols = db.pragma(`table_info(${t})`) as Array<{ name: string }>;
			expect(cols.some((c) => c.name === 'tenant_id')).toBe(false);
		}

		runRagMigrations({ raw: db });

		// Post-condition: tenant_id column present everywhere; legacy row
		// inherits the literal default.
		for (const t of tables) {
			const cols = db.pragma(`table_info(${t})`) as Array<{ name: string }>;
			expect(cols.some((c) => c.name === 'tenant_id')).toBe(true);
		}
		const legacy = db
			.prepare(`SELECT tenant_id FROM rag_sources WHERE id = ?`)
			.get('s-legacy') as { tenant_id: string };
		expect(legacy.tenant_id).toBe('default');

		// Version stamp updated to head.
		const ver = db
			.prepare(`SELECT version FROM rag_schema_version WHERE key = 'rag'`)
			.get() as { version: number };
		expect(ver.version).toBe(6);
	});

	it('is idempotent — re-running runRagMigrations does not duplicate the column or throw', () => {
		const db = makeDb();
		// Already migrated once in makeDb. Run twice more and confirm a
		// single tenant_id column per table.
		runRagMigrations({ raw: db });
		runRagMigrations({ raw: db });

		const tables = ['rag_sources', 'rag_folders', 'rag_documents', 'rag_chunks', 'rag_jobs'];
		for (const t of tables) {
			const cols = db.pragma(`table_info(${t})`) as Array<{ name: string }>;
			expect(cols.filter((c) => c.name === 'tenant_id')).toHaveLength(1);
		}
	});

	it('fresh POST /api/rag/sources writes tenant_id = "default" on the row (backward-compat)', async () => {
		const db = makeDb();
		const captured = makeCapturedApp();
		const build = makeDeps(db);
		registerRagSourcesRoutes(captured.app, build.deps);

		const handler = captured.post('/api/rag/sources');
		const req = makeReq({
			body: {
				name: 'TenantA source',
				type: 'local',
				config: { rootPath: '/tmp/x' },
				embeddingSettingName: 'test',
			},
		});
		const res = makeRes();
		await handler(req, res.res);
		expect(res.statusCode).toBe(201);

		const body = res.body as { source: { id: string; tenantId: string } };
		expect(body.source.tenantId).toBe('default');

		const row = db
			.prepare(`SELECT tenant_id FROM rag_sources WHERE id = ?`)
			.get(body.source.id) as { tenant_id: string };
		expect(row.tenant_id).toBe('default');
	});
});

describe('registerRagSourcesRoutes — watch integration', () => {
	let db: BetterSqlite3Database;
	let captured: CapturedApp;
	let build: DepsBuild;

	beforeEach(() => {
		db = makeDb();
		captured = makeCapturedApp();
		build = makeDeps(db);
		registerRagSourcesRoutes(captured.app, build.deps);
	});

	it('POST a local source calls watchManager.upsert with the persisted row', async () => {
		const handler = captured.post('/api/rag/sources');
		const req = makeReq({
			body: {
				name: 'Watched local',
				type: 'local',
				config: { rootPath: '/tmp/x' },
				embeddingSettingName: 'test',
			},
		});
		const res = makeRes();
		await handler(req, res.res);

		expect(res.statusCode).toBe(201);
		expect(build.watchUpsertSpy).toHaveBeenCalledTimes(1);
		const arg = build.watchUpsertSpy.mock.calls[0]![0] as {
			id: string;
			type: string;
			configEncrypted: string;
		};
		expect(arg.type).toBe('local');
		expect(typeof arg.id).toBe('string');
		expect(typeof arg.configEncrypted).toBe('string');
	});

	it('PATCH that changes config calls watchManager.upsert', async () => {
		// Seed.
		const createRes = makeRes();
		await captured.post('/api/rag/sources')(
			makeReq({
				body: {
					name: 'Source',
					type: 'local',
					config: { rootPath: '/tmp/a' },
					embeddingSettingName: 'test',
				},
			}),
			createRes.res,
		);
		const created = (createRes.body as { source: { id: string } }).source;
		build.watchUpsertSpy.mockClear();

		const patchRes = makeRes();
		await captured.patch('/api/rag/sources/:id')(
			makeReq({
				params: { id: created.id },
				body: { config: { rootPath: '/tmp/b' } },
			}),
			patchRes.res,
		);

		expect(patchRes.statusCode).toBe(200);
		expect(build.watchUpsertSpy).toHaveBeenCalledTimes(1);
	});

	it('PATCH that only changes the name does NOT call watchManager.upsert', async () => {
		const createRes = makeRes();
		await captured.post('/api/rag/sources')(
			makeReq({
				body: {
					name: 'Source',
					type: 'local',
					config: { rootPath: '/tmp/a' },
					embeddingSettingName: 'test',
				},
			}),
			createRes.res,
		);
		const created = (createRes.body as { source: { id: string } }).source;
		build.watchUpsertSpy.mockClear();

		const patchRes = makeRes();
		await captured.patch('/api/rag/sources/:id')(
			makeReq({ params: { id: created.id }, body: { name: 'Renamed' } }),
			patchRes.res,
		);

		expect(patchRes.statusCode).toBe(200);
		expect(build.watchUpsertSpy).not.toHaveBeenCalled();
	});

	it('DELETE source calls watchManager.remove', async () => {
		const createRes = makeRes();
		await captured.post('/api/rag/sources')(
			makeReq({
				body: {
					name: 'Source',
					type: 'local',
					config: { rootPath: '/tmp/a' },
					embeddingSettingName: 'test',
				},
			}),
			createRes.res,
		);
		const created = (createRes.body as { source: { id: string } }).source;
		// Clear the spy: WatchManager.upsert internally calls .remove() to
		// tear down any prior watcher before re-registering, so the create
		// path already incremented the counter once. We only care about the
		// DELETE-driven call here.
		build.watchRemoveSpy.mockClear();

		const delRes = makeRes();
		await captured.delete('/api/rag/sources/:id')(
			makeReq({ params: { id: created.id } }),
			delRes.res,
		);

		expect(delRes.statusCode).toBe(200);
		expect(build.watchRemoveSpy).toHaveBeenCalledTimes(1);
		expect(build.watchRemoveSpy.mock.calls[0]).toEqual([created.id]);
	});
});

