// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Database as BetterSqlite3Database } from 'better-sqlite3';

/**
 * Operator-controlled cap on embedding tokens consumed within a calendar
 * month, scoped to a single tenant. The cap is a "kill-switch" rather than a
 * billing primitive — its purpose is to keep a runaway sync (misconfigured
 * connector, accidentally pointed at /, etc.) from racking up an unbounded
 * provider bill.
 *
 * Scope: tenant-month. Phase A multi-tenancy ships with a single `'default'`
 * tenant, so the cap is effectively per-process. When Phase B adds real
 * multi-tenancy each tenant gets its own counter — no schema change required
 * because `rag_jobs.tenant_id` is already keyed.
 */
export interface EmbeddingCapConfig {
	/**
	 * Maximum tokens (sum of `chunk.tokenCount`) that may be embedded by a
	 * given (tenant, calendar-month-UTC) pair before {@link assertWithinCap}
	 * starts throwing. `0` (or any non-positive value) disables the check
	 * entirely — same effect as not configuring a cap.
	 */
	monthlyTokenCap: number;
	/**
	 * Soft warning threshold expressed as a fraction of `monthlyTokenCap`
	 * (range 0..1). When `currentMonthTokens / monthlyTokenCap` crosses this
	 * value the UI surfaces a non-fatal banner; sync continues normally
	 * until the hard cap is reached. Defaults to `0.8` when unspecified.
	 */
	warningThreshold?: number;
}

/** Dependencies for cap helpers — the SQLite handle plus the parsed config. */
export interface EmbeddingCapDeps {
	db: BetterSqlite3Database;
	config: EmbeddingCapConfig;
}

/**
 * Thrown by {@link assertWithinCap} when a pending embed call would push the
 * running monthly total above the configured cap. The sync orchestrator
 * catches this, marks the job `'failed'`, and surfaces `error.message` in
 * `rag_jobs.error` (visible in the UI's sync history).
 *
 * The error message intentionally:
 *  - names the tenant (helps Phase B operators triage cross-tenant noise),
 *  - shows current + attempted + cap in human-readable form (so the UI can
 *    blit it verbatim without re-formatting),
 *  - tells the operator exactly which env var to raise.
 */
export class EmbeddingCapExceededError extends Error {
	constructor(
		public readonly tenantId: string,
		public readonly currentTokens: number,
		public readonly cap: number,
		public readonly attemptedTokens: number,
	) {
		super(
			`Monthly embedding cap exceeded for tenant '${tenantId}': ` +
				`${currentTokens.toLocaleString('en-US')} + ${attemptedTokens.toLocaleString('en-US')} ` +
				`would exceed cap ${cap.toLocaleString('en-US')}. ` +
				`Wait until next month or raise CALAME_RAG_MONTHLY_TOKEN_CAP.`,
		);
		this.name = 'EmbeddingCapExceededError';
	}
}

/**
 * Compute the ISO timestamp for the first millisecond of the current
 * calendar month in UTC. Exposed for testability — callers can pass a
 * fixed `now` to make assertions deterministic. The choice of UTC (rather
 * than the process-local timezone) is deliberate: tenants in different
 * timezones must still agree on a single roll-over moment.
 */
export function currentMonthStartIso(now: Date = new Date()): string {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	return start.toISOString();
}

/** Internal — narrow row shape for the aggregate query. */
interface SumRow {
	tokens: number | null;
}

/**
 * Sum `rag_jobs.tokens_embedded` for the supplied tenant across the current
 * calendar month (UTC). Only `status='completed'` jobs contribute — partial /
 * failed jobs have unstable token counts and would let an operator "free" cap
 * room by deliberately failing a sync.
 *
 * Returns `0` when:
 *  - no matching rows exist,
 *  - the `rag_jobs` table is missing (fixtures that bypass migrations),
 *  - the `tokens_embedded` column is missing (legacy DB pre-v7).
 *
 * The defensive fallbacks keep the cap a soft on-top layer: a misconfigured
 * DB never causes a hard failure here.
 */
export function getCurrentMonthTokens(
	db: BetterSqlite3Database,
	tenantId: string,
	now: Date = new Date(),
): number {
	// Probe for the column we depend on. `pragma table_info()` is cheap and
	// avoids surprising "no such column" errors on partial fixtures.
	let hasTokensColumn = false;
	try {
		const cols = db.pragma('table_info(rag_jobs)') as Array<{ name: string }>;
		hasTokensColumn = cols.some((c) => c.name === 'tokens_embedded');
	} catch {
		return 0;
	}
	if (!hasTokensColumn) return 0;

	const sinceIso = currentMonthStartIso(now);
	try {
		const row = db
			.prepare<[string, string], SumRow>(
				`SELECT COALESCE(SUM(j.tokens_embedded), 0) AS tokens
				 FROM rag_jobs j
				 LEFT JOIN rag_sources s ON s.id = j.source_id
				 WHERE j.status = 'completed'
				   AND j.tenant_id = ?
				   AND j.started_at >= ?
				   AND (s.id IS NULL OR s.deleted_at IS NULL)`,
			)
			.get(tenantId, sinceIso);
		return row?.tokens ?? 0;
	} catch {
		// `rag_jobs` missing entirely → no usage history, no cap to enforce.
		return 0;
	}
}

/**
 * Validate that a pending embed of `attemptedTokens` would keep the tenant
 * below its configured cap for the current calendar month. No-op when:
 *  - `monthlyTokenCap` is `<= 0` (unlimited),
 *  - `attemptedTokens` is `<= 0` (nothing to embed).
 *
 * Throws {@link EmbeddingCapExceededError} otherwise.
 *
 * Strategy note: we check BEFORE the embed call (rather than after, when the
 * provider has already returned a bill). The pipeline knows `chunk.tokenCount`
 * up front because the chunker runs gpt-tokenizer locally on the parsed text —
 * no provider round-trip is needed to estimate. This lets us reject the job
 * cleanly without paying for the doomed embed call.
 */
export function assertWithinCap(
	deps: EmbeddingCapDeps,
	tenantId: string,
	attemptedTokens: number,
	now: Date = new Date(),
): void {
	const cap = deps.config.monthlyTokenCap;
	if (!Number.isFinite(cap) || cap <= 0) return;
	if (!Number.isFinite(attemptedTokens) || attemptedTokens <= 0) return;

	const current = getCurrentMonthTokens(deps.db, tenantId, now);
	if (current + attemptedTokens > cap) {
		throw new EmbeddingCapExceededError(tenantId, current, cap, attemptedTokens);
	}
}

/**
 * Parse the `CALAME_RAG_MONTHLY_TOKEN_CAP` env var into a non-negative
 * integer. Lenient by design — any malformed input falls back to `0`
 * (unlimited) rather than crashing the bootstrap. Specifically:
 *  - `undefined` / empty string → `0`,
 *  - non-numeric (`'abc'`) → `0`,
 *  - negative → `0`,
 *  - fractional (`'1000.5'`) → truncated to `1000`.
 *
 * Operators who actually want zero (= unlimited) can either omit the var
 * or set it explicitly to `0`. There is no way to "set 1 token cap";
 * `'1'` is honored, but at that point the operator is debugging the cap,
 * which is the intended use case.
 */
export function parseMonthlyCapEnv(envValue: string | undefined): number {
	if (typeof envValue !== 'string') return 0;
	const trimmed = envValue.trim();
	if (trimmed.length === 0) return 0;
	const n = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(n) || n < 0) return 0;
	return n;
}

/** Default warning threshold used when {@link EmbeddingCapConfig.warningThreshold} is unset. */
export const DEFAULT_CAP_WARNING_THRESHOLD = 0.8;

/**
 * Resolve the warning threshold from a config, clamping to `[0, 1]`.
 * Centralized so the routes layer and the cap helpers agree on the same
 * value when the config omits it.
 */
export function resolveWarningThreshold(config: EmbeddingCapConfig): number {
	const raw = config.warningThreshold;
	if (!Number.isFinite(raw)) return DEFAULT_CAP_WARNING_THRESHOLD;
	const v = raw as number;
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}
