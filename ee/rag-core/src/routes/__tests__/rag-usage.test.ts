// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { nanoid } from 'nanoid';

import { runRagMigrations } from '../../storage/schema.js';
import { registerRagUsageRoutes, type RagUsageResponse } from '../rag-usage.js';
import type { RagRouteDeps } from '../types.js';

// ---------------------------------------------------------------------------
// Test harness — capture the registered GET handler and drive it directly.
// ---------------------------------------------------------------------------

type Handler = (req: Request, res: Response) => void | Promise<void>;

function makeCapturedApp() {
	let handler: Handler | null = null;
	const app = {
		get: vi.fn((path: string, h: Handler) => {
			if (path === '/api/rag/usage') handler = h;
		}),
	} as unknown as Express;
	return {
		app,
		getUsage(): Handler {
			if (!handler) throw new Error('usage handler not registered');
			return handler;
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

function makeReq(query: Record<string, string> = {}): Request {
	return { params: {}, query } as unknown as Request;
}

function makeDb(): BetterSqlite3Database {
	const db = new Database(':memory:');
	runRagMigrations({ raw: db });
	return db;
}

function makeDeps(db: BetterSqlite3Database): RagRouteDeps {
	return {
		db,
		// Usage route only reads from `db`; the other deps are unused but the
		// type demands them. Supply minimal stubs.
		pipeline: {} as RagRouteDeps['pipeline'],
		vectorStore: {
			upsert: vi.fn(),
			search: vi.fn(() => []),
			delete: vi.fn(),
			deleteByDocument: vi.fn(),
		},
		resolveEmbeddingClient: vi.fn(),
		resolveEmbeddingSetting: vi.fn(() => ({ embeddingModel: 'mock', dimensions: 16 })),
		encryptConfig: (s: string) => s,
		decryptConfig: (s: string) => s,
		syncQueue: {
			enqueue: vi.fn(() => true),
			drain: vi.fn(async () => undefined),
		} as unknown as RagRouteDeps['syncQueue'],
		pollScheduler: {} as RagRouteDeps['pollScheduler'],
		watchManager: {} as RagRouteDeps['watchManager'],
		onAudit: vi.fn(),
	};
}

interface InsertSourceOpts {
	id?: string;
	name?: string;
	model?: string;
}

function insertSource(db: BetterSqlite3Database, opts: InsertSourceOpts = {}): string {
	const id = opts.id ?? nanoid();
	db.prepare(
		`INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version, embedding_dimensions, created_at, updated_at)
		 VALUES (?, ?, 'local', '{}', 'test', ?, 16, datetime('now'), datetime('now'))`,
	).run(id, opts.name ?? `Source ${id.slice(0, 4)}`, opts.model ?? 'text-embedding-3-small');
	return id;
}

interface InsertJobOpts {
	sourceId: string;
	tokens: number;
	startedAt?: string;
	status?: 'completed' | 'failed' | 'pending' | 'running';
}

function insertJob(db: BetterSqlite3Database, opts: InsertJobOpts): string {
	const id = nanoid();
	const startedAt = opts.startedAt ?? new Date().toISOString();
	db.prepare(
		`INSERT INTO rag_jobs
		 (id, source_id, status, progress, total_documents, processed_documents,
		  skipped_by_etag, gc_deleted, tokens_embedded, tenant_id, started_at, finished_at)
		 VALUES (?, ?, ?, 1, 1, 1, 0, 0, ?, 'default', ?, ?)`,
	).run(id, opts.sourceId, opts.status ?? 'completed', opts.tokens, startedAt, startedAt);
	return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerRagUsageRoutes', () => {
	let db: BetterSqlite3Database;
	let captured: ReturnType<typeof makeCapturedApp>;
	let deps: RagRouteDeps;

	beforeEach(() => {
		db = makeDb();
		captured = makeCapturedApp();
		deps = makeDeps(db);
		registerRagUsageRoutes(captured.app, deps);
	});

	it('returns zeros when no jobs exist', async () => {
		const handler = captured.getUsage();
		const res = makeRes();
		await handler(makeReq(), res.res);

		expect(res.statusCode).toBe(200);
		const body = res.body as RagUsageResponse;
		expect(body.totalTokens).toBe(0);
		expect(body.totalCostUsd).toBe(0);
		expect(body.perProvider).toEqual([]);
		expect(body.perSource).toEqual([]);
		expect(body.perDay).toEqual([]);
		expect(body.period).toBe('month');
	});

	it('aggregates multiple jobs on a single source', async () => {
		const srcId = insertSource(db, { name: 'Main', model: 'text-embedding-3-small' });
		insertJob(db, { sourceId: srcId, tokens: 100_000 });
		insertJob(db, { sourceId: srcId, tokens: 250_000 });
		insertJob(db, { sourceId: srcId, tokens: 50_000 });

		const handler = captured.getUsage();
		const res = makeRes();
		await handler(makeReq(), res.res);

		const body = res.body as RagUsageResponse;
		expect(body.totalTokens).toBe(400_000);
		// 400K tokens of text-embedding-3-small @ $0.02 / 1M = $0.008.
		expect(body.totalCostUsd).toBeCloseTo(0.008, 6);
		expect(body.perSource).toHaveLength(1);
		expect(body.perSource[0]).toMatchObject({
			sourceId: srcId,
			name: 'Main',
			tokens: 400_000,
		});
		expect(body.perProvider).toHaveLength(1);
		expect(body.perProvider[0]).toMatchObject({
			model: 'text-embedding-3-small',
			tokens: 400_000,
			known: true,
		});
	});

	it('splits totals across multiple sources and providers', async () => {
		const s1 = insertSource(db, { name: 'OpenAI src', model: 'text-embedding-3-small' });
		const s2 = insertSource(db, { name: 'Cohere src', model: 'embed-multilingual-v3.0' });
		insertJob(db, { sourceId: s1, tokens: 1_000_000 });
		insertJob(db, { sourceId: s2, tokens: 500_000 });

		const handler = captured.getUsage();
		const res = makeRes();
		await handler(makeReq(), res.res);

		const body = res.body as RagUsageResponse;
		expect(body.totalTokens).toBe(1_500_000);
		// 1M openai @ $0.02 + 500K cohere @ $0.10 = $0.02 + $0.05 = $0.07
		expect(body.totalCostUsd).toBeCloseTo(0.07, 6);
		// Sorted descending by tokens — openai (1M) before cohere (500K).
		expect(body.perProvider.map((p) => p.model)).toEqual([
			'text-embedding-3-small',
			'embed-multilingual-v3.0',
		]);
		expect(body.perSource.map((s) => s.name)).toEqual(['OpenAI src', 'Cohere src']);
	});

	it('filters with ?period=week (jobs older than 7 days excluded)', async () => {
		const srcId = insertSource(db, { name: 'Src', model: 'text-embedding-3-small' });
		// Inside the window (today).
		const recent = new Date().toISOString();
		insertJob(db, { sourceId: srcId, tokens: 1_000, startedAt: recent });
		// Outside the window (10 days ago).
		const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
		insertJob(db, { sourceId: srcId, tokens: 999_999, startedAt: old });

		const handler = captured.getUsage();
		const res = makeRes();
		await handler(makeReq({ period: 'week' }), res.res);

		const body = res.body as RagUsageResponse;
		expect(body.totalTokens).toBe(1_000);
		expect(body.period).toBe('week');
	});

	it('?period=all returns every job regardless of age', async () => {
		const srcId = insertSource(db, { name: 'Src', model: 'text-embedding-3-small' });
		const recent = new Date().toISOString();
		const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
		insertJob(db, { sourceId: srcId, tokens: 100, startedAt: recent });
		insertJob(db, { sourceId: srcId, tokens: 900, startedAt: old });

		const handler = captured.getUsage();
		const res = makeRes();
		await handler(makeReq({ period: 'all' }), res.res);

		const body = res.body as RagUsageResponse;
		expect(body.totalTokens).toBe(1_000);
		expect(body.period).toBe('all');
	});

	it('counts tokens but reports costUsd=0 for unknown embedding models', async () => {
		const srcId = insertSource(db, {
			name: 'Mystery model',
			model: 'private-embedding-v999',
		});
		insertJob(db, { sourceId: srcId, tokens: 1_000_000 });

		const handler = captured.getUsage();
		const res = makeRes();
		await handler(makeReq(), res.res);

		const body = res.body as RagUsageResponse;
		expect(body.totalTokens).toBe(1_000_000);
		expect(body.totalCostUsd).toBe(0);
		expect(body.perProvider).toHaveLength(1);
		expect(body.perProvider[0]).toMatchObject({
			model: 'private-embedding-v999',
			tokens: 1_000_000,
			costUsd: 0,
			known: false,
		});
	});

	it('excludes non-completed jobs (pending / failed) from the rollup', async () => {
		const srcId = insertSource(db, { name: 'Src', model: 'text-embedding-3-small' });
		insertJob(db, { sourceId: srcId, tokens: 500, status: 'completed' });
		insertJob(db, { sourceId: srcId, tokens: 999_999, status: 'failed' });
		insertJob(db, { sourceId: srcId, tokens: 999_999, status: 'pending' });

		const handler = captured.getUsage();
		const res = makeRes();
		await handler(makeReq(), res.res);

		const body = res.body as RagUsageResponse;
		expect(body.totalTokens).toBe(500);
	});

	it('groups perDay buckets by ISO date prefix', async () => {
		const srcId = insertSource(db, { name: 'Src', model: 'text-embedding-3-small' });
		// Two jobs on the same UTC day → one bucket.
		insertJob(db, { sourceId: srcId, tokens: 100, startedAt: '2026-05-01T08:00:00.000Z' });
		insertJob(db, { sourceId: srcId, tokens: 200, startedAt: '2026-05-01T20:30:00.000Z' });
		// Different day → second bucket. Use a recent date so 'all' period picks it up.
		const recentIso = new Date().toISOString();
		insertJob(db, { sourceId: srcId, tokens: 50, startedAt: recentIso });

		const handler = captured.getUsage();
		const res = makeRes();
		await handler(makeReq({ period: 'all' }), res.res);

		const body = res.body as RagUsageResponse;
		const may1 = body.perDay.find((d) => d.date === '2026-05-01');
		expect(may1).toBeDefined();
		expect(may1?.tokens).toBe(300);
		// At least two distinct day buckets present overall.
		expect(body.perDay.length).toBeGreaterThanOrEqual(2);
	});
});

describe('schema migration — v7 tokens_embedded', () => {
	function hasColumn(db: BetterSqlite3Database, table: string, column: string): boolean {
		const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
		return cols.some((c) => c.name === column);
	}

	it('adds tokens_embedded to rag_jobs on a fresh DB', () => {
		const db = makeDb();
		expect(hasColumn(db, 'rag_jobs', 'tokens_embedded')).toBe(true);
	});

	it('is idempotent — re-running runRagMigrations does not duplicate the column', () => {
		const db = makeDb();
		runRagMigrations({ raw: db });
		runRagMigrations({ raw: db });
		const cols = db.pragma('table_info(rag_jobs)') as Array<{ name: string }>;
		expect(cols.filter((c) => c.name === 'tokens_embedded')).toHaveLength(1);
	});

	it('upgrade path — v6 DB without the column gets it added by v7', () => {
		const db = new Database(':memory:');
		// Build a v6-shape rag_jobs (no tokens_embedded yet).
		db.exec(`
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
				tenant_id TEXT NOT NULL DEFAULT 'default',
				started_at TEXT NOT NULL DEFAULT (datetime('now')),
				finished_at TEXT
			);
			CREATE TABLE rag_schema_version (key TEXT PRIMARY KEY, version INTEGER NOT NULL);
			INSERT INTO rag_schema_version (key, version) VALUES ('rag', 6);
			INSERT INTO rag_jobs (id, source_id, status) VALUES ('j-legacy', 's-x', 'completed');
		`);

		expect(hasColumn(db, 'rag_jobs', 'tokens_embedded')).toBe(false);

		runRagMigrations({ raw: db });

		expect(hasColumn(db, 'rag_jobs', 'tokens_embedded')).toBe(true);
		// Legacy row defaults to 0.
		const legacy = db
			.prepare(`SELECT tokens_embedded FROM rag_jobs WHERE id = ?`)
			.get('j-legacy') as { tokens_embedded: number };
		expect(legacy.tokens_embedded).toBe(0);

		const ver = db
			.prepare(`SELECT version FROM rag_schema_version WHERE key = 'rag'`)
			.get() as { version: number };
		expect(ver.version).toBe(7);
	});
});
