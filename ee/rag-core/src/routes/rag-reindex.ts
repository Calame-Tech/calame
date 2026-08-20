// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Tenant-wide embedding-dimension migration — lets an existing install stuck
 * on one embedding dimension (e.g. 1536, from an OpenAI-compatible provider
 * configured before the bundled local model existed) switch to a DIFFERENT
 * dimension (e.g. 768, the local model) without the Phase 1 single-dimension
 * invariant (see rag-sources.ts) blocking it forever.
 *
 * This is a DESTRUCTIVE operation: every chunk and document for the tenant's
 * active sources is purged and re-ingested from scratch under the new
 * embedding setting. Sources themselves (their connector config, name,
 * polling interval) are preserved — only their indexed content is wiped and
 * rebuilt.
 *
 * Ordering is dictated by `resetVecTableIfDimensionMismatch`
 * (storage/sqlite-vec-store.ts), which refuses to drop `rag_chunks_vec`
 * while ANY `rag_chunks` row exists: purge must complete fully before the
 * vector table can be recreated at the new dimension. See the numbered
 * comments in `runReindex` below for the exact sequence.
 *
 * `rag_chunks_vec` is ONE global table, not per-tenant — a hard limitation
 * this endpoint cannot route around. If another tenant already holds chunks
 * at the CURRENT dimension, this tenant cannot switch dimensions until that
 * tenant's chunks are gone too (see the 409 precondition below).
 */

import type { Express, Request, Response } from 'express';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { RagRouteDeps } from './types.js';
import type { RagReindexJobPublic } from './api-types.js';
import { resetVecTableIfDimensionMismatch } from '../storage/sqlite-vec-store.js';

function resolveTenantId(deps: RagRouteDeps, req?: Request): string {
  return deps.getTenantId ? deps.getTenantId(req) : 'default';
}

function sendError(res: Response, status: number, message: string, code?: string): void {
  res.status(status).json({ error: message, ...(code ? { code } : {}) });
}

interface ReindexJobRow {
  id: string;
  tenant_id: string;
  status: string;
  phase: string;
  target_setting_name: string;
  target_dimension: number;
  previous_dimension: number | null;
  total_sources: number;
  processed_sources: number;
  total_documents: number;
  processed_documents: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

function rowToPublic(row: ReindexJobRow): RagReindexJobPublic {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status as RagReindexJobPublic['status'],
    phase: row.phase as RagReindexJobPublic['phase'],
    targetSettingName: row.target_setting_name,
    targetDimension: row.target_dimension,
    previousDimension: row.previous_dimension,
    totalSources: row.total_sources,
    processedSources: row.processed_sources,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * The dimension currently in use by this tenant's ACTIVE sources, or `null`
 * when it has none. Mirrors `getCurrentDimension` in rag-sources.ts (kept as
 * a separate local copy rather than exported/shared — both are small,
 * single-purpose queries scoped to their own route file, consistent with
 * this codebase's existing convention for these tiny per-route resolvers).
 */
function getCurrentDimensionForTenant(deps: RagRouteDeps, tenantId: string): number | null {
  const row = deps.db
    .prepare<[string], { embedding_dimensions: number }>(
      `SELECT embedding_dimensions FROM rag_sources
       WHERE embedding_dimensions > 0 AND deleted_at IS NULL AND tenant_id = ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(tenantId);
  return row ? row.embedding_dimensions : null;
}

/**
 * Purge every chunk/document/folder for ONE source, in its own transaction.
 * Idempotent — safe to re-run on a source that was already purged (the
 * queries simply match zero rows). Vector-store deletes happen OUTSIDE the
 * SQL transaction, mirroring the existing `DELETE /:id/permanent` handler in
 * rag-sources.ts — sqlite-vec writes through the same connection, so they
 * are not atomic with the surrounding transaction by default, and a
 * partially-wiped vector index is harmless here (the vec0 table gets
 * dropped and recreated wholesale in the next phase anyway).
 *
 * Deleting `rag_documents` (not just `rag_chunks`) is load-bearing, not
 * cosmetic: the pipeline's content-hash fast path (pipeline/ingest.ts) and
 * the sync route's etag fast path (routes/rag-index.ts) both key off
 * `rag_documents` rows to decide "already indexed, skip" — leaving them
 * behind after wiping only the chunks would make every subsequent sync
 * silently produce an EMPTY index.
 */
function purgeSource(deps: RagRouteDeps, sourceId: string): void {
  const docIds = deps.db
    .prepare<[string], { id: string }>(`SELECT id FROM rag_documents WHERE source_id = ?`)
    .all(sourceId);
  for (const doc of docIds) {
    try {
      deps.vectorStore.deleteByDocument(doc.id);
    } catch {
      // Same defensive swallow as rag-sources.ts's permanent-delete handler —
      // never let a vector-store error block the purge; the vec0 table is
      // dropped and rebuilt wholesale in the next phase regardless.
    }
  }
  const purge = deps.db.transaction((id: string) => {
    deps.db
      .prepare(
        `DELETE FROM rag_chunks WHERE document_id IN (SELECT id FROM rag_documents WHERE source_id = ?)`,
      )
      .run(id);
    deps.db.prepare(`DELETE FROM rag_documents WHERE source_id = ?`).run(id);
    deps.db.prepare(`DELETE FROM rag_folders WHERE source_id = ?`).run(id);
  });
  purge(sourceId);
}

/**
 * Register the dimension-migration routes.
 *  - POST /api/rag/reindex        — start (or resume) a migration for the caller's tenant.
 *  - GET  /api/rag/reindex/status — the tenant's most recent migration job, if any.
 */
export function registerRagReindexRoutes(app: Express, deps: RagRouteDeps): void {
  app.post('/api/rag/reindex', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { targetSettingName?: string; confirm?: boolean };
    if (!body.targetSettingName) {
      sendError(res, 400, 'targetSettingName is required.');
      return;
    }
    if (body.confirm !== true) {
      sendError(
        res,
        400,
        'This is a destructive operation: every indexed document for this tenant will be purged ' +
          're-ingested. Pass { confirm: true } to proceed.',
      );
      return;
    }

    const tenantId = resolveTenantId(deps, req);

    let targetDimension: number;
    try {
      targetDimension = deps.resolveEmbeddingSetting(body.targetSettingName).dimensions;
    } catch (error: unknown) {
      sendError(res, 400, error instanceof Error ? error.message : 'Unknown error');
      return;
    }

    const currentDimension = getCurrentDimensionForTenant(deps, tenantId);
    if (currentDimension === targetDimension) {
      res.json({ reindexed: false, message: 'Already at the target dimension.' });
      return;
    }

    // Hard precondition: rag_chunks_vec is ONE global table, not per-tenant.
    // If another tenant's chunks are still present, this tenant cannot
    // switch dimensions — resetVecTableIfDimensionMismatch would refuse the
    // drop regardless of how thoroughly THIS tenant is purged below.
    const otherTenantChunks = deps.db
      .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM rag_chunks WHERE tenant_id != ?`)
      .get(tenantId);
    if (otherTenantChunks && otherTenantChunks.n > 0) {
      sendError(
        res,
        409,
        `Cannot switch dimensions: ${otherTenantChunks.n} chunk(s) belonging to other tenants still ` +
          `exist in the shared vector index. This is a limitation of the current single vector-table ` +
          `architecture, not something this tenant's migration can resolve on its own.`,
        'other-tenants-have-chunks',
      );
      return;
    }

    const jobId = nanoid();
    const now = new Date().toISOString();
    const activeSources = deps.db
      .prepare<
        [string],
        { id: string }
      >(`SELECT id FROM rag_sources WHERE tenant_id = ? AND deleted_at IS NULL`)
      .all(tenantId);

    deps.db
      .prepare(
        `INSERT INTO rag_reindex_jobs
         (id, tenant_id, status, phase, target_setting_name, target_dimension,
          previous_dimension, total_sources, processed_sources, started_at)
         VALUES (?, ?, 'running', 'purging', ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        jobId,
        tenantId,
        body.targetSettingName,
        targetDimension,
        currentDimension,
        activeSources.length,
        now,
      );

    deps.onAudit?.({
      type: 'rag.reindex.started',
      payload: {
        jobId,
        tenantId,
        targetSettingName: body.targetSettingName,
        targetDimension,
        currentDimension,
      },
      timestamp: now,
    });

    try {
      // Step 4: purge every active source, one transaction each. Idempotent,
      // so an interrupted run can safely be POSTed again from scratch.
      let processed = 0;
      for (const source of activeSources) {
        purgeSource(deps, source.id);
        processed++;
        deps.db
          .prepare(`UPDATE rag_reindex_jobs SET processed_sources = ? WHERE id = ?`)
          .run(processed, jobId);
      }

      // Step 5: repoint every active source at the target setting BEFORE
      // rebuilding the vec table, so a crash between here and the restart
      // still leaves sources correctly configured for a manual re-sync.
      const targetSetting = deps.resolveEmbeddingSetting(body.targetSettingName);
      deps.db
        .prepare(
          `UPDATE rag_sources
           SET embedding_setting_name = ?, embedding_model_version = ?, embedding_dimensions = ?
           WHERE tenant_id = ? AND deleted_at IS NULL`,
        )
        .run(
          body.targetSettingName,
          targetSetting.embeddingModel,
          targetSetting.dimensions,
          tenantId,
        );

      deps.db
        .prepare(`UPDATE rag_reindex_jobs SET phase = 'rebuilding-index' WHERE id = ?`)
        .run(jobId);

      // Step 6: drop + recreate rag_chunks_vec at the new dimension. Refuses
      // (chunks-present) if the purge above missed rows — abort rather than
      // silently leaving the table at the old dimension.
      const resetResult = resetVecTableIfDimensionMismatch(deps.db, targetDimension);
      if (!resetResult.reset && resetResult.reason === 'chunks-present') {
        const message =
          `Vector table still reports ${resetResult.chunkCount} chunk(s) after purging every ` +
          `active source — the migration cannot proceed safely. This should not happen; please report it.`;
        deps.db
          .prepare(
            `UPDATE rag_reindex_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
          )
          .run(message, new Date().toISOString(), jobId);
        deps.onAudit?.({
          type: 'rag.reindex.failed',
          payload: { jobId, tenantId, error: message },
          timestamp: new Date().toISOString(),
        });
        sendError(res, 500, message);
        return;
      }

      // Step 7: no hot-swap — routes/pipeline hold references captured at
      // registration time (see app.ts), so the process must restart before
      // the new vector store instance and dimension take effect everywhere.
      const finishedAt = new Date().toISOString();
      deps.db
        .prepare(
          `UPDATE rag_reindex_jobs SET status = 'awaiting-restart', phase = 'awaiting-restart' WHERE id = ?`,
        )
        .run(jobId);
      deps.onAudit?.({
        type: 'rag.reindex.awaiting_restart',
        payload: { jobId, tenantId, targetDimension },
        timestamp: finishedAt,
      });

      const job = deps.db
        .prepare<[string], ReindexJobRow>(`SELECT * FROM rag_reindex_jobs WHERE id = ?`)
        .get(jobId);
      res.json({ reindexed: true, requiresRestart: true, job: job ? rowToPublic(job) : null });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      deps.db
        .prepare(
          `UPDATE rag_reindex_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
        )
        .run(message, new Date().toISOString(), jobId);
      deps.onAudit?.({
        type: 'rag.reindex.failed',
        payload: { jobId, tenantId, error: message },
        timestamp: new Date().toISOString(),
      });
      sendError(res, 500, message);
    }
  });

  app.get('/api/rag/reindex/status', (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(deps, req);
      const row = deps.db
        .prepare<
          [string],
          ReindexJobRow
        >(`SELECT * FROM rag_reindex_jobs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT 1`)
        .get(tenantId);
      res.json({ job: row ? rowToPublic(row) : null });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      sendError(res, 500, message);
    }
  });
}

/**
 * Boot-time recovery + resumption for dimension-migration jobs. Called once
 * from `initRagRuntime` (packages/cli/src/rag-runtime.ts) after
 * `initVectorStore` has resolved the LIVE vec0 dimension for this boot —
 * mirrors `recoverOrphanedJobs` (jobs/sync-queue.ts) for the same "server
 * restarted mid-operation" scenario, applied to `rag_reindex_jobs` instead
 * of `rag_jobs`.
 *
 * Two responsibilities:
 *  1. Recovery — any job still `'running'` means the process crashed or was
 *     killed mid-purge. Marked `failed` with an actionable message; safe
 *     because `purgeSource` is idempotent, so re-POSTing the same migration
 *     picks up wherever it left off.
 *  2. Resumption — any job `'awaiting-restart'` whose `target_dimension`
 *     matches the dimension this boot actually initialized the vec0 table
 *     at (confirming the restart-and-rebuild from the POST handler above
 *     succeeded) triggers a re-sync for every active source in that job's
 *     tenant, via the SAME `triggerSync` lambda the poll scheduler and
 *     watch manager share (see rag-runtime.ts).
 *
 * Deliberately does NOT track "every triggered re-sync has finished" before
 * marking the reindex job `completed` — `SyncQueue` exposes no completion
 * callback for that, and building one for this one-shot admin operation
 * isn't worth the complexity. Once every re-sync is triggered, the
 * orchestration's job is done; each sync's own progress is already visible
 * through the normal `GET /api/rag/jobs` history, same as any manual sync.
 */
export function resumeReindexJobs(
  db: BetterSqlite3Database,
  liveDimension: number,
  triggerSync: (sourceId: string) => string | null,
  log?: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  const now = new Date().toISOString();

  const orphaned = db
    .prepare(
      `UPDATE rag_reindex_jobs
       SET status = 'failed', error = ?, finished_at = ?
       WHERE status = 'running'`,
    )
    .run('Interrupted by a server restart — re-run the migration.', now);
  if (orphaned.changes > 0) {
    log?.warn(
      `RAG reindex: marked ${orphaned.changes} orphaned job(s) as failed (server restart recovery).`,
    );
  }

  const pending = db
    .prepare<
      [number],
      ReindexJobRow
    >(`SELECT * FROM rag_reindex_jobs WHERE status = 'awaiting-restart' AND target_dimension = ?`)
    .all(liveDimension);

  for (const job of pending) {
    db.prepare(
      `UPDATE rag_reindex_jobs SET status = 'resyncing', phase = 'resyncing' WHERE id = ?`,
    ).run(job.id);

    const sources = db
      .prepare<
        [string],
        { id: string }
      >(`SELECT id FROM rag_sources WHERE tenant_id = ? AND deleted_at IS NULL`)
      .all(job.tenant_id);

    let triggered = 0;
    for (const source of sources) {
      if (triggerSync(source.id) !== null) triggered++;
    }

    db.prepare(
      `UPDATE rag_reindex_jobs SET status = 'completed', finished_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), job.id);
    log?.info(
      `RAG reindex: resumed job ${job.id} after restart — triggered re-sync for ${triggered}/${sources.length} source(s).`,
    );
  }
}
