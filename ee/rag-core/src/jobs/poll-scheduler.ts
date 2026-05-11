// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Database as BetterSqlite3Database } from 'better-sqlite3';

/**
 * Audit hook entry shape — duplicated from routes/types.ts so this module has
 * no upstream dependency on the route layer. Mirrors the shape used by the
 * host's audit log.
 */
export interface PollAuditEntry {
	type: string;
	payload: Record<string, unknown>;
	timestamp: string;
}

/**
 * Dependencies wired into the {@link PollScheduler}.
 *
 * The scheduler intentionally does NOT know how to insert a `rag_jobs` row or
 * call `SyncQueue.enqueue` directly — those concerns live in the host
 * (`packages/cli/src/rag-runtime.ts`) where a `RagRouteDeps` is already
 * assembled. The single hook `triggerSync` returns a `jobId` on success or
 * `null` when the queue rejected the request (already running / queued for
 * the same source). This keeps the scheduler decoupled from any storage shape.
 */
export interface PollSchedulerDeps {
	/** Shared SQLite handle. Used at boot to discover sources with polling enabled. */
	db: BetterSqlite3Database;
	/**
	 * Triggers a sync for the given source. Implementations MUST:
	 *   1. Insert a `pending` row into `rag_jobs`,
	 *   2. Call `SyncQueue.enqueue(sourceId, jobId)`,
	 *   3. On rejection by the queue, DELETE the inserted row and return `null`.
	 *   4. Otherwise return the inserted `jobId`.
	 *
	 * This shape mirrors the route handler at `POST /api/rag/sources/:id/sync`.
	 */
	triggerSync: (sourceId: string) => string | null;
	/** Optional audit hook called on every poll tick (success and skip). */
	onAudit?: (event: PollAuditEntry) => void;
}

/**
 * In-process scheduler that periodically triggers sync jobs for sources whose
 * `polling_interval_seconds` column is non-null.
 *
 * **Semantics**:
 *   - `start()` reads the DB once and registers a `setInterval` per polled source.
 *   - `upsert(sourceId, n)` registers / updates / removes a timer in O(1).
 *   - `remove(sourceId)` clears the timer for a deleted source.
 *   - `stop()` clears every timer — used by tests for clean shutdown.
 *
 * **First-fire delay**: timers do NOT fire immediately on registration. The
 * first sync happens `n` seconds AFTER the call to `upsert`. This is
 * intentional: a user creating a source via the API typically wants to do a
 * manual sync first to verify the connector wiring before letting the
 * scheduler take over.
 *
 * **Process lifetime**: Node's `setInterval` keeps the event loop alive.
 * That's fine in production (the HTTP server is the long-running process
 * anyway) but tests MUST call `stop()` to release the timers.
 *
 * **No persistence across restarts**: the scheduler is purely in-memory. A
 * server restart drops every timer — they're rebuilt from the DB by `start()`
 * on the next boot. There is no "missed tick" recovery: if the server was
 * down for 10 minutes and a source had a 5-minute interval, the scheduler
 * will NOT trigger 2 catch-up syncs at restart. The next tick fires N seconds
 * after `start()` returns, period.
 *
 * **Concurrency with manual syncs**: the scheduler's `triggerSync` callback
 * goes through the same `SyncQueue` as the manual `POST /sync` route, so
 * polling and manual triggers naturally serialize per-source via the queue's
 * dedupe-by-sourceId. A poll tick that fires while a manual sync is running
 * for the same source is skipped (audit `rag.sync.poll.skipped`).
 */
export class PollScheduler {
	#timers: Map<string, NodeJS.Timeout> = new Map();
	readonly #deps: PollSchedulerDeps;

	constructor(deps: PollSchedulerDeps) {
		this.#deps = deps;
	}

	/**
	 * Bootstrap: read every source with `polling_interval_seconds IS NOT NULL`
	 * and register a timer for each. Idempotent — calling twice replaces the
	 * timer set.
	 *
	 * Defensive: the column may not exist yet on older DBs that haven't run
	 * the v4 migration. We probe `table_info` first and silently no-op when
	 * the column is missing, so callers that forget to run migrations don't
	 * crash at boot.
	 */
	start(): void {
		const cols = this.#deps.db.pragma('table_info(rag_sources)') as Array<{ name: string }>;
		if (!cols.some((c) => c.name === 'polling_interval_seconds')) {
			// Migration not run yet — nothing to schedule.
			return;
		}
		interface Row {
			id: string;
			polling_interval_seconds: number;
		}
		// Defensive: filter on `deleted_at IS NULL` so soft-deleted sources
		// (v8) are never auto-synced. The column may be missing on legacy
		// DBs that haven't run `runRagMigrations` yet — we probe table_info
		// to keep the boot path tolerant of partial schemas. Without this
		// guard a v7 DB would crash with "no such column: deleted_at" on
		// every boot until the host upgrade ran.
		const hasDeletedAt = cols.some((c) => c.name === 'deleted_at');
		const whereSql = hasDeletedAt
			? `WHERE polling_interval_seconds IS NOT NULL AND deleted_at IS NULL`
			: `WHERE polling_interval_seconds IS NOT NULL`;
		const rows = this.#deps.db
			.prepare<[], Row>(
				`SELECT id, polling_interval_seconds FROM rag_sources
				 ${whereSql}`,
			)
			.all();
		for (const row of rows) {
			this.upsert(row.id, row.polling_interval_seconds);
		}
	}

	/**
	 * Stop all timers. Idempotent: safe to call when no timers are registered.
	 * Always call this from tests to avoid the test runner hanging on an
	 * active interval.
	 */
	stop(): void {
		for (const timer of this.#timers.values()) {
			clearInterval(timer);
		}
		this.#timers.clear();
	}

	/**
	 * Register or update the timer for `sourceId`.
	 *
	 *   - `intervalSeconds === null` → remove the timer if present (no-op
	 *     otherwise). Used when a source's polling is disabled via PATCH.
	 *   - `intervalSeconds` is a positive integer → clear any existing timer
	 *     for the source and replace it with a fresh `setInterval`. Replacing
	 *     the timer (rather than mutating an existing one) keeps the
	 *     scheduling deterministic: the next fire is exactly `intervalSeconds`
	 *     from the call to `upsert`, regardless of how long the previous
	 *     interval had been running.
	 *
	 * Validation of the interval range (60–86400) is the caller's responsibility
	 * — we trust the value because it has already been validated by the Zod
	 * schema at the API boundary. The scheduler treats any non-null number as
	 * a valid millisecond multiplier.
	 */
	upsert(sourceId: string, intervalSeconds: number | null): void {
		// Always clear the existing timer first so the call is fully idempotent
		// regardless of which branch we take below.
		const existing = this.#timers.get(sourceId);
		if (existing !== undefined) {
			clearInterval(existing);
			this.#timers.delete(sourceId);
		}
		if (intervalSeconds === null) {
			return;
		}
		const timer = setInterval(() => {
			this.#tick(sourceId);
		}, intervalSeconds * 1000);
		this.#timers.set(sourceId, timer);
	}

	/**
	 * Remove the timer for a deleted source. Idempotent: no-op when the
	 * source has no registered timer (e.g. the source was created without
	 * polling and is now being deleted).
	 */
	remove(sourceId: string): void {
		const timer = this.#timers.get(sourceId);
		if (timer !== undefined) {
			clearInterval(timer);
			this.#timers.delete(sourceId);
		}
	}

	/**
	 * Test-only helper: returns the set of sourceIds with an active timer.
	 */
	active(): string[] {
		return Array.from(this.#timers.keys());
	}

	/**
	 * Internal tick: invoked by the underlying `setInterval` every
	 * `intervalSeconds` seconds. Calls `triggerSync` and surfaces the outcome
	 * via the audit hook.
	 *
	 * Errors from `triggerSync` are caught so a single bad tick can't crash
	 * the timer (Node's setInterval keeps firing even after a thrown error,
	 * but the unhandled rejection would still propagate up the event loop).
	 */
	#tick(sourceId: string): void {
		const timestamp = new Date().toISOString();
		try {
			const jobId = this.#deps.triggerSync(sourceId);
			if (jobId === null) {
				// Queue rejected — sync already running or queued for this source.
				// This is the expected outcome when a long sync overlaps with
				// the next poll tick; we log via audit and keep the timer alive.
				this.#deps.onAudit?.({
					type: 'rag.sync.poll.skipped',
					payload: { sourceId, reason: 'sync-already-active' },
					timestamp,
				});
				return;
			}
			this.#deps.onAudit?.({
				type: 'rag.sync.poll.triggered',
				payload: { sourceId, jobId },
				timestamp,
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.onAudit?.({
				type: 'rag.sync.poll.failed',
				payload: { sourceId, error: message },
				timestamp,
			});
		}
	}
}
