// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Database as BetterSqlite3Database } from 'better-sqlite3';

/**
 * Audit hook entry shape — duplicated from routes/types.ts so this module has
 * no upstream dependency on the route layer. Mirrors the shape used by the
 * host's audit log.
 */
export interface WatchAuditEntry {
	type: string;
	payload: Record<string, unknown>;
	timestamp: string;
}

/**
 * Disposer returned by a connector's `watch()`. Calling it stops the watcher
 * and releases any underlying filesystem handles.
 */
export type Unsubscribe = () => void;

/**
 * Minimal duck-typed shape of a watch-capable connector. We don't import from
 * `@calame-ee/rag-connectors` to keep the dependency direction one-way
 * (rag-connectors → rag-core, never back). Only the `watch` method is exercised
 * here — the manager treats `watch === undefined` as "this connector type does
 * not support real-time change notifications" and is tolerant of it.
 */
export interface WatchableConnector {
	type: string;
	watch?(
		config: Record<string, unknown>,
		sourceId: string,
		onChange: (event: { type: 'created' | 'updated' | 'deleted'; documentId: string }) => void,
	): Unsubscribe;
}

/**
 * Dependencies wired into the {@link WatchManager}.
 *
 * Like {@link import('./poll-scheduler.js').PollScheduler}, this manager does
 * NOT know how to insert a `rag_jobs` row or call `SyncQueue.enqueue` directly.
 * The host wires `triggerSync` — typically the very same lambda used by the
 * poll scheduler so the two trigger paths share dedupe semantics through the
 * queue.
 */
export interface WatchManagerDeps {
	/** Shared SQLite handle. Used at boot to discover sources whose type === 'local'. */
	db: BetterSqlite3Database;
	/**
	 * Resolve a connector by source type. Returns `null` when the type is not
	 * supported by the host's loaded connectors module (e.g. EE package missing).
	 * Today only `'local'` returns a connector with a `watch` method.
	 */
	resolveConnector: (type: string) => WatchableConnector | null;
	/** Decrypt a source's stored config blob into a JSON string. */
	decryptConfig: (encrypted: string) => string;
	/**
	 * Triggers a sync for the given source. Same contract as the poll scheduler:
	 *   - returns a `jobId` on success,
	 *   - returns `null` when the queue rejected (already running / queued).
	 */
	triggerSync: (sourceId: string) => string | null;
	/**
	 * Debounce window in ms — multiple events within this window collapse into
	 * a single sync trigger. Defaults to 5000ms (5s) which matches the typical
	 * IDE save burst pattern.
	 */
	debounceMs?: number;
	/** Optional audit hook called on every triggered or skipped sync. */
	onAudit?: (event: WatchAuditEntry) => void;
}

interface SourceRowLite {
	id: string;
	type: string;
	config_encrypted: string;
}

/**
 * Real-time filesystem watcher for sources whose connector supports `watch()`.
 *
 * **Today's wiring**: only `LocalFolderConnector` (chokidar-based) participates.
 * Other connectors (`s3`, `http`) are no-ops here because they do not emit
 * push notifications natively — S3 Event Notifications would go through
 * `registerWebhook` in a future tranche.
 *
 * **Debounce strategy**: when the watcher fires `created` / `updated` /
 * `deleted` events, the manager schedules a sync `debounceMs` later. Any
 * additional events arriving for the SAME source within that window reset the
 * timer. This collapses bursts (editor multi-write saves, `mv` operations,
 * `npm install` extracting hundreds of files) into a single sync. The trade-off
 * is end-to-end latency: a quiet single-file save is reflected in the index
 * after `debounceMs` ms, not immediately. 5s is a deliberate pick — short
 * enough that "search my docs after I saved one" feels live, long enough to
 * coalesce realistic edit bursts without re-triggering a sync per keystroke.
 *
 * **Sharing with the poll scheduler**: the host should pass the SAME
 * `triggerSync` lambda used by `PollScheduler`. The single shared lambda
 * handles `INSERT INTO rag_jobs` + `SyncQueue.enqueue` + `DELETE` on rejection
 * — meaning watch and poll naturally serialize per-source via the queue's
 * dedupe-by-sourceId. A watch-triggered sync that fires while a poll-triggered
 * sync is running for the same source is skipped (audit
 * `rag.sync.watch.skipped`).
 *
 * **Process lifetime**: chokidar watchers keep file handles open. Tests MUST
 * call `stop()` to release them. Production servers rely on process exit to
 * close them.
 *
 * **No persistence across restarts**: the manager is purely in-memory. A server
 * restart drops every watcher — they're rebuilt from the DB by `start()` on
 * the next boot. There is no replay of events that fired while the server was
 * down: those changes will be picked up by the next sync (manual or polled).
 */
export class WatchManager {
	#unsubscribers: Map<string, Unsubscribe> = new Map();
	#pendingFlushes: Map<string, NodeJS.Timeout> = new Map();
	readonly #deps: WatchManagerDeps;
	readonly #debounceMs: number;

	constructor(deps: WatchManagerDeps) {
		this.#deps = deps;
		this.#debounceMs = deps.debounceMs ?? 5000;
	}

	/**
	 * Bootstrap: read every `local`-type source and register a watcher for each.
	 * Idempotent — calling twice replaces the watcher set.
	 *
	 * Defensive: tolerant of a pre-Phase-1 DB where `rag_sources` may not exist
	 * yet. We swallow any DB error and log via the audit hook so callers that
	 * forget to run migrations don't crash at boot.
	 */
	start(): void {
		let rows: SourceRowLite[];
		try {
			// Defensive: filter on `deleted_at IS NULL` so soft-deleted sources
			// (v8) never re-register a watcher at boot. Probe table_info first
			// because legacy DBs that haven't replayed `runRagMigrations` yet
			// don't have the column — adding the clause unconditionally would
			// crash the boot path.
			const cols = this.#deps.db.pragma('table_info(rag_sources)') as Array<{ name: string }>;
			const hasDeletedAt = cols.some((c) => c.name === 'deleted_at');
			const sql = hasDeletedAt
				? `SELECT id, type, config_encrypted FROM rag_sources WHERE type = 'local' AND deleted_at IS NULL`
				: `SELECT id, type, config_encrypted FROM rag_sources WHERE type = 'local'`;
			rows = this.#deps.db
				.prepare<[], SourceRowLite>(sql)
				.all();
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.onAudit?.({
				type: 'rag.watch.start.failed',
				payload: { error: message },
				timestamp: new Date().toISOString(),
			});
			return;
		}
		for (const row of rows) {
			this.upsert({ id: row.id, type: row.type, configEncrypted: row.config_encrypted });
		}
	}

	/**
	 * Stop every watcher and clear pending debounce timers. Idempotent — safe
	 * to call twice or with no watchers registered.
	 */
	stop(): void {
		for (const unsubscribe of this.#unsubscribers.values()) {
			try {
				unsubscribe();
			} catch {
				// Never let a connector's close path crash shutdown.
			}
		}
		this.#unsubscribers.clear();
		for (const timer of this.#pendingFlushes.values()) {
			clearTimeout(timer);
		}
		this.#pendingFlushes.clear();
	}

	/**
	 * Register or refresh a watcher for the given source.
	 *
	 *  - If `source.type !== 'local'`: removes any watcher previously registered
	 *    for this id (covers PATCH-changes-type), then no-ops. Other types are
	 *    not currently watch-capable.
	 *  - If a watcher already exists for this id: closes the old one and
	 *    replaces it. Used after a PATCH that changed `rootPath` or globs.
	 *  - If the connector resolver returns `null` (RAG runtime disabled, EE
	 *    connectors missing): emits `rag.watch.upsert.unavailable` and returns.
	 *  - If the connector lacks a `watch` method: emits
	 *    `rag.watch.upsert.unsupported` and returns. This shouldn't happen for
	 *    `'local'` post-Phase 4 but stays defensive against future connectors.
	 */
	upsert(source: { id: string; type: string; configEncrypted: string }): void {
		// Always tear down any existing state so subsequent branches can return
		// cleanly without leaking watchers / timers.
		this.remove(source.id);

		if (source.type !== 'local') {
			return;
		}

		const connector = this.#deps.resolveConnector(source.type);
		if (!connector) {
			this.#deps.onAudit?.({
				type: 'rag.watch.upsert.unavailable',
				payload: { sourceId: source.id, type: source.type },
				timestamp: new Date().toISOString(),
			});
			return;
		}
		if (typeof connector.watch !== 'function') {
			this.#deps.onAudit?.({
				type: 'rag.watch.upsert.unsupported',
				payload: { sourceId: source.id, type: source.type },
				timestamp: new Date().toISOString(),
			});
			return;
		}

		let config: Record<string, unknown>;
		try {
			const plaintext = this.#deps.decryptConfig(source.configEncrypted);
			const parsed: unknown = JSON.parse(plaintext);
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new Error('config is not a JSON object');
			}
			config = parsed as Record<string, unknown>;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.onAudit?.({
				type: 'rag.watch.upsert.failed',
				payload: { sourceId: source.id, error: message },
				timestamp: new Date().toISOString(),
			});
			return;
		}

		let unsubscribe: Unsubscribe;
		try {
			unsubscribe = connector.watch(config, source.id, () => {
				this.#scheduleFlush(source.id);
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.onAudit?.({
				type: 'rag.watch.upsert.failed',
				payload: { sourceId: source.id, error: message },
				timestamp: new Date().toISOString(),
			});
			return;
		}

		this.#unsubscribers.set(source.id, unsubscribe);
		this.#deps.onAudit?.({
			type: 'rag.watch.upsert.ok',
			payload: { sourceId: source.id },
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Tear down the watcher (and any pending debounce) for a deleted source.
	 * Idempotent: a no-op when no watcher is registered for `sourceId`.
	 */
	remove(sourceId: string): void {
		const unsubscribe = this.#unsubscribers.get(sourceId);
		if (unsubscribe !== undefined) {
			try {
				unsubscribe();
			} catch {
				// Ignore — see `stop()` rationale.
			}
			this.#unsubscribers.delete(sourceId);
		}
		const pending = this.#pendingFlushes.get(sourceId);
		if (pending !== undefined) {
			clearTimeout(pending);
			this.#pendingFlushes.delete(sourceId);
		}
	}

	/** Test-only helper: list source ids with an active watcher. */
	active(): string[] {
		return Array.from(this.#unsubscribers.keys());
	}

	/**
	 * Internal: cancel any pending flush for `sourceId` and re-schedule one
	 * `debounceMs` from now. Each event resets the timer so a burst of N events
	 * within the window collapses into a single `flush()` call.
	 */
	#scheduleFlush(sourceId: string): void {
		const existing = this.#pendingFlushes.get(sourceId);
		if (existing !== undefined) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.#flush(sourceId);
		}, this.#debounceMs);
		this.#pendingFlushes.set(sourceId, timer);
	}

	/**
	 * Internal: invoked when the debounce window for `sourceId` closes without
	 * new events arriving. Calls `triggerSync` and surfaces the outcome via the
	 * audit hook.
	 *
	 * Errors from `triggerSync` are caught so a single bad flush can't crash
	 * the watcher; the next event re-schedules a fresh attempt.
	 */
	#flush(sourceId: string): void {
		this.#pendingFlushes.delete(sourceId);
		const timestamp = new Date().toISOString();
		try {
			const jobId = this.#deps.triggerSync(sourceId);
			if (jobId === null) {
				this.#deps.onAudit?.({
					type: 'rag.sync.watch.skipped',
					payload: { sourceId, reason: 'sync-already-active' },
					timestamp,
				});
				return;
			}
			this.#deps.onAudit?.({
				type: 'rag.sync.watch.triggered',
				payload: { sourceId, jobId },
				timestamp,
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.onAudit?.({
				type: 'rag.sync.watch.failed',
				payload: { sourceId, error: message },
				timestamp,
			});
		}
	}
}
