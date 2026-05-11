// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Express, Request, Response } from 'express';
import type { RagRouteDeps } from './types.js';
import { estimateCostUsd, isKnownEmbeddingModel } from '../pricing.js';

/**
 * Response shape for `GET /api/rag/usage`. Frontend mirrors this in
 * `web/api.ts` (re-exported via the package barrel). All token counts are
 * integers (sum over `chunk.tokenCount`); `costUsd` is the estimated USD
 * cost using the pricing table in `pricing.ts`.
 */
export interface RagUsageResponse {
	totalTokens: number;
	totalCostUsd: number;
	perProvider: Array<{
		model: string;
		tokens: number;
		costUsd: number;
		/** True when the model appears in `pricing.ts`; false → costUsd will be 0. */
		known: boolean;
	}>;
	perSource: Array<{
		sourceId: string;
		name: string;
		tokens: number;
		costUsd: number;
	}>;
	perDay: Array<{
		/** ISO date (UTC) — `YYYY-MM-DD`. */
		date: string;
		tokens: number;
	}>;
	/** Echo of the resolved period filter so the UI can render the label. */
	period: 'month' | 'week' | 'all';
}

type Period = 'month' | 'week' | 'all';

/**
 * Parse `?period=` into a typed token. Defaults to `'month'` so the
 * dashboard widget gets a useful window out of the box. Unknown values
 * also fall back to `'month'` rather than 400ing — the endpoint is
 * read-only and should never crash on bad query input.
 */
function parsePeriod(raw: unknown): Period {
	if (typeof raw !== 'string') return 'month';
	const v = raw.trim().toLowerCase();
	if (v === 'week' || v === 'all') return v;
	return 'month';
}

/**
 * Convert a Period to an inclusive lower-bound ISO timestamp, or null
 * for `'all'`. Anchored on UTC midnight today minus N days so the
 * window is stable across requests within the same day.
 */
function periodStart(period: Period, now: Date = new Date()): string | null {
	if (period === 'all') return null;
	const days = period === 'week' ? 7 : 30;
	const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
	return start.toISOString();
}

/**
 * Register the usage endpoint:
 *
 *   GET /api/rag/usage?period=month|week|all
 *
 * Aggregates `tokens_embedded` from `rag_jobs` joined to `rag_sources`
 * (for `name` / `embedding_model_version`). Only `status='completed'`
 * rows contribute — failed/partial jobs may have partial counts but
 * we keep the contract strict for now (can be relaxed once the UI
 * surfaces failure breakdowns).
 *
 * Tenant scoping is via `getTenantId(req)` when wired by the host; absent
 * a resolver we filter on the literal `'default'` (Phase A).
 */
export function registerRagUsageRoutes(app: Express, deps: RagRouteDeps): void {
	app.get('/api/rag/usage', (req: Request, res: Response) => {
		try {
			const period = parsePeriod(req.query['period']);
			const tenantId = deps.getTenantId ? deps.getTenantId(req) : 'default';
			const sinceIso = periodStart(period);

			// Build the WHERE clause once and reuse across the three roll-ups
			// below. We always filter on tenant + completed status; the date
			// bound is appended only for week/month.
			//
			// `s.deleted_at IS NULL` excludes jobs from soft-deleted sources —
			// they'd skew the dashboard with cost rows for sources the user
			// can no longer see, and they're scheduled for hard-deletion by
			// the cleanup cron anyway. The condition uses `(s.id IS NULL OR
			// s.deleted_at IS NULL)` to tolerate the LEFT JOIN: jobs whose
			// source row was already hard-deleted (rare race) still count.
			const baseWhere = [
				'j.status = ?',
				'j.tenant_id = ?',
				'(s.id IS NULL OR s.deleted_at IS NULL)',
			];
			const baseParams: unknown[] = ['completed', tenantId];
			if (sinceIso !== null) {
				baseWhere.push('j.started_at >= ?');
				baseParams.push(sinceIso);
			}
			const whereSql = `WHERE ${baseWhere.join(' AND ')}`;

			// 1. per-provider — join rag_sources for `embedding_model_version`.
			interface ProviderRow {
				model: string;
				tokens: number | null;
			}
			const providerRows = deps.db
				.prepare<unknown[], ProviderRow>(
					`SELECT
					   COALESCE(s.embedding_model_version, '') AS model,
					   SUM(j.tokens_embedded) AS tokens
					 FROM rag_jobs j
					 LEFT JOIN rag_sources s ON s.id = j.source_id
					 ${whereSql}
					 GROUP BY s.embedding_model_version`,
				)
				.all(...baseParams);

			const perProvider = providerRows
				.map((r) => {
					const tokens = r.tokens ?? 0;
					return {
						model: r.model,
						tokens,
						costUsd: estimateCostUsd(r.model, tokens),
						known: isKnownEmbeddingModel(r.model),
					};
				})
				.filter((p) => p.tokens > 0)
				.sort((a, b) => b.tokens - a.tokens);

			// 2. per-source — join rag_sources for the human-readable name.
			interface SourceRow {
				source_id: string;
				name: string | null;
				model: string | null;
				tokens: number | null;
			}
			const sourceRows = deps.db
				.prepare<unknown[], SourceRow>(
					`SELECT
					   j.source_id AS source_id,
					   s.name AS name,
					   s.embedding_model_version AS model,
					   SUM(j.tokens_embedded) AS tokens
					 FROM rag_jobs j
					 LEFT JOIN rag_sources s ON s.id = j.source_id
					 ${whereSql}
					 GROUP BY j.source_id`,
				)
				.all(...baseParams);

			const perSource = sourceRows
				.map((r) => {
					const tokens = r.tokens ?? 0;
					return {
						sourceId: r.source_id,
						// Deleted source — name will be null after JOIN. Fall
						// back to the id so the UI still has something to render.
						name: r.name ?? r.source_id,
						tokens,
						costUsd: estimateCostUsd(r.model ?? '', tokens),
					};
				})
				.filter((p) => p.tokens > 0)
				.sort((a, b) => b.tokens - a.tokens);

			// 3. per-day — bucketize on the `started_at` ISO date prefix.
			// SUBSTR is portable across SQLite versions and avoids the
			// platform-specific `date()` formatting quirks. The LEFT JOIN on
			// `rag_sources` mirrors the other two roll-ups so the shared
			// `whereSql` (which references `s.deleted_at`) resolves cleanly.
			interface DayRow {
				date: string;
				tokens: number | null;
			}
			const dayRows = deps.db
				.prepare<unknown[], DayRow>(
					`SELECT
					   SUBSTR(j.started_at, 1, 10) AS date,
					   SUM(j.tokens_embedded) AS tokens
					 FROM rag_jobs j
					 LEFT JOIN rag_sources s ON s.id = j.source_id
					 ${whereSql}
					 GROUP BY SUBSTR(j.started_at, 1, 10)
					 ORDER BY date ASC`,
				)
				.all(...baseParams);

			const perDay = dayRows
				.map((r) => ({ date: r.date, tokens: r.tokens ?? 0 }))
				.filter((d) => d.tokens > 0);

			// Totals are recomputed off the per-provider rollup so we never
			// disagree with the table the UI renders next to them.
			const totalTokens = perProvider.reduce((sum, p) => sum + p.tokens, 0);
			const totalCostUsd = perProvider.reduce((sum, p) => sum + p.costUsd, 0);

			const body: RagUsageResponse = {
				totalTokens,
				totalCostUsd,
				perProvider,
				perSource,
				perDay,
				period,
			};
			res.json(body);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			res.status(500).json({ error: message });
		}
	});
}
