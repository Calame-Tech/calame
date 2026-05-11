// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

import { runRagMigrations } from '../../storage/schema.js';
import {
	assertWithinCap,
	currentMonthStartIso,
	EmbeddingCapExceededError,
	getCurrentMonthTokens,
	parseMonthlyCapEnv,
	resolveWarningThreshold,
	DEFAULT_CAP_WARNING_THRESHOLD,
} from '../embedding-cap.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3Database {
	const db = new Database(':memory:');
	runRagMigrations({ raw: db });
	return db;
}

interface InsertSourceOpts {
	id?: string;
	deleted?: boolean;
}

function insertSource(db: BetterSqlite3Database, opts: InsertSourceOpts = {}): string {
	const id = opts.id ?? nanoid();
	db.prepare(
		`INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
		  embedding_dimensions, tenant_id, deleted_at, created_at, updated_at)
		 VALUES (?, ?, 'local', '{}', 'test', 'text-embedding-3-small', 16, 'default', ?, datetime('now'), datetime('now'))`,
	).run(id, `Source ${id.slice(0, 4)}`, opts.deleted ? new Date().toISOString() : null);
	return id;
}

interface InsertJobOpts {
	sourceId: string;
	tokens: number;
	startedAt?: string;
	status?: 'completed' | 'failed' | 'pending' | 'running';
	tenantId?: string;
}

function insertJob(db: BetterSqlite3Database, opts: InsertJobOpts): string {
	const id = nanoid();
	const startedAt = opts.startedAt ?? new Date().toISOString();
	db.prepare(
		`INSERT INTO rag_jobs
		 (id, source_id, status, progress, total_documents, processed_documents,
		  skipped_by_etag, gc_deleted, tokens_embedded, tenant_id, started_at, finished_at)
		 VALUES (?, ?, ?, 1, 1, 1, 0, 0, ?, ?, ?, ?)`,
	).run(
		id,
		opts.sourceId,
		opts.status ?? 'completed',
		opts.tokens,
		opts.tenantId ?? 'default',
		startedAt,
		startedAt,
	);
	return id;
}

// ---------------------------------------------------------------------------
// parseMonthlyCapEnv
// ---------------------------------------------------------------------------

describe('parseMonthlyCapEnv', () => {
	it('parses a positive integer string', () => {
		expect(parseMonthlyCapEnv('100000')).toBe(100_000);
		expect(parseMonthlyCapEnv('1')).toBe(1);
	});

	it('returns 0 for malformed input', () => {
		expect(parseMonthlyCapEnv('abc')).toBe(0);
		expect(parseMonthlyCapEnv('1_000')).toBe(1); // parseInt stops at '_'
		expect(parseMonthlyCapEnv('')).toBe(0);
		expect(parseMonthlyCapEnv('   ')).toBe(0);
	});

	it('returns 0 when explicitly set to 0', () => {
		expect(parseMonthlyCapEnv('0')).toBe(0);
	});

	it('returns 0 for undefined', () => {
		expect(parseMonthlyCapEnv(undefined)).toBe(0);
	});

	it('returns 0 for negative values', () => {
		expect(parseMonthlyCapEnv('-1')).toBe(0);
		expect(parseMonthlyCapEnv('-100000')).toBe(0);
	});

	it('truncates fractional values via parseInt', () => {
		expect(parseMonthlyCapEnv('1000.5')).toBe(1000);
		expect(parseMonthlyCapEnv('1000.999')).toBe(1000);
	});

	it('trims whitespace before parsing', () => {
		expect(parseMonthlyCapEnv('  42  ')).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// currentMonthStartIso
// ---------------------------------------------------------------------------

describe('currentMonthStartIso', () => {
	it('returns the first millisecond of the current UTC month', () => {
		const now = new Date('2026-05-15T14:23:11.123Z');
		expect(currentMonthStartIso(now)).toBe('2026-05-01T00:00:00.000Z');
	});

	it('handles January correctly (month=0)', () => {
		const now = new Date('2026-01-31T23:59:59.999Z');
		expect(currentMonthStartIso(now)).toBe('2026-01-01T00:00:00.000Z');
	});

	it('handles December correctly (month=11)', () => {
		const now = new Date('2026-12-01T00:00:00.000Z');
		expect(currentMonthStartIso(now)).toBe('2026-12-01T00:00:00.000Z');
	});
});

// ---------------------------------------------------------------------------
// getCurrentMonthTokens
// ---------------------------------------------------------------------------

describe('getCurrentMonthTokens', () => {
	let db: BetterSqlite3Database;
	beforeEach(() => {
		db = makeDb();
	});

	it('returns 0 when there are no jobs', () => {
		expect(getCurrentMonthTokens(db, 'default')).toBe(0);
	});

	it('sums tokens for completed jobs within the current month', () => {
		const src = insertSource(db);
		const now = new Date();
		insertJob(db, { sourceId: src, tokens: 1000, startedAt: now.toISOString() });
		insertJob(db, { sourceId: src, tokens: 2500, startedAt: now.toISOString() });
		expect(getCurrentMonthTokens(db, 'default', now)).toBe(3500);
	});

	it('ignores jobs from previous months', () => {
		const src = insertSource(db);
		const now = new Date('2026-05-15T12:00:00.000Z');
		insertJob(db, {
			sourceId: src,
			tokens: 1000,
			startedAt: '2026-05-10T08:00:00.000Z',
		});
		// April → previous month, excluded.
		insertJob(db, {
			sourceId: src,
			tokens: 999_999,
			startedAt: '2026-04-30T23:59:59.999Z',
		});
		expect(getCurrentMonthTokens(db, 'default', now)).toBe(1000);
	});

	it('ignores failed and pending jobs (status=completed only)', () => {
		const src = insertSource(db);
		const now = new Date();
		insertJob(db, { sourceId: src, tokens: 100, status: 'completed' });
		insertJob(db, { sourceId: src, tokens: 999_999, status: 'failed' });
		insertJob(db, { sourceId: src, tokens: 999_999, status: 'pending' });
		insertJob(db, { sourceId: src, tokens: 999_999, status: 'running' });
		expect(getCurrentMonthTokens(db, 'default', now)).toBe(100);
	});

	it('ignores jobs whose source has been soft-deleted', () => {
		const liveSrc = insertSource(db);
		const deletedSrc = insertSource(db, { deleted: true });
		insertJob(db, { sourceId: liveSrc, tokens: 500 });
		insertJob(db, { sourceId: deletedSrc, tokens: 999_999 });
		expect(getCurrentMonthTokens(db, 'default')).toBe(500);
	});

	it('scopes by tenant id', () => {
		const src = insertSource(db);
		insertJob(db, { sourceId: src, tokens: 100, tenantId: 'default' });
		insertJob(db, { sourceId: src, tokens: 200, tenantId: 'other-tenant' });
		expect(getCurrentMonthTokens(db, 'default')).toBe(100);
		expect(getCurrentMonthTokens(db, 'other-tenant')).toBe(200);
	});

	it('returns 0 when the rag_jobs table is missing entirely', () => {
		const bare = new Database(':memory:');
		expect(getCurrentMonthTokens(bare, 'default')).toBe(0);
	});

	it('returns 0 when the tokens_embedded column is missing (pre-v7 DB)', () => {
		const legacy = new Database(':memory:');
		// Build a stripped rag_jobs with no tokens_embedded column.
		legacy.exec(`
			CREATE TABLE rag_jobs (
				id TEXT PRIMARY KEY,
				source_id TEXT NOT NULL,
				status TEXT NOT NULL,
				tenant_id TEXT NOT NULL DEFAULT 'default',
				started_at TEXT NOT NULL
			);
		`);
		expect(getCurrentMonthTokens(legacy, 'default')).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// assertWithinCap
// ---------------------------------------------------------------------------

describe('assertWithinCap', () => {
	let db: BetterSqlite3Database;
	beforeEach(() => {
		db = makeDb();
	});

	it('no-ops when monthlyTokenCap <= 0 (unlimited)', () => {
		const src = insertSource(db);
		insertJob(db, { sourceId: src, tokens: 1_000_000_000 });
		expect(() =>
			assertWithinCap({ db, config: { monthlyTokenCap: 0 } }, 'default', 999_999_999),
		).not.toThrow();
		expect(() =>
			assertWithinCap({ db, config: { monthlyTokenCap: -100 } }, 'default', 999_999_999),
		).not.toThrow();
	});

	it('no-ops when attemptedTokens <= 0', () => {
		expect(() =>
			assertWithinCap({ db, config: { monthlyTokenCap: 100 } }, 'default', 0),
		).not.toThrow();
		expect(() =>
			assertWithinCap({ db, config: { monthlyTokenCap: 100 } }, 'default', -50),
		).not.toThrow();
	});

	it('allows when current + attempted < cap', () => {
		const src = insertSource(db);
		insertJob(db, { sourceId: src, tokens: 4000 });
		expect(() =>
			assertWithinCap({ db, config: { monthlyTokenCap: 10_000 } }, 'default', 5000),
		).not.toThrow();
	});

	it('throws EmbeddingCapExceededError when current + attempted exceeds cap', () => {
		const src = insertSource(db);
		insertJob(db, { sourceId: src, tokens: 9000 });
		expect(() =>
			assertWithinCap({ db, config: { monthlyTokenCap: 10_000 } }, 'default', 5000),
		).toThrow(EmbeddingCapExceededError);
	});

	it('throws when the very first call already overflows the cap', () => {
		expect(() =>
			assertWithinCap({ db, config: { monthlyTokenCap: 100 } }, 'default', 200),
		).toThrow(EmbeddingCapExceededError);
	});

	it('treats `current + attempted == cap` as allowed (strict greater-than)', () => {
		const src = insertSource(db);
		insertJob(db, { sourceId: src, tokens: 9000 });
		// 9000 + 1000 = 10000 → exactly at the cap, must not throw.
		expect(() =>
			assertWithinCap({ db, config: { monthlyTokenCap: 10_000 } }, 'default', 1000),
		).not.toThrow();
	});

	it('produces an informative error message naming the tenant, totals, and env var', () => {
		const src = insertSource(db);
		// Tokens recorded under the same tenant we're going to gate against.
		insertJob(db, { sourceId: src, tokens: 9_000, tenantId: 'acme-corp' });
		let caught: unknown = null;
		try {
			assertWithinCap(
				{ db, config: { monthlyTokenCap: 10_000 } },
				'acme-corp',
				5_000,
			);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(EmbeddingCapExceededError);
		const e = caught as EmbeddingCapExceededError;
		expect(e.tenantId).toBe('acme-corp');
		expect(e.currentTokens).toBe(9_000);
		expect(e.cap).toBe(10_000);
		expect(e.attemptedTokens).toBe(5_000);
		expect(e.message).toContain('acme-corp');
		expect(e.message).toContain('9,000');
		expect(e.message).toContain('5,000');
		expect(e.message).toContain('10,000');
		expect(e.message).toContain('CALAME_RAG_MONTHLY_TOKEN_CAP');
	});

	it('only considers the requesting tenant when summing the current usage', () => {
		const src = insertSource(db);
		// Pile up tokens on a different tenant that should NOT count against us.
		insertJob(db, { sourceId: src, tokens: 1_000_000, tenantId: 'other' });
		insertJob(db, { sourceId: src, tokens: 100, tenantId: 'default' });
		expect(() =>
			assertWithinCap({ db, config: { monthlyTokenCap: 1000 } }, 'default', 500),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// resolveWarningThreshold
// ---------------------------------------------------------------------------

describe('resolveWarningThreshold', () => {
	it('returns the default when unspecified', () => {
		expect(resolveWarningThreshold({ monthlyTokenCap: 1 })).toBe(
			DEFAULT_CAP_WARNING_THRESHOLD,
		);
	});

	it('honors a custom threshold within [0, 1]', () => {
		expect(resolveWarningThreshold({ monthlyTokenCap: 1, warningThreshold: 0.5 })).toBe(0.5);
		expect(resolveWarningThreshold({ monthlyTokenCap: 1, warningThreshold: 0 })).toBe(0);
		expect(resolveWarningThreshold({ monthlyTokenCap: 1, warningThreshold: 1 })).toBe(1);
	});

	it('clamps out-of-range values', () => {
		expect(resolveWarningThreshold({ monthlyTokenCap: 1, warningThreshold: -0.5 })).toBe(0);
		expect(resolveWarningThreshold({ monthlyTokenCap: 1, warningThreshold: 1.5 })).toBe(1);
	});
});
