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
	upsertSpy: ReturnType<typeof vi.spyOn>;
	removeSpy: ReturnType<typeof vi.spyOn>;
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
		onAudit: vi.fn(),
	};

	return { deps, pollScheduler, upsertSpy, removeSpy };
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

		// Post-condition: column present, version bumped.
		cols = db.pragma('table_info(rag_sources)') as Array<{ name: string }>;
		expect(cols.some((c) => c.name === 'polling_interval_seconds')).toBe(true);
		const ver = db
			.prepare(`SELECT version FROM rag_schema_version WHERE key = 'rag'`)
			.get() as { version: number };
		expect(ver.version).toBe(4);
	});
});
