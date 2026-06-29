// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Database as BetterSqlite3Database } from 'better-sqlite3';

/**
 * Dependencies for the {@link SyncQueue}.
 *
 * `runJob` is the actual unit of work: it is invoked once per `(sourceId, jobId)`
 * pair the queue has decided to run. The implementation is responsible for all
 * persistence (updating `rag_jobs` row, writing audit entries, etc.) — the
 * queue itself is intentionally storage-agnostic.
 *
 * Errors thrown by `runJob` are caught by the worker so a single bad job never
 * stalls the queue. When `onError` is provided it is called with the error;
 * otherwise the worker swallows it silently. The job row in the DB MUST already
 * have been transitioned to `'failed'` by `runJob` before it throws — the queue
 * has no opinion on DB state.
 */
export interface SyncQueueDeps {
  /** The actual sync work. Called sequentially, one job at a time. */
  runJob: (sourceId: string, jobId: string) => Promise<void>;
  /** Optional hook for surfacing worker-level failures (e.g. logging). */
  onError?: (sourceId: string, jobId: string, err: unknown) => void;
}

/**
 * Single-process FIFO queue for RAG sync jobs.
 *
 * **Concurrency**: 1. Jobs run strictly sequentially. The reason for serializing
 * is that ingestion writes to `rag_documents`, `rag_chunks` and the sqlite-vec
 * virtual table; running two syncs against the same SQLite handle in parallel
 * would either lock or corrupt counters. We could go to N concurrent workers
 * across distinct sourceIds in a future iteration — for the MVP, "one at a
 * time, oldest first" is the simplest correct behavior.
 *
 * **Per-source dedupe**: a `sourceId` cannot appear twice in the queue at the
 * same time. {@link enqueue} returns `false` if the source already has a job
 * queued OR currently running. The route handler maps this to HTTP 409.
 *
 * **Persistence**: NONE. Jobs live only in memory. If the host process restarts
 * while a job is `'pending'` or `'running'` in the DB, those rows become
 * orphaned. Call {@link recoverOrphanedJobs} at boot to mark them `'failed'`.
 * A future iteration can promote the queue to a DB-backed work table (see
 * Phase 4.x roadmap) and resume `'pending'` jobs after restart — for now this
 * is documented as a known limitation.
 */
export class SyncQueue {
  #queue: Array<{ sourceId: string; jobId: string }> = [];
  #running: Set<string> = new Set();
  #worker: Promise<void> | null = null;
  readonly #deps: SyncQueueDeps;

  constructor(deps: SyncQueueDeps) {
    this.#deps = deps;
  }

  /**
   * Enqueue a job. Returns `false` (no-op) when a job for the same `sourceId`
   * is already running OR already queued. Returns `true` when the job was
   * accepted and the worker has been kicked.
   */
  enqueue(sourceId: string, jobId: string): boolean {
    if (this.#running.has(sourceId)) return false;
    if (this.#queue.some((j) => j.sourceId === sourceId)) return false;
    this.#queue.push({ sourceId, jobId });
    this.#kick();
    return true;
  }

  /**
   * Test-only helper: await full drain of the queue. Resolves once the worker
   * has nothing left to do. Does NOT prevent new enqueues during the drain;
   * if an enqueue happens while drain() is awaiting, the new job is included.
   */
  async drain(): Promise<void> {
    // If the worker is running, await it. After it resolves, more items may
    // have been added — loop until both queue and running are empty.
    while (this.#worker !== null || this.#queue.length > 0 || this.#running.size > 0) {
      if (this.#worker) await this.#worker;
      else this.#kick(); // queue non-empty but worker idle: kick and re-loop
    }
  }

  /** Number of jobs currently queued (not counting the one running). */
  size(): number {
    return this.#queue.length;
  }

  /** True when a job for this sourceId is currently being processed. */
  isRunning(sourceId: string): boolean {
    return this.#running.has(sourceId);
  }

  /**
   * Idempotent: starts the worker if it isn't running, otherwise no-op.
   * Internal — callers should use {@link enqueue}.
   *
   * The worker is started on the NEXT microtask (via `Promise.resolve()` in
   * `#run`), not synchronously, so that the route handler that called
   * `enqueue` can finish writing the HTTP 202 response BEFORE the job
   * transitions from `pending` to `running`. Without this deferral, the
   * handler would race the worker — by the time `res.json({...})` reads the
   * inserted row, `runSyncJob` would already have flipped the status, and
   * the client would see `running` instead of `pending` in the HTTP body.
   */
  #kick(): void {
    if (this.#worker !== null) return;
    if (this.#queue.length === 0) return;
    this.#worker = this.#run().finally(() => {
      this.#worker = null;
    });
  }

  async #run(): Promise<void> {
    // Yield once before doing any work. This lets the synchronous caller
    // of `enqueue` finish (e.g. the Express handler returning 202 with the
    // freshly inserted `pending` row) before we touch the DB.
    await Promise.resolve();
    while (this.#queue.length > 0) {
      const next = this.#queue.shift();
      if (!next) break;
      this.#running.add(next.sourceId);
      try {
        await this.#deps.runJob(next.sourceId, next.jobId);
      } catch (err: unknown) {
        if (this.#deps.onError) {
          try {
            this.#deps.onError(next.sourceId, next.jobId, err);
          } catch {
            // Swallow onError handler failures — never crash the worker.
          }
        }
      } finally {
        this.#running.delete(next.sourceId);
      }
    }
  }
}

/**
 * Mark every `pending` and `running` job in `rag_jobs` as `failed` with a
 * synthetic error message. Intended to be called once at server boot, BEFORE
 * any new jobs are accepted, to clean up jobs orphaned by a previous process
 * crashing or being killed mid-sync.
 *
 * Returns the number of rows updated (useful for boot logs).
 *
 * Phase 4.1 limitation: this is the simplest possible recovery strategy. A
 * future iteration may want to actually re-enqueue `pending` jobs (since they
 * never started) instead of failing them. We don't do that yet because:
 *   1. It requires distinguishing "pending because just inserted" from
 *      "pending because the previous process crashed before kicking the
 *      worker", which is non-trivial without a heartbeat.
 *   2. The user can always re-trigger a sync from the UI — the cost of the
 *      lost re-attempt is small.
 */
export function recoverOrphanedJobs(db: BetterSqlite3Database): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE rag_jobs
			 SET status = 'failed',
			     error = 'orphaned (server restart)',
			     finished_at = ?
			 WHERE status IN ('pending', 'running')`,
    )
    .run(now);
  return result.changes;
}
