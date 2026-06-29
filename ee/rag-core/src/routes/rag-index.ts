// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Express, Request, Response } from 'express';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { RagFolder, RagJob, RagJobStatus, RagSource, RagSourceType } from '../types.js';
import type { ConnectorLike, RagRouteDeps } from './types.js';
import { EmbeddingCapExceededError } from '../jobs/embedding-cap.js';
import { UnsupportedMimeTypeError } from '../parsers/index.js';

/**
 * Resolve the tenant id for a request, falling back to the literal
 * `'default'` when the host hasn't wired a resolver (e.g. test deps).
 */
function resolveTenantId(deps: RagRouteDeps, req?: Request): string {
  return deps.getTenantId ? deps.getTenantId(req) : 'default';
}

interface SourceRow {
  id: string;
  name: string;
  type: string;
  config_encrypted: string;
  embedding_setting_name: string;
  embedding_model_version: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
  last_sync_at: string | null;
  /** Phase 12 (Q7) soft-delete marker — non-null sources are off-limits to sync. */
  deleted_at: string | null;
}

interface JobRow {
  id: string;
  source_id: string;
  status: string;
  progress: number;
  total_documents: number;
  processed_documents: number;
  skipped_by_etag: number;
  gc_deleted: number;
  tokens_embedded: number | null;
  error: string | null;
  tenant_id: string;
  started_at: string;
  finished_at: string | null;
}

/**
 * Mini shape used by the etag fast-path. Intentionally NOT reusing
 * `DocumentRow` from `pipeline/ingest.ts` (private to the pipeline) — only the
 * columns we need to decide whether to skip a fetch.
 */
interface ExistingDocLookupRow {
  id: string;
  etag: string | null;
  deleted_at: string | null;
  ingest_error: string | null;
}

function rowToSource(row: SourceRow): RagSource {
  return {
    id: row.id,
    name: row.name,
    type: row.type as RagSourceType,
    configEncrypted: row.config_encrypted,
    embeddingSettingName: row.embedding_setting_name,
    embeddingModelVersion: row.embedding_model_version,
    // Defensive `?? 'default'` for fixtures that hand-roll rows without
    // going through `runRagMigrations` — projections lands as undefined
    // at runtime when the column isn't present.
    tenantId: row.tenant_id ?? 'default',
    // Normalize undefined → null for fixtures that bypass the v8 migration.
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_sync_at !== null ? { lastSyncAt: row.last_sync_at } : {}),
  };
}

function rowToJob(row: JobRow): RagJob {
  return {
    id: row.id,
    sourceId: row.source_id,
    status: row.status as RagJobStatus,
    progress: row.progress,
    totalDocuments: row.total_documents,
    processedDocuments: row.processed_documents,
    skippedByEtag: row.skipped_by_etag,
    gcDeleted: row.gc_deleted,
    // Defensive `?? 0` for fixtures or pre-v7 rows that bypass the migration.
    tokensEmbedded: row.tokens_embedded ?? 0,
    error: row.error,
    tenantId: row.tenant_id ?? 'default',
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/** Read all bytes from a Node Readable stream into a single Buffer. */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/**
 * Look up the indexed copy of a document by `(source_id, path)`. Returns the
 * minimal shape required by the etag fast-path: the id, the previously
 * recorded etag and the soft-delete marker. Returns `null` when no row exists.
 */
function lookupExistingDoc(
  db: BetterSqlite3Database,
  sourceId: string,
  path: string,
): { etag: string | null; deletedAt: string | null; ingestError: string | null } | null {
  const row = db
    .prepare<
      [string, string],
      ExistingDocLookupRow
    >(`SELECT id, etag, deleted_at, ingest_error FROM rag_documents WHERE source_id = ? AND path = ?`)
    .get(sourceId, path);
  if (!row) return null;
  return { etag: row.etag, deletedAt: row.deleted_at, ingestError: row.ingest_error };
}

/** Recursively walk a connector to enumerate every document under a source. */
async function walkConnector(
  connector: ConnectorLike,
  config: Record<string, unknown>,
  sourceId: string,
  tenantId: string,
  db: BetterSqlite3Database,
): Promise<
  Array<{
    doc: Awaited<ReturnType<ConnectorLike['listDocuments']>>[number];
    folder: RagFolder | null;
  }>
> {
  const out: Array<{
    doc: Awaited<ReturnType<ConnectorLike['listDocuments']>>[number];
    folder: RagFolder | null;
  }> = [];

  // Prepared once and reused across all recursive `visit` calls. INSERT OR
  // IGNORE makes this idempotent: folder ids are stable per connector, so
  // re-syncs that re-encounter the same folder are a no-op. The row MUST be
  // present before `ingestDocument` writes a `rag_documents` row that carries
  // `folder_id` — the foreign key constraint requires it.
  const insertFolder = db.prepare(
    `INSERT OR IGNORE INTO rag_folders (id, source_id, parent_id, path, name, tenant_id)
		 VALUES (?, ?, ?, ?, ?, ?)`,
  );

  async function visit(folder: RagFolder | undefined): Promise<void> {
    const folderArg = folder ? { id: folder.id, path: folder.path } : undefined;
    const docs = await connector.listDocuments(config, sourceId, folderArg);
    for (const d of docs) {
      out.push({ doc: d, folder: folder ?? null });
    }
    const subfolders = await connector.listFolders(config, sourceId, folderArg);
    for (const sf of subfolders) {
      // Persist BEFORE recursing/ingesting docs — the foreign key on
      // rag_documents.folder_id requires this row to exist. INSERT OR IGNORE
      // makes this idempotent across re-syncs (folder ids are stable per
      // connector and act as a natural upsert key).
      insertFolder.run(sf.id, sourceId, folder?.id ?? null, sf.path, sf.name, tenantId);
      // Connectors don't know about tenancy; the folder inherits the
      // parent source's tenant. This keeps the pipeline downstream from
      // having to defensively check `?? 'default'` at every consumer.
      await visit({ ...sf, tenantId });
    }
  }

  await visit(undefined);
  return out;
}

/**
 * Truncate a message string to `maxLen` characters, appending an ellipsis
 * when truncation occurs. Null-safe: returns '' for null input.
 */
function truncateMessage(msg: string | null, maxLen: number): string {
  if (msg === null) return '';
  if (msg.length <= maxLen) return msg;
  return msg.slice(0, maxLen - 1) + '…';
}

/**
 * Read the maximum number of consecutive per-document failures before the
 * sync worker aborts the job early. Sourced from the
 * `CALAME_RAG_SYNC_MAX_CONSECUTIVE_FAILURES` environment variable.
 *
 * - Default: 5
 * - Set to 0 to disable the circuit-breaker entirely.
 */
function readMaxConsecutiveFailures(): number {
  const raw = process.env['CALAME_RAG_SYNC_MAX_CONSECUTIVE_FAILURES'];
  if (raw === undefined) return 5;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 5;
  return parsed;
}

/**
 * Per-document hard timeout in milliseconds. Reads `CALAME_RAG_DOC_TIMEOUT_MS`
 * (default 300_000 = 5 min). Set to 0 or negative to disable (NOT recommended
 * — a hung parser will freeze the worker indefinitely). NaN falls back to the
 * default.
 *
 * This is a *soft* timeout: the underlying promise (e.g. mammoth parser, HTTP
 * fetch without an AbortSignal) is not actively cancelled — Promise.race only
 * lets us continue past it. The leaked promise resolves or rejects later and
 * its result is discarded. Acceptable trade-off for unblocking the sync.
 */
function readDocTimeoutMs(): number {
  const raw = process.env['CALAME_RAG_DOC_TIMEOUT_MS'];
  if (raw === undefined) return 300_000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 300_000;
  return parsed;
}

/**
 * Race a promise against a timer; reject with a labelled error if the timer
 * fires first. The original promise is left to settle on its own (its result
 * is discarded) — there is no AbortSignal threaded through the ingest
 * pipeline, so this is a best-effort safety net rather than a real cancel.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Execute a sync job end-to-end against a source. The job row MUST already
 * exist in `rag_jobs` (status `'pending'`); this function transitions it to
 * `'running'`, walks the connector, ingests / skips / GCs documents, and
 * finally writes the terminal state (`'completed'` | `'failed'`).
 *
 * Never throws — failures are persisted on the job row and reported via the
 * audit hook. Designed to be called from a background worker (see
 * {@link SyncQueue}); callers MUST NOT use the return value to decide HTTP
 * status, since by the time this resolves the HTTP 202 has already been sent.
 *
 * Tests can call this directly to drive the full sync pipeline against a fake
 * connector + pipeline.
 */
export async function runSyncJob(
  deps: RagRouteDeps,
  sourceId: string,
  jobId: string,
): Promise<void> {
  try {
    const row = deps.db
      .prepare<[string], SourceRow>(`SELECT * FROM rag_sources WHERE id = ?`)
      .get(sourceId);
    if (!row) {
      // Source vanished between enqueue and worker pick-up. Mark the job
      // failed and bail.
      deps.db
        .prepare(`UPDATE rag_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(`Source "${sourceId}" not found.`, new Date().toISOString(), jobId);
      deps.onAudit?.({
        type: 'rag.sync.failed',
        payload: { sourceId, jobId, error: 'source not found' },
        timestamp: new Date().toISOString(),
      });
      return;
    }
    // Source was soft-deleted between enqueue and worker pick-up. Treat the
    // same as "vanished" — mark the job failed and bail without touching
    // the source's stale documents. The cleanup cron will hard-delete the
    // source (and this job row) once the retention window expires.
    if (row.deleted_at !== null) {
      deps.db
        .prepare(`UPDATE rag_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(
          `Source "${sourceId}" was deleted while the job was queued.`,
          new Date().toISOString(),
          jobId,
        );
      deps.onAudit?.({
        type: 'rag.sync.failed',
        payload: { sourceId, jobId, error: 'source soft-deleted' },
        timestamp: new Date().toISOString(),
      });
      return;
    }
    const source = rowToSource(row);

    const connector = deps.resolveConnector?.(source.type);
    if (!connector) {
      const msg =
        `Connector for source type "${source.type}" is not installed. ` +
        `Install @calame-ee/rag-connectors or wait until the connector lands.`;
      deps.db
        .prepare(`UPDATE rag_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(msg, new Date().toISOString(), jobId);
      deps.onAudit?.({
        type: 'rag.sync.failed',
        payload: { sourceId, jobId, error: msg },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(deps.decryptConfig(row.config_encrypted)) as Record<string, unknown>;
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      deps.db
        .prepare(`UPDATE rag_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(`Failed to decrypt source configuration: ${m}`, new Date().toISOString(), jobId);
      deps.onAudit?.({
        type: 'rag.sync.failed',
        payload: { sourceId, jobId, error: m },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Transition pending → running. We do this once we have all the inputs
    // we need; if the source / connector / config lookup failed above we
    // leave the row at its terminal `failed` state without ever flipping to
    // running, which keeps the UI accurate.
    const startedAt = new Date().toISOString();
    deps.db
      .prepare(`UPDATE rag_jobs SET status = 'running', started_at = ? WHERE id = ?`)
      .run(startedAt, jobId);

    deps.onAudit?.({
      type: 'rag.sync.started',
      payload: { sourceId, jobId },
      timestamp: startedAt,
    });

    let entries: Awaited<ReturnType<typeof walkConnector>>;
    try {
      entries = await walkConnector(connector, config, source.id, source.tenantId, deps.db);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      deps.db
        .prepare(`UPDATE rag_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(m, new Date().toISOString(), jobId);
      deps.onAudit?.({
        type: 'rag.sync.failed',
        payload: { sourceId, jobId, error: m },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    deps.db
      .prepare(`UPDATE rag_jobs SET total_documents = ? WHERE id = ?`)
      .run(entries.length, jobId);

    let processed = 0;
    let failures = 0;
    let skippedByEtag = 0;
    let skippedUnsupported = 0;
    let gcDeleted = 0;
    // Accumulated sum of chunk.tokenCount across every document that was
    // actually embedded by this job. Fast-path (hash-match) docs do not
    // contribute — the pipeline's `onTokensEmbedded` hook only fires after
    // a successful re-embed. Persisted in a single UPDATE at the end of
    // the job so the usage endpoint can aggregate per source / period.
    let tokensEmbeddedThisJob = 0;
    let lastError: string | null = null;
    // Sticky flag set when ANY per-document error was an
    // EmbeddingCapExceededError. Surfaced in the terminal audit event
    // (`payload.reason = 'cap_exceeded'`) so operators can filter the
    // audit log without re-parsing the error string. We bubble out of
    // the per-document loop on the first hit since every subsequent doc
    // would observe the same condition.
    let capExceeded = false;
    // Circuit-breaker: abort the loop after this many consecutive failures.
    // 0 disables the breaker entirely. Sourced from
    // CALAME_RAG_SYNC_MAX_CONSECUTIVE_FAILURES (default 5).
    const maxConsecutiveFailures = readMaxConsecutiveFailures();
    let consecutiveFailures = 0;
    let circuitBroken = false;
    let entryIndex = 0;
    for (const { doc, folder } of entries) {
      deps.logger?.info(
        `[rag-sync] ingesting doc ${entryIndex + 1}/${entries.length}: ${doc.path}`,
        { component: `rag-sync/${source.id}` },
      );
      try {
        // Etag pre-fetch fast-path: if the connector reports a non-empty
        // etag and our indexed copy has the same etag (and is not
        // soft-deleted), skip both the network fetch and the ingest.
        // Without this, the pipeline only short-circuits on sha256
        // AFTER the buffer has been fetched — wasteful for S3/HTTP.
        const docEtag = doc.etag ?? null;
        if (docEtag !== null && docEtag !== '') {
          const existing = lookupExistingDoc(deps.db, source.id, doc.path);
          if (
            existing !== null &&
            existing.deletedAt === null &&
            existing.etag === docEtag &&
            // Don't skip docs that previously failed to ingest — we want to
            // retry them every sync in case a parser was added for the
            // format. On success the pipeline clears `ingest_error`; on
            // repeated failure the markDocumentUnsupported path
            // re-writes the same row, costing only the parser call.
            existing.ingestError === null
          ) {
            skippedByEtag++;
            processed++;
            consecutiveFailures = 0; // etag-skip is not a failure
            deps.logger?.info(`[rag-sync] etag-skip ${doc.path}`, {
              component: `rag-sync/${source.id}`,
            });
            const errorSummary =
              failures > 0
                ? `${failures}/${processed} failed so far; last: ${truncateMessage(lastError, 200)}`
                : null;
            deps.db
              .prepare(
                `UPDATE rag_jobs SET processed_documents = ?, progress = ?, skipped_by_etag = ?, error = ? WHERE id = ?`,
              )
              .run(
                processed,
                entries.length === 0 ? 1 : processed / entries.length,
                skippedByEtag,
                errorSummary,
                jobId,
              );
            entryIndex++;
            continue;
          }
        }

        const docTimeoutMs = readDocTimeoutMs();
        deps.logger?.info(`[rag-sync] fetch ${doc.path}`, {
          component: `rag-sync/${source.id}`,
        });
        // Hoisted so the catch block below can read them when handling
        // UnsupportedMimeTypeError (so we can still persist the file
        // metadata to the tree view).
        let fetched: { stream: NodeJS.ReadableStream; mimeType: string } | null = null;
        let buffer: Buffer | null = null;
        fetched = await withTimeout(
          connector.fetchDocument(config, source.id, doc.id),
          docTimeoutMs,
          `fetchDocument(${doc.path})`,
        );
        deps.logger?.info(`[rag-sync] buffer ${doc.path}`, {
          component: `rag-sync/${source.id}`,
        });
        buffer = await withTimeout(
          streamToBuffer(fetched.stream),
          docTimeoutMs,
          `streamToBuffer(${doc.path})`,
        );
        deps.logger?.info(
          `[rag-sync] ingest ${doc.path} (${buffer.byteLength} bytes, ${fetched.mimeType})`,
          { component: `rag-sync/${source.id}` },
        );
        try {
          await withTimeout(
            deps.pipeline.ingestDocument({
              source,
              folder,
              path: doc.path,
              mimeType: fetched.mimeType,
              buffer,
              etag: docEtag,
              // Per-job override of the pipeline-level hook so this counter
              // stays scoped to the current sync. The pipeline only fires
              // the hook on actual re-embeds (skipped fast-path → no fire).
              onTokensEmbedded: (count: number) => {
                tokensEmbeddedThisJob += count;
              },
            }),
            docTimeoutMs,
            `ingestDocument(${doc.path})`,
          );
        } catch (ingestErr: unknown) {
          if (ingestErr instanceof UnsupportedMimeTypeError) {
            // Persist a metadata-only row so the file appears in the
            // tree view with a "Format non supporté" badge. We do this
            // inside the inner try/catch so the outer `fetched`/`buffer`
            // are still in scope.
            deps.pipeline.markDocumentUnsupported(
              {
                source,
                folder,
                path: doc.path,
                mimeType: fetched.mimeType,
                buffer,
                etag: docEtag,
              },
              ingestErr.message,
            );
          }
          throw ingestErr;
        }
        deps.logger?.info(`[rag-sync] OK ${doc.path}`, { component: `rag-sync/${source.id}` });
        consecutiveFailures = 0;
      } catch (err: unknown) {
        if (err instanceof UnsupportedMimeTypeError) {
          skippedUnsupported++;
          consecutiveFailures = 0; // reset — this isn't a failure of the embedding pipeline
          deps.logger?.info(`[rag-sync] SKIPPED (unsupported MIME) ${doc.path}: ${err.message}`, {
            component: `rag-sync/${source.id}`,
          });
        } else {
          const errMsg = err instanceof Error ? err.message : String(err);
          failures++;
          lastError = errMsg;
          deps.logger?.warn(`[rag-sync] FAILED ${doc.path}: ${errMsg}`, {
            component: `rag-sync/${source.id}`,
          });
          if (err instanceof EmbeddingCapExceededError) {
            // The cap is process-wide and tenant-scoped — no point
            // continuing to walk remaining documents in this job
            // since every one will hit the same gate. Bail early
            // with the flag set so the terminal audit event can
            // report `reason: 'cap_exceeded'`.
            capExceeded = true;
            processed++;
            const errorSummary = `${failures}/${processed} failed so far; last: ${truncateMessage(lastError, 200)}`;
            deps.db
              .prepare(
                `UPDATE rag_jobs SET processed_documents = ?, progress = ?, skipped_by_etag = ?, error = ? WHERE id = ?`,
              )
              .run(
                processed,
                entries.length === 0 ? 1 : processed / entries.length,
                skippedByEtag,
                errorSummary,
                jobId,
              );
            break;
          }
          consecutiveFailures++;
          if (maxConsecutiveFailures > 0 && consecutiveFailures >= maxConsecutiveFailures) {
            circuitBroken = true;
            lastError = `Aborted after ${maxConsecutiveFailures} consecutive failures. Last error: ${lastError}`;
            processed++;
            const errorSummary = `${failures}/${processed} failed so far; last: ${truncateMessage(lastError, 200)}`;
            deps.db
              .prepare(
                `UPDATE rag_jobs SET processed_documents = ?, progress = ?, skipped_by_etag = ?, error = ? WHERE id = ?`,
              )
              .run(
                processed,
                entries.length === 0 ? 1 : processed / entries.length,
                skippedByEtag,
                errorSummary,
                jobId,
              );
            break;
          }
        }
      }
      processed++;
      const errorSummary =
        failures > 0
          ? `${failures}/${processed} failed so far; last: ${truncateMessage(lastError, 200)}`
          : skippedUnsupported > 0
            ? `${skippedUnsupported} doc(s) skipped (unsupported format)`
            : null;
      deps.db
        .prepare(
          `UPDATE rag_jobs SET processed_documents = ?, progress = ?, skipped_by_etag = ?, error = ? WHERE id = ?`,
        )
        .run(
          processed,
          entries.length === 0 ? 1 : processed / entries.length,
          skippedByEtag,
          errorSummary,
          jobId,
        );
      entryIndex++;
    }

    // GC pass: any document tracked under this source whose path is no
    // longer reported by the connector listing is treated as removed at
    // the source and soft-deleted. We do this UNCONDITIONALLY for the
    // MVP because `walkConnector` either returns a complete listing or
    // throws (which is handled above and aborts the sync before this
    // point). Limitation: if we ever add support for partial walks
    // (e.g. continue-on-folder-error), this GC must become conditional
    // on "the listing is known to be complete" — otherwise an outage on
    // a single subfolder would soft-delete every doc under it.
    //
    // Cap-aborted and circuit-broken runs ALSO skip the GC pass: the document
    // loop was cut short, so docs we never reached would be wrongly flagged
    // as removed. Skipping the pass preserves their indexed state until the
    // next sync.
    interface IndexedDocRow {
      id: string;
      path: string;
    }
    if (!capExceeded && !circuitBroken) {
      const indexedRows = deps.db
        .prepare<
          [string],
          IndexedDocRow
        >(`SELECT id, path FROM rag_documents WHERE source_id = ? AND deleted_at IS NULL`)
        .all(source.id);
      const seenPaths = new Set(entries.map((e) => e.doc.path));
      for (const row of indexedRows) {
        if (!seenPaths.has(row.path)) {
          try {
            deps.pipeline.markDocumentDeleted(row.id);
            gcDeleted++;
          } catch (err: unknown) {
            failures++;
            lastError = err instanceof Error ? err.message : String(err);
          }
        }
      }
    }

    const finalStatus: RagJobStatus = failures === 0 ? 'completed' : 'failed';
    const finishedAt = new Date().toISOString();
    deps.db
      .prepare(
        `UPDATE rag_jobs
				 SET status = ?, finished_at = ?, error = ?, progress = 1,
				     skipped_by_etag = ?, gc_deleted = ?, tokens_embedded = ?
				 WHERE id = ?`,
      )
      .run(
        finalStatus,
        finishedAt,
        failures > 0
          ? `${failures}/${entries.length} failed; last: ${lastError}`
          : skippedUnsupported > 0
            ? `${skippedUnsupported} doc(s) skipped — unsupported format. Convert to PDF/DOCX/MD/TXT or wait for native support.`
            : null,
        skippedByEtag,
        gcDeleted,
        tokensEmbeddedThisJob,
        jobId,
      );
    deps.db
      .prepare(`UPDATE rag_sources SET last_sync_at = ? WHERE id = ?`)
      .run(finishedAt, sourceId);

    // When the cap kill-switch or circuit-breaker fired we report
    // `rag.sync.failed` regardless of how many docs landed before the gate.
    // `payload.reason` lets the audit log be filtered without re-parsing the
    // error string downstream.
    const terminalType =
      capExceeded || circuitBroken
        ? 'rag.sync.failed'
        : failures === 0
          ? 'rag.sync.completed'
          : 'rag.sync.partial';
    const terminalPayload: Record<string, unknown> = {
      sourceId,
      jobId,
      total: entries.length,
      processed,
      skippedByEtag,
      skippedUnsupported,
      gcDeleted,
      failures,
      tokensEmbedded: tokensEmbeddedThisJob,
    };
    if (capExceeded) terminalPayload['reason'] = 'cap_exceeded';
    if (circuitBroken) terminalPayload['reason'] = 'consecutive_failures';
    deps.onAudit?.({
      type: terminalType,
      payload: terminalPayload,
      timestamp: finishedAt,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    deps.db
      .prepare(`UPDATE rag_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
      .run(message, new Date().toISOString(), jobId);
    deps.onAudit?.({
      type: 'rag.sync.failed',
      payload: { sourceId, jobId, error: message },
      timestamp: new Date().toISOString(),
    });
  }
}

/** Valid terminal + transient job statuses, used to validate `?status=` query values. */
const VALID_JOB_STATUSES: ReadonlySet<RagJobStatus> = new Set([
  'pending',
  'running',
  'completed',
  'failed',
]);

/**
 * Parse the `?status=` query value into a concrete list of `RagJobStatus`
 * values, applying the synthetic `active` alias (`pending` + `running`).
 *
 * Rules:
 *  - Accepts a single value (`?status=active`) or a CSV (`?status=pending,running`).
 *  - The `active` token expands to `['pending', 'running']`.
 *  - Unknown tokens are silently dropped (defensive — never crash on bad input).
 *  - If EVERY token is invalid the function returns `[]`, signalling "no filter
 *    on status" rather than "match nothing" (so an `?status=garbage` query
 *    still returns all jobs).
 *  - Returns deduplicated values to avoid `IN ('pending','pending')` noise.
 */
function parseStatusFilter(raw: unknown): RagJobStatus[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const out = new Set<RagJobStatus>();
  for (const token of raw.split(',')) {
    const t = token.trim().toLowerCase();
    if (t === 'active') {
      out.add('pending');
      out.add('running');
      continue;
    }
    if ((VALID_JOB_STATUSES as ReadonlySet<string>).has(t)) {
      out.add(t as RagJobStatus);
    }
  }
  return Array.from(out);
}

/** Clamp `?limit=` to the allowed [1, 200] window with a default of 50. */
function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0) return 50;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 50;
  if (n < 1) return 1;
  if (n > 200) return 200;
  return n;
}

/**
 * Routes:
 *  - POST /api/rag/sources/:id/sync — enqueue a background sync. Returns 202
 *    with the freshly inserted (pending) job. The actual work runs on the
 *    queue's single worker; clients poll /api/rag/jobs to track progress.
 *  - GET  /api/rag/jobs              — list recent jobs, newest first.
 *    Query string:
 *      - sourceId=X            — restrict to a single source.
 *      - status=active         — alias for pending+running.
 *      - status=completed      — only completed.
 *      - status=failed         — only failed.
 *      - status=pending,running (CSV) — any of the listed statuses.
 *      - limit=N               — 1..200, default 50.
 *    Unknown status tokens are dropped silently; the route never 400s on bad
 *    query input.
 */
export function registerRagIndexRoutes(app: Express, deps: RagRouteDeps): void {
  app.get('/api/rag/jobs', (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(deps, req);
      const sourceId = req.query['sourceId'];
      const statusList = parseStatusFilter(req.query['status']);
      const limit = parseLimit(req.query['limit']);

      // Build the WHERE clause dynamically with parameterized values — never
      // concatenate user input into the SQL string. `where` and `params`
      // stay in lock-step so the placeholders line up with the bindings.
      //
      // The JOIN + `s.deleted_at IS NULL` filter hides jobs for soft-deleted
      // sources from the history panel. `OR s.id IS NULL` covers the rare
      // race where a job row outlived its source — keeps the row visible
      // rather than silently dropping it.
      //
      // Phase B multi-tenancy: `j.tenant_id = ?` filters at the job row
      // level (every job inherits its tenant from the parent source at
      // INSERT time), so even orphan jobs whose source row vanished
      // stay scoped to the caller's tenant.
      const where: string[] = ['(s.id IS NULL OR s.deleted_at IS NULL)', 'j.tenant_id = ?'];
      const params: unknown[] = [tenantId];
      if (typeof sourceId === 'string' && sourceId.length > 0) {
        where.push('j.source_id = ?');
        params.push(sourceId);
      }
      if (statusList.length > 0) {
        where.push(`j.status IN (${statusList.map(() => '?').join(',')})`);
        params.push(...statusList);
      }

      const whereClause = `WHERE ${where.join(' AND ')}`;
      const sql = `SELECT j.* FROM rag_jobs j LEFT JOIN rag_sources s ON s.id = j.source_id ${whereClause} ORDER BY j.started_at DESC LIMIT ?`;
      params.push(limit);

      const rows = deps.db.prepare<unknown[], JobRow>(sql).all(...params);
      res.json({ jobs: rows.map(rowToJob) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      sendError(res, 500, message);
    }
  });

  app.post('/api/rag/sources/:id/sync', (req: Request, res: Response) => {
    const id = String(req.params['id'] ?? '');
    try {
      const tenantId = resolveTenantId(deps, req);
      // 1. Source must exist within the caller's tenant — otherwise 404.
      //    Soft-deleted sources are treated the same as missing: restore
      //    first if you want to re-trigger a sync. Cross-tenant ids also
      //    resolve as 404 (the tenant filter is part of the lookup, so a
      //    foreign source's existence is never leaked).
      const row = deps.db
        .prepare<
          [string, string],
          SourceRow
        >(`SELECT * FROM rag_sources WHERE id = ? AND tenant_id = ?`)
        .get(id, tenantId);
      if (!row) {
        sendError(res, 404, `Source "${id}" not found.`);
        return;
      }
      if (row.deleted_at !== null) {
        sendError(res, 404, `Source "${id}" not found.`);
        return;
      }

      // 2. Insert a `pending` job. We do this BEFORE asking the queue so
      //    the row exists by the time the worker (which may run on the
      //    next microtask) picks it up.
      //
      //    The job inherits its tenant from the parent source — that's
      //    the authoritative value for any background work that follows.
      //    Falling back to the resolved request tenant covers fixtures
      //    that bypass migration v6 (where `row.tenant_id` is undefined).
      const jobId = nanoid();
      const now = new Date().toISOString();
      const jobTenantId = row.tenant_id ?? tenantId;
      deps.db
        .prepare(
          `INSERT INTO rag_jobs
					 (id, source_id, status, progress, total_documents, processed_documents,
					  tenant_id, started_at)
					 VALUES (?, ?, 'pending', 0, 0, 0, ?, ?)`,
        )
        .run(jobId, id, jobTenantId, now);

      // 3. Try to enqueue. Returns false when a sync for this source is
      //    already running OR queued — in that case we DELETE the row we
      //    just inserted (so we don't leave a phantom 'pending' entry the
      //    UI would chase forever) and answer 409.
      const accepted = deps.syncQueue.enqueue(id, jobId);
      if (!accepted) {
        deps.db.prepare(`DELETE FROM rag_jobs WHERE id = ?`).run(jobId);
        sendError(res, 409, 'Sync already in progress for this source.');
        return;
      }

      deps.onAudit?.({
        type: 'rag.sync.queued',
        payload: { sourceId: id, jobId },
        timestamp: now,
      });

      // 4. Read back the inserted row and return it. The status is still
      //    `'pending'` here — the worker will flip it to `'running'`
      //    asynchronously. UI polling on GET /api/rag/jobs will see the
      //    transition.
      const inserted = deps.db
        .prepare<[string], JobRow>(`SELECT * FROM rag_jobs WHERE id = ?`)
        .get(jobId);
      res.status(202).json({ job: inserted ? rowToJob(inserted) : null });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      sendError(res, 500, message);
    }
  });
}
