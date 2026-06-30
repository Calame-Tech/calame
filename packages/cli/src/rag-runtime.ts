// RAG runtime bootstrap. Wires the SQLite-backed vector store, the ingestion
// pipeline, the connector resolver, the embedding-setting resolvers, the
// background job primitives (queue / poll scheduler / watch manager) and the
// document source adapters consumed by the route layer.
//
// The heavy lifting lives in the `./rag/*` modules (lazy EE loading, vector
// store init, connector dispatch, embedding resolvers, document adapters);
// this file is the orchestrator that threads them together and assembles the
// `RagRuntime` stored on `AppState.ragRuntime`. Public symbols historically
// exported from here (`RagRuntime`, `normaliseFolderArg`, `resolveFolderId`,
// `FolderResolverDb`) are re-exported below so existing imports keep working.

import { randomUUID } from 'node:crypto';
import type { EmbeddingCapConfig, RateLimiter, VectorStore } from '@calame-ee/rag-core';
import { sourceAdapterRegistry } from '@calame/core';
import type { CalameDatabase } from './database.js';
import type { AiSettingsManager } from './ai-config.js';
import { deriveKeyFromEnv, encryptString, decryptString } from './crypto.js';
import { parseRateLimitEnv } from './rag-rate-limits.js';
import { DEFAULT_TENANT_ID } from './tenancy.js';

import type { RagRuntime } from './rag/types.js';
import { loadEeModules } from './rag/bootstrap.js';
import { initVectorStore } from './rag/store-init.js';
import { buildConnectorResolver } from './rag/connector-dispatch.js';
import {
  buildEmbeddingResolvers,
  pickDefaultEmbeddingClient,
  makeUnconfiguredEmbeddingClient,
} from './rag/embeddings.js';
import { buildDocumentAdapterDeps, registerDocumentAdapters } from './rag/document-adapters.js';

// Re-export the public surface that historically lived in this module so
// `./rag-runtime.js` stays the stable import path for consumers and tests.
export type { RagRuntime } from './rag/types.js';
export {
  normaliseFolderArg,
  resolveFolderId,
  type FolderResolverDb,
} from './rag/folder-helpers.js';

/**
 * Initialize the RAG runtime on the given app state. Idempotent — safe to call
 * twice (subsequent calls are no-ops if `state.ragRuntime` is already set).
 *
 * Returns `undefined`. Side-effects only — sets `state.ragRuntime` on success.
 *
 * @param state object holding a mutable `ragRuntime?: RagRuntime` slot
 * @param db   the host's SQLite database wrapper
 * @param aiSettingsManager  used to look up AI settings for embeddings
 * @param logger optional logger for status messages
 */
export async function initRagRuntime(
  state: { ragRuntime?: RagRuntime; ragDisabledReason: string | null },
  db: CalameDatabase,
  aiSettingsManager: AiSettingsManager,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  if (state.ragRuntime) return;

  const log = logger ?? { info: console.log, warn: console.warn };

  // Lazy-load the EE packages. rag-core missing → RAG is disabled silently.
  const modules = await loadEeModules(log);
  if (!modules) {
    state.ragDisabledReason = 'EE package @calame-ee/rag-core not installed';
    return;
  }
  const { ragCore } = modules;

  // Run schema migrations against the host's SQLite DB.
  try {
    ragCore.runRagMigrations({ raw: db.raw });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to run RAG migrations: ${msg}. RAG features disabled.`);
    state.ragDisabledReason = `RAG migrations failed: ${msg}`;
    return;
  }

  // Boot recovery: sweep `pending` and `running` jobs left over from a previous
  // process. The single-process SyncQueue (built below) does not survive a
  // restart, so any in-flight job is now orphaned. Mark them failed so the UI
  // doesn't poll forever waiting for a worker that no longer exists.
  // Phase 4.1 limitation: we DO NOT re-enqueue pending jobs — the user can
  // re-trigger the sync from the UI. See `recoverOrphanedJobs` JSDoc.
  try {
    const recovered = ragCore.recoverOrphanedJobs(db.raw);
    if (recovered > 0) {
      log.info(`RAG: marked ${recovered} orphaned job(s) as failed (server restart recovery).`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`RAG: failed to sweep orphaned jobs at boot: ${msg} (continuing).`);
  }

  // Pick the vec0 dimension, auto-heal a mismatched table when safe, and build
  // the vector store. Any failure sets `state.ragDisabledReason` and returns null.
  const storeResult = initVectorStore(ragCore, db, state, log);
  if (!storeResult) return;
  const { vectorStore, dimension }: { vectorStore: VectorStore; dimension: number } = storeResult;

  const encryptionKey = deriveKeyFromEnv();
  const encryptConfig = (plaintext: string): string => encryptString(plaintext, encryptionKey);
  const decryptConfig = (ciphertext: string): string => decryptString(ciphertext, encryptionKey);

  const { resolveEmbeddingSetting, resolveEmbeddingClient } = buildEmbeddingResolvers(
    ragCore,
    aiSettingsManager,
  );

  // Build a placeholder ingestion pipeline. The pipeline takes ONE
  // EmbeddingClient at construction time — that's the Phase 1 contract. We bind
  // it to a "default" embedding client (first usable AI setting). Routes that
  // need a per-source client can rebuild the pipeline on demand later.
  const defaultEmbeddingClient = pickDefaultEmbeddingClient(
    aiSettingsManager,
    resolveEmbeddingClient,
    log,
  );

  if (!defaultEmbeddingClient) {
    // No usable AI setting — register the runtime but leave the pipeline absent.
    // Routes that don't need the pipeline (sources CRUD, list endpoints) will
    // still work; ingestion routes will fail with a clear error from the host
    // when no client is available. To keep types happy we still construct the
    // pipeline with a lazy throw-on-use stub.
    log.warn(
      'No AI setting with the "embeddings" capability is configured. ' +
        'RAG ingestion will fail until one is added via /api/ai-settings.',
    );
  }

  // Parse the operator-supplied monthly embedding-token cap. The env-var
  // parser is lenient (`undefined` / `'abc'` / negative → 0 = unlimited),
  // so a typo never crashes boot — it just disables the kill-switch. We
  // build the config object even when unlimited so downstream code can
  // always read `capConfig.monthlyTokenCap` without optional chaining.
  const monthlyTokenCap = ragCore.parseMonthlyCapEnv(process.env['CALAME_RAG_MONTHLY_TOKEN_CAP']);
  const capConfig: EmbeddingCapConfig = { monthlyTokenCap };
  if (monthlyTokenCap > 0) {
    log.info(
      `RAG monthly embedding cap: ${monthlyTokenCap.toLocaleString('en-US')} tokens / tenant / month.`,
    );
  } else {
    log.info('RAG monthly embedding cap: no cap configured (unlimited).');
  }

  const pipeline = new ragCore.IngestionPipeline({
    db: db.raw,
    vectorStore,
    embeddingClient: defaultEmbeddingClient ?? makeUnconfiguredEmbeddingClient(dimension),
    capConfig,
  });

  // Token-bucket rate limiter shared by every connector singleton (and the
  // Cohere reranker further down). DEFAULT_LIMITS encodes conservative
  // per-provider quotas; `parseRateLimitEnv` layers in any
  // `CALAME_RAG_RATE_LIMIT_<TYPE>` env overrides the operator supplied.
  // Audit events flow through the same `[rag-audit]` log line as the other
  // job primitives so a single tail covers throttling, polling, and syncs.
  const rateLimitOverrides = parseRateLimitEnv(process.env, log);
  if (Object.keys(rateLimitOverrides).length > 0) {
    log.info(
      `RAG rate limits overridden via env: ${Object.entries(rateLimitOverrides)
        .map(([t, v]) => `${t}=${v.refillPerSec}/s/${v.capacity}`)
        .join(', ')}`,
    );
  }
  const rateLimiter: RateLimiter = new ragCore.RateLimiter({
    limits: rateLimitOverrides,
    onAudit: (event) => {
      log.info(`[rag-audit] ${event.type} ${JSON.stringify(event.payload)}`);
    },
  });

  // Build the connector resolver over the loaded EE modules + shared limiter.
  const resolveConnector = buildConnectorResolver(modules, rateLimiter);

  // Build the singleton sync queue. The queue's worker callback closes over
  // the runtime fields it needs to invoke `runSyncJob` — it does NOT close
  // over a `RagRouteDeps` object because that lives in `app.ts` and may be
  // rebuilt across hot-reloads. Reconstructing the deps inline keeps the
  // queue tied to the runtime rather than to any specific Express app.
  const ragRuntimeRef: { current: RagRuntime | null } = { current: null };
  const syncQueue = new ragCore.SyncQueue({
    runJob: async (sourceId: string, jobId: string) => {
      const rt = ragRuntimeRef.current;
      if (!rt) {
        // Should never happen — the queue is owned by the runtime that owns
        // this ref. Defensive throw → caught by SyncQueue and surfaced via
        // onError.
        throw new Error('RAG runtime not initialized while running job');
      }
      // Build a minimal RagRouteDeps for runSyncJob. We don't need the
      // search-only fields (vectorStore, resolveEmbeddingClient, …) but
      // RagRouteDeps requires them, so we pass the runtime values straight
      // through.
      await rt.ragCore.runSyncJob(
        {
          db: db.raw,
          pipeline: rt.pipeline,
          vectorStore: rt.vectorStore,
          resolveEmbeddingClient: rt.resolveEmbeddingClient,
          resolveEmbeddingSetting: rt.resolveEmbeddingSetting,
          resolveConnector: rt.resolveConnector,
          encryptConfig: rt.encryptConfig,
          decryptConfig: rt.decryptConfig,
          syncQueue: rt.syncQueue,
          pollScheduler: rt.pollScheduler,
          watchManager: rt.watchManager,
          // Background worker — no request in scope, so we let the helper
          // fall through to its argument-less call. Phase A always returns
          // 'default'; Phase B will be context-aware when the worker carries
          // its own tenant binding.
          getTenantId: () => DEFAULT_TENANT_ID,
          // Pass the cap config through so the orchestrator can produce a
          // matching audit reason and the usage rollup stays consistent.
          capConfig: rt.capConfig,
          onAudit: (entry) => {
            log.info(`[rag-audit] ${entry.type} ${JSON.stringify(entry.payload)}`);
          },
          // Per-doc logging (info on ingest start/success, warn on failure,
          // info on unsupported-MIME skip). Surfaces what the worker is doing
          // mid-job so a stuck sync can be diagnosed without scanning the DB.
          logger: log,
        },
        sourceId,
        jobId,
      );
    },
    onError: (sourceId: string, jobId: string, err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`RAG sync worker failure (source=${sourceId} job=${jobId}): ${msg}`);
    },
  });

  // Single `triggerSync` lambda shared by the poll scheduler AND the watch
  // manager. Mirrors the body of `POST /api/rag/sources/:id/sync`: insert a
  // pending job, ask the queue to pick it up, and DELETE the row when the
  // queue rejects (already running / queued for the same source). Sharing
  // one lambda keeps the INSERT/enqueue/DELETE logic in a single place and
  // ensures both trigger paths go through the same SyncQueue dedupe.
  //
  // The job inherits its tenant from the parent source — there's no request
  // here (scheduler / watcher triggers run out-of-band) so we look up the
  // column directly. Defensive `?? DEFAULT_TENANT_ID` covers freshly upgraded
  // DBs whose source row was written before the v6 migration ran.
  const triggerSync = (sourceId: string): string | null => {
    const jobId = randomUUID();
    const now = new Date().toISOString();
    // Skip soft-deleted sources defensively. The poll scheduler and watch
    // manager already filter on `deleted_at IS NULL` at boot, but a tick
    // can fire AFTER the source was soft-deleted but BEFORE its timer is
    // removed (race: HTTP DELETE landed, `remove(sourceId)` queued in the
    // event loop, but the `setInterval` fired first). Returning null
    // matches the "queue rejected" contract — pollers / watchers will log
    // a `*.skipped` audit event and the next tick will find the timer gone.
    const sourceRow = db.raw
      .prepare<
        [string],
        { tenant_id: string | null; deleted_at: string | null }
      >(`SELECT tenant_id, deleted_at FROM rag_sources WHERE id = ?`)
      .get(sourceId);
    if (!sourceRow || sourceRow.deleted_at !== null) {
      return null;
    }
    const tenantId = sourceRow.tenant_id ?? DEFAULT_TENANT_ID;
    db.raw
      .prepare(
        `INSERT INTO rag_jobs
         (id, source_id, status, progress, total_documents, processed_documents,
          skipped_by_etag, gc_deleted, tenant_id, started_at)
         VALUES (?, ?, 'pending', 0, 0, 0, 0, 0, ?, ?)`,
      )
      .run(jobId, sourceId, tenantId, now);
    const accepted = syncQueue.enqueue(sourceId, jobId);
    if (!accepted) {
      // Queue rejected — sync already active for this source. Clean up
      // the phantom row so the UI doesn't poll a job that will never run.
      db.raw.prepare(`DELETE FROM rag_jobs WHERE id = ?`).run(jobId);
      return null;
    }
    return jobId;
  };

  // Build the poll scheduler. Closing over `db.raw` and `syncQueue` keeps
  // the scheduler tied to the runtime — the host never needs to thread these
  // through the route deps explicitly.
  const pollScheduler = new ragCore.PollScheduler({
    db: db.raw,
    triggerSync,
    onAudit: (event) => {
      log.info(`[rag-audit] ${event.type} ${JSON.stringify(event.payload)}`);
    },
  });
  // Start AFTER the runtime is wired so any tick that fires during boot has
  // a fully-built `triggerSync` to call. setInterval's first fire is N
  // seconds after registration, so a tick during boot is impossible in
  // practice — but ordering this way removes the race entirely.
  pollScheduler.start();

  // Build the real-time watch manager. Shares the queue-backed `triggerSync`
  // with the poll scheduler so concurrent watch + poll triggers serialize
  // per-source through the queue's dedupe.
  const watchManager = new ragCore.WatchManager({
    db: db.raw,
    resolveConnector: (type: string) => {
      // Reuse the runtime's connector resolver. We narrow the return value to
      // the WatchableConnector shape — the manager only touches `.type` and
      // `.watch?`, both of which `LocalFolderConnector` provides.
      const c = resolveConnector(type);
      return c as unknown as import('@calame-ee/rag-core').WatchableConnector | null;
    },
    decryptConfig,
    triggerSync,
    debounceMs: 5000,
    onAudit: (event) => {
      log.info(`[rag-audit] ${event.type} ${JSON.stringify(event.payload)}`);
    },
  });
  watchManager.start();

  // Soft-delete retention sweep (§12 Q7) — at boot, hard-delete every source
  // whose `deleted_at` is older than 7 days. The pass runs synchronously;
  // for a long-lived server one boot covers the typical operational rhythm
  // (most installs restart at least once per week for upgrades), so a
  // recurring setInterval is intentionally NOT wired here — adding it would
  // make the runtime harder to test for negligible payoff at MVP. If usage
  // patterns later show servers running for months at a time, layer a
  // setInterval that calls `runSoftDeleteCleanup` once per day.
  try {
    const summary = ragCore.runSoftDeleteCleanup({
      db: db.raw,
      vectorStore,
      retentionDays: 7,
      onAudit: (event) => {
        log.info(`[rag-audit] ${event.type} ${JSON.stringify(event.payload)}`);
      },
    });
    if (summary.hardDeletedSources > 0) {
      log.info(
        `RAG: cleanup pass hard-deleted ${summary.hardDeletedSources} expired source(s), ` +
          `wiped ${summary.wipedDocuments} doc(s) / ${summary.wipedChunks} chunk(s) / ` +
          `${summary.wipedFolders} folder(s) / ${summary.wipedJobs} job(s).`,
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`RAG: soft-delete cleanup pass failed at boot: ${msg} (continuing).`);
  }

  // Build DocumentAdapterDeps early so they can be:
  //   1. threaded into each adapter via buildDocumentSourceAdapter (below), AND
  //   2. stored on the runtime so serve.ts can call registerMergedDocumentRagTools.
  // The deps are built here (before the adapter registration block) so that the
  // runtime assignment below can include them even when `sourceAdapterRegistry.has('local')`
  // is already true (idempotent guard) — in that case the block is skipped but the
  // runtime still needs the reference for the merged-tool path.
  //
  // NOTE: This forward declaration is intentional. The `deps` variable is initialised
  // with placeholder values and will be reassigned inside the `if (!sourceAdapterRegistry.has('local'))`
  // block when adapters are freshly registered. The placeholder satisfies TypeScript and
  // the runtime assignment below — in practice `initRagRuntime` is only called once per
  // process so the block always runs.
  let documentAdapterDepsRef: import('@calame-ee/rag-core').DocumentAdapterDeps | undefined;

  state.ragDisabledReason = null;
  state.ragRuntime = {
    vectorStore,
    pipeline,
    encryptionKey,
    resolveEmbeddingSetting,
    resolveEmbeddingClient,
    encryptConfig,
    decryptConfig,
    resolveConnector,
    syncQueue,
    pollScheduler,
    watchManager,
    rateLimiter,
    ragCore,
    capConfig,
    // Filled in right after the adapter-registration block below.
    // Asserted non-null: the block always runs on first call and sets documentAdapterDepsRef.
    get documentAdapterDeps(): import('@calame-ee/rag-core').DocumentAdapterDeps {
      if (!documentAdapterDepsRef) {
        throw new Error('documentAdapterDeps accessed before adapter registration completed');
      }
      return documentAdapterDepsRef;
    },
  };
  ragRuntimeRef.current = state.ragRuntime;

  // Phase 3d: Register the DocumentSourceAdapter into the global SourceAdapterRegistry.
  // Guard with has() for idempotency — if initRagRuntime is somehow called twice
  // (the guard at the top catches this, but be defensive) we don't want a duplicate-
  // registration error from the registry.
  if (!sourceAdapterRegistry.has('local')) {
    const deps = buildDocumentAdapterDeps({
      db,
      ragCore,
      vectorStore,
      resolveEmbeddingClient,
      resolveConnector,
      aiSettingsManager,
      rateLimiter,
      log,
    });
    // Store a reference so the lazy getter on ragRuntime can return it.
    documentAdapterDepsRef = deps;
    registerDocumentAdapters(ragCore, deps, log);
  }

  log.info(`RAG runtime initialized (vector dimension=${dimension}).`);
}
