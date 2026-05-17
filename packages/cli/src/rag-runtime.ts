// RAG runtime bootstrap. Lazy-loads `@calame-ee/rag-core` and
// `@calame-ee/rag-connectors` so the CLI works when the EE packages are absent
// (apache-only install). Wires the SQLite-backed vector store, the ingestion
// pipeline, and the embedding-setting resolvers consumed by the route layer.

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type {
  IngestionPipeline,
  ResolvedEmbeddingSetting,
  VectorStore,
  EmbeddingClient,
  ConnectorLike,
  SyncQueue,
  PollScheduler,
  WatchManager,
  RateLimiter,
  EmbeddingCapConfig,
} from '@calame-ee/rag-core';
import { randomUUID } from 'node:crypto';
import type { CalameDatabase } from './database.js';
import type { AiSettingsManager } from './ai-config.js';
import { settingSupports } from './ai-config.js';
import { deriveKeyFromEnv, encryptString, decryptString } from './crypto.js';
import { sourceAdapterRegistry } from '@calame/core';
import { parseRateLimitEnv } from './rag-rate-limits.js';
import { DEFAULT_TENANT_ID } from './tenancy.js';

/**
 * Public shape of the RAG runtime stored on `AppState.ragRuntime`. All fields
 * are optional from the host's perspective — when the EE packages are missing
 * the entire runtime is `undefined` and routes are not registered.
 *
 * The `ragCore` field carries the dynamically-imported module so routes can be
 * registered synchronously by the host (Express's `createApp` is sync). Keep
 * this typed against the live module type to preserve TypeScript safety.
 */
export interface RagRuntime {
  vectorStore: VectorStore;
  pipeline: IngestionPipeline;
  encryptionKey: Buffer;
  /** Resolves an AI setting name to its concrete (model, dim) pair. */
  resolveEmbeddingSetting: (settingName: string) => ResolvedEmbeddingSetting;
  /** Resolves an AI setting name to a fully-built EmbeddingClient. */
  resolveEmbeddingClient: (settingName: string) => EmbeddingClient;
  /** Encrypt a plaintext config for persistence. */
  encryptConfig: (plaintext: string) => string;
  /** Decrypt a stored encrypted config. */
  decryptConfig: (ciphertext: string) => string;
  /** Resolves a document-source connector instance for a given source type. */
  resolveConnector: (type: string) => ConnectorLike | null;
  /**
   * Process-singleton FIFO queue for background sync jobs. Built once at boot
   * and shared by all `RagRouteDeps` instances so dedupe-by-sourceId works
   * across concurrent HTTP requests.
   */
  syncQueue: SyncQueue;
  /**
   * In-process timer registry for sources with `pollingIntervalSeconds` set.
   * Built and started at boot; the sources route updates it on POST/PATCH
   * and DELETE so the scheduler stays consistent with the persisted source
   * set.
   */
  pollScheduler: PollScheduler;
  /**
   * Real-time filesystem watcher registry for sources whose connector supports
   * `watch()` (today: `local`). Built and started at boot; the sources route
   * updates it on POST/PATCH/DELETE so the watcher set tracks the persisted
   * source set. Shares the queue-backed `triggerSync` lambda with the poll
   * scheduler so per-source dedupe is preserved across both trigger paths.
   */
  watchManager: WatchManager;
  /**
   * Per-(type, credentialKey) token-bucket rate limiter shared by every
   * connector singleton (and the Cohere reranker). Built once at boot and
   * threaded into each connector via `setRateLimiter` before the connector
   * is returned from `resolveConnector`. Prevents bursts from the
   * polling / watch / queue paths from saturating upstream API quotas.
   */
  rateLimiter: RateLimiter;
  /** Reference to the loaded @calame-ee/rag-core module — used to register routes. */
  ragCore: typeof import('@calame-ee/rag-core');
  /**
   * Monthly embedding-token cap config (parsed from
   * `CALAME_RAG_MONTHLY_TOKEN_CAP`). Always present — `monthlyTokenCap: 0`
   * means unlimited. Threaded into the pipeline (gate before embed) and the
   * usage route (progress / warning surface) so both paths agree on the
   * same threshold.
   */
  capConfig: EmbeddingCapConfig;
}

/** Default vector dimension used when bootstrapping the vec0 table eagerly.
 *
 * Phase 1 limitation: the sqlite-vec virtual table has a fixed dimension at
 * create time. We default to 1536 (OpenAI text-embedding-3-small) so the
 * default install works out of the box. Operators that want a different
 * dimension must drop the table and restart — see routes/rag-sources.ts. */
const DEFAULT_DIMENSION = 1536;

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

  // Lazy-load EE packages. Either missing → RAG is disabled silently.
  type RagCoreModule = typeof import('@calame-ee/rag-core');
  let ragCore: RagCoreModule;
  try {
    ragCore = await import('@calame-ee/rag-core');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`RAG features disabled (@calame-ee/rag-core not available): ${msg}`);
    state.ragDisabledReason = 'EE package @calame-ee/rag-core not installed';
    return;
  }
  // The connectors package provides concrete DocumentSourceConnector
  // implementations (LocalFolderConnector for now). Pre-load it so the route
  // layer can synchronously resolve a connector for a given source type.
  type RagConnectorsModule = typeof import('@calame-ee/rag-connectors');
  let ragConnectors: RagConnectorsModule | null = null;
  try {
    ragConnectors = await import('@calame-ee/rag-connectors');
  } catch {
    log.warn('@calame-ee/rag-connectors not installed — local source sync will return 501.');
  }

  // Google Drive connector lives in its own EE package because the `googleapis`
  // dep is heavy (~100MB with types). Pre-load it conditionally so apache-only
  // installs (or installs that don't need GDrive) skip the cost. When the
  // package is absent, `gdrive` sources will fall through `resolveConnector`
  // and the route layer answers 501.
  type RagGdriveModule = typeof import('@calame-ee/rag-gdrive');
  let ragGdrive: RagGdriveModule | null = null;
  try {
    ragGdrive = await import('@calame-ee/rag-gdrive');
  } catch {
    log.warn(
      '@calame-ee/rag-gdrive not installed — gdrive sources will be unavailable. ' +
        'Install the package and restart to enable Google Drive ingestion.',
    );
  }

  // Google Sheets connector lives in its own EE package — it shares the
  // `googleapis` dep with rag-gdrive but exists separately so admins can pick
  // per-tab granularity + header-aware CSV chunking instead of gdrive's
  // export-the-whole-workbook behaviour. Same lazy-load pattern as the other
  // EE connectors.
  type RagGsheetsModule = typeof import('@calame-ee/rag-gsheets');
  let ragGsheets: RagGsheetsModule | null = null;
  try {
    ragGsheets = await import('@calame-ee/rag-gsheets');
  } catch {
    log.warn(
      '@calame-ee/rag-gsheets not installed — gsheets sources will be unavailable. ' +
        'Install the package and restart to enable Google Sheets ingestion.',
    );
  }

  // Notion connector also lives in its own EE package (separate `@notionhq/client`
  // dep). Same lazy-load pattern as gdrive: when the package is absent, `notion`
  // sources fall through `resolveConnector` and the route layer answers 501.
  type RagNotionModule = typeof import('@calame-ee/rag-notion');
  let ragNotion: RagNotionModule | null = null;
  try {
    ragNotion = await import('@calame-ee/rag-notion');
  } catch {
    log.warn(
      '@calame-ee/rag-notion not installed — notion sources will be unavailable. ' +
        'Install the package and restart to enable Notion ingestion.',
    );
  }

  // Microsoft 365 connectors (SharePoint today, OneDrive / Outlook / Teams
  // potentially later) live in @calame-ee/rag-microsoft. Pulls in the Graph
  // SDK + @azure/identity (~20MB of types); lazy-loaded so apache-only
  // installs that don't need M365 skip the cost. When absent, `sharepoint`
  // sources fall through resolveConnector and the route layer answers 501.
  type RagMicrosoftModule = typeof import('@calame-ee/rag-microsoft');
  let ragMicrosoft: RagMicrosoftModule | null = null;
  try {
    ragMicrosoft = await import('@calame-ee/rag-microsoft');
  } catch {
    log.warn(
      '@calame-ee/rag-microsoft not installed — sharepoint sources will be unavailable. ' +
        'Install the package and restart to enable Microsoft 365 ingestion.',
    );
  }

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

  // Pick a dimension for the vec0 table. Use whatever existing sources have
  // declared (single-dimension Phase 1 invariant), else fall back to the default.
  const existingDim = readExistingDimension(db.raw);
  const dimension = existingDim ?? DEFAULT_DIMENSION;

  // Auto-heal: if the existing vec0 table has the wrong dimension AND no chunks
  // would be lost, drop it so the SqliteVecStore constructor recreates it at
  // the correct dimension. Refuses to drop when chunks exist.
  try {
    const result = ragCore.resetVecTableIfDimensionMismatch(db.raw, dimension);
    if (result.reset) {
      log.info(
        `RAG: rebuilt rag_chunks_vec from dimension=${result.previousDimension} to ${dimension} (no chunks present).`,
      );
    } else if (result.reason === 'chunks-present') {
      log.warn(
        `RAG: rag_chunks_vec dimension=${result.previousDimension} ≠ requested ${dimension}, ` +
          `but ${result.chunkCount} chunks present — refusing to drop. Manually wipe rag_chunks ` +
          `and rag_chunks_vec to switch dimensions. RAG features disabled.`,
      );
      state.ragDisabledReason =
        `Vector store dimension mismatch (rag_chunks_vec=${result.previousDimension}, ` +
        `expected ${dimension}) and chunks already present — manually wipe rag_chunks/rag_chunks_vec ` +
        `to switch dimensions`;
      return;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`RAG: failed to inspect rag_chunks_vec: ${msg}. RAG features disabled.`);
    state.ragDisabledReason = `Failed to inspect rag_chunks_vec: ${msg}`;
    return;
  }

  // Build the vector store. Native binding errors are surfaced as warnings —
  // they're typically a Windows rebuild issue and shouldn't crash the host.
  let vectorStore: VectorStore;
  try {
    vectorStore = new ragCore.SqliteVecStore(db.raw, dimension);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to initialize RAG vector store: ${msg}. RAG features disabled.`);
    state.ragDisabledReason = `Failed to initialize sqlite-vec native binding: ${msg}`;
    return;
  }

  const encryptionKey = deriveKeyFromEnv();
  const encryptConfig = (plaintext: string): string => encryptString(plaintext, encryptionKey);
  const decryptConfig = (ciphertext: string): string => decryptString(ciphertext, encryptionKey);

  // Resolver: AI setting name → (embeddingModel, dimensions).
  const resolveEmbeddingSetting = (settingName: string): ResolvedEmbeddingSetting => {
    const setting = aiSettingsManager.getSetting(settingName);
    if (!setting) {
      throw new Error(`AI setting "${settingName}" not found.`);
    }
    if (!settingSupports(setting, 'embeddings')) {
      throw new Error(
        `AI setting "${settingName}" does not advertise the "embeddings" capability. ` +
          `Edit the setting and enable embeddings (with a model selected) before referencing it from a RAG source.`,
      );
    }
    if (!setting.embeddingModel) {
      throw new Error(
        `AI setting "${settingName}" has the "embeddings" capability but no embeddingModel.`,
      );
    }
    if (setting.embeddingDimensions === undefined) {
      throw new Error(
        `AI setting "${settingName}" was saved before embedding-dimension auto-detection. ` +
          `Re-save the setting in the UI to probe and cache the dimension.`,
      );
    }
    return { embeddingModel: setting.embeddingModel, dimensions: setting.embeddingDimensions };
  };

  const resolveEmbeddingClient = (settingName: string): EmbeddingClient => {
    const setting = aiSettingsManager.getSetting(settingName);
    if (!setting) {
      throw new Error(`AI setting "${settingName}" not found.`);
    }
    if (!settingSupports(setting, 'embeddings')) {
      throw new Error(
        `AI setting "${settingName}" does not advertise the "embeddings" capability.`,
      );
    }
    const { dimensions } = resolveEmbeddingSetting(settingName);
    return ragCore.createEmbeddingClient(
      {
        provider: setting.provider,
        apiKey: setting.apiKey,
        baseUrl: setting.baseUrl,
        embeddingModel: setting.embeddingModel,
      },
      dimensions,
    );
  };

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
  const monthlyTokenCap = ragCore.parseMonthlyCapEnv(
    process.env['CALAME_RAG_MONTHLY_TOKEN_CAP'],
  );
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
  const rateLimiter = new ragCore.RateLimiter({
    limits: rateLimitOverrides,
    onAudit: (event) => {
      log.info(`[rag-audit] ${event.type} ${JSON.stringify(event.payload)}`);
    },
  });

  // Build a connector resolver. Phase 1 wired `local`; Phase 3 adds `s3` and
  // `http`. Phase 3+ adds `gdrive`, `gsheets`, `notion`, and `sharepoint` (each
  // in a separate package — see the `ragGdrive` / `ragGsheets` / `ragNotion` /
  // `ragMicrosoft` lazy-imports above). Other types (git, …) still return null
  // so the route layer can answer 501 with a clear message.
  //
  // Every remote-API connector is wrapped with `setRateLimiter(rateLimiter)`
  // before returning so the queue / poller / watcher trigger paths all share
  // one process-wide bucket per (type, credential). `local` is filesystem-only
  // and skips the wiring — no upstream quota to honor.
  const withRateLimiter = <T extends { setRateLimiter?: (l: RateLimiter | undefined) => void }>(
    connector: T,
  ): T => {
    if (typeof connector.setRateLimiter === 'function') {
      connector.setRateLimiter(rateLimiter);
    }
    return connector;
  };

  const resolveConnector = (type: string): ConnectorLike | null => {
    if (type === 'gdrive') {
      if (!ragGdrive) return null;
      return withRateLimiter(new ragGdrive.GDriveConnector()) as unknown as ConnectorLike;
    }
    if (type === 'gsheets') {
      if (!ragGsheets) return null;
      return withRateLimiter(new ragGsheets.GSheetsConnector()) as unknown as ConnectorLike;
    }
    if (type === 'notion') {
      if (!ragNotion) return null;
      return withRateLimiter(new ragNotion.NotionConnector()) as unknown as ConnectorLike;
    }
    if (type === 'sharepoint') {
      if (!ragMicrosoft) return null;
      return withRateLimiter(
        new ragMicrosoft.SharePointConnector(),
      ) as unknown as ConnectorLike;
    }
    if (!ragConnectors) return null;
    if (type === 'local') {
      // No rate limit needed — local filesystem has no upstream quota.
      return new ragConnectors.LocalFolderConnector() as unknown as ConnectorLike;
    }
    if (type === 's3') {
      return withRateLimiter(new ragConnectors.S3Connector()) as unknown as ConnectorLike;
    }
    if (type === 'http') {
      return withRateLimiter(new ragConnectors.HttpConnector()) as unknown as ConnectorLike;
    }
    return null;
  };

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
      .prepare<[string], { tenant_id: string | null; deleted_at: string | null }>(
        `SELECT tenant_id, deleted_at FROM rag_sources WHERE id = ?`,
      )
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
  };
  ragRuntimeRef.current = state.ragRuntime;

  // Phase 3d: Register the DocumentSourceAdapter into the global SourceAdapterRegistry.
  // Guard with has() for idempotency — if initRagRuntime is somehow called twice
  // (the guard at the top catches this, but be defensive) we don't want a duplicate-
  // registration error from the registry.
  if (!sourceAdapterRegistry.has('local')) {
    // Build DocumentAdapterDeps from the runtime fields we just assembled.
    // Storage and searchIndex are implemented below as closures over `db` so
    // we can make synchronous-friendly implementations on top of better-sqlite3.
    const ragDb = db;

    // ---------------------------------------------------------------------------
    // DocumentStorage implementation backed by the shared SQLite DB
    // ---------------------------------------------------------------------------
    interface RagFolderRow {
      id: string;
      source_id: string;
      parent_id: string | null;
      path: string;
      name: string;
      tenant_id: string | null;
      created_at: string;
    }
    interface RagDocumentRow {
      id: string;
      source_id: string;
      folder_id: string | null;
      path: string;
      name: string;
      mime_type: string;
      size: number;
      hash: string;
      etag: string | null;
      tenant_id: string | null;
      last_indexed_at: string;
      deleted_at: string | null;
    }
    interface RagChunkRow {
      id: string;
      document_id: string;
      position: number;
      text: string;
    }
    interface SourceAggRow {
      id: string;
      name: string;
      type: string;
      folder_count: number;
      document_count: number;
    }

    const storage: import('@calame-ee/rag-core').DocumentStorage = {
      async listFolders(sourceId: string, parent?: string) {
        const rows: RagFolderRow[] =
          parent !== undefined
            ? ragDb.raw
                .prepare<[string, string], RagFolderRow>(
                  'SELECT * FROM rag_folders WHERE source_id = ? AND parent_id = ? ORDER BY path ASC',
                )
                .all(sourceId, parent)
            : ragDb.raw
                .prepare<[string], RagFolderRow>(
                  'SELECT * FROM rag_folders WHERE source_id = ? ORDER BY path ASC',
                )
                .all(sourceId);
        return rows.map((r) => ({
          id: r.id,
          sourceId: r.source_id,
          parentId: r.parent_id,
          path: r.path,
          name: r.name,
          // Defensive `?? DEFAULT_TENANT_ID` for fixtures that bypass the
          // RAG-side migration (the column may be absent on legacy DBs that
          // haven't replayed `runRagMigrations` yet).
          tenantId: r.tenant_id ?? DEFAULT_TENANT_ID,
          createdAt: r.created_at,
        }));
      },

      async listDocuments(sourceId: string, folder?: string) {
        const rows: RagDocumentRow[] =
          folder !== undefined
            ? ragDb.raw
                .prepare<[string, string], RagDocumentRow>(
                  `SELECT * FROM rag_documents
                   WHERE source_id = ? AND folder_id = ? AND deleted_at IS NULL
                   ORDER BY path ASC`,
                )
                .all(sourceId, folder)
            : ragDb.raw
                .prepare<[string], RagDocumentRow>(
                  `SELECT * FROM rag_documents
                   WHERE source_id = ? AND deleted_at IS NULL
                   ORDER BY path ASC`,
                )
                .all(sourceId);
        return rows.map((r) => ({
          id: r.id,
          sourceId: r.source_id,
          folderId: r.folder_id,
          path: r.path,
          name: r.name,
          mimeType: r.mime_type,
          size: r.size,
          hash: r.hash,
          etag: r.etag,
          tenantId: r.tenant_id ?? DEFAULT_TENANT_ID,
          lastIndexedAt: r.last_indexed_at,
          deletedAt: r.deleted_at,
        }));
      },

      async getDocument(documentId: string) {
        const row = ragDb.raw
          .prepare<[string], RagDocumentRow>('SELECT * FROM rag_documents WHERE id = ?')
          .get(documentId);
        if (!row) return null;
        const chunks = ragDb.raw
          .prepare<[string], RagChunkRow>(
            'SELECT * FROM rag_chunks WHERE document_id = ? ORDER BY position ASC',
          )
          .all(documentId);
        const text = chunks.map((c) => c.text).join('\n');
        return {
          doc: {
            id: row.id,
            sourceId: row.source_id,
            folderId: row.folder_id,
            path: row.path,
            name: row.name,
            mimeType: row.mime_type,
            size: row.size,
            hash: row.hash,
            etag: row.etag,
            tenantId: row.tenant_id ?? DEFAULT_TENANT_ID,
            lastIndexedAt: row.last_indexed_at,
            deletedAt: row.deleted_at,
          },
          text,
        };
      },

      async listSources() {
        // Exclude soft-deleted sources from the adapter's listing — the
        // MCP `rag_list_sources` tool reads through this code path and
        // should never see retired sources.
        const rows = ragDb.raw
          .prepare<[], SourceAggRow>(
            `SELECT
               s.id,
               s.name,
               s.type,
               (SELECT COUNT(*) FROM rag_folders f WHERE f.source_id = s.id) AS folder_count,
               (SELECT COUNT(*) FROM rag_documents d WHERE d.source_id = s.id AND d.deleted_at IS NULL) AS document_count
             FROM rag_sources s
             WHERE s.deleted_at IS NULL
             ORDER BY s.created_at ASC`,
          )
          .all();
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          folderCount: r.folder_count,
          documentCount: r.document_count,
        }));
      },
    };

    // ---------------------------------------------------------------------------
    // DocumentSearchIndex implementation
    //
    // Phase 5 / Tranche 1: switch from a pure vector index to the
    // HybridSearchIndex from @calame-ee/rag-core, which combines SQLite
    // FTS5 keyword search with vector similarity through Reciprocal
    // Rank Fusion (RRF). The hybrid index transparently falls back to
    // pure vector when the v5 FTS table is missing (logged once).
    //
    // Phase 5 / Tranche 2: when an AI setting advertises the 'rerank'
    // capability with a Cohere API key + rerankModel, wrap the hybrid
    // index in a RerankingSearchIndex that re-orders the top-N candidates
    // through Cohere's cross-encoder API before returning top-K. The
    // wrapper is fail-open: a Cohere outage degrades quality but does not
    // break search.
    //
    // Toggles:
    //   CALAME_RAG_HYBRID_SEARCH=off → legacy vector-only first stage.
    //   CALAME_RAG_RERANK=off        → skip the rerank wrapper even when
    //                                  a 'rerank'-capable setting exists.
    // ---------------------------------------------------------------------------
    const hybridFlag = process.env.CALAME_RAG_HYBRID_SEARCH;
    const hybridEnabled = hybridFlag !== 'off';

    let baseIndex: import('@calame-ee/rag-core').DocumentSearchIndex;
    if (hybridEnabled) {
      baseIndex = new ragCore.HybridSearchIndex({
        db: ragDb.raw,
        vectorStore,
        resolveEmbeddingClient,
        logger: log,
      });
    } else {
      log.info('RAG: CALAME_RAG_HYBRID_SEARCH=off — using legacy vector-only search.');
      // Legacy vector-only adapter (kept inline for the debug toggle).
      // The hybrid index covers the same functional surface when enabled —
      // this branch only exists to support side-by-side comparison.
      const capturedVectorStore = vectorStore;
      const capturedResolveEmbeddingClient = resolveEmbeddingClient;

      baseIndex = {
        async search(sourceId, query, opts) {
          const settingRow = ragDb.raw
            .prepare<[string], { embedding_setting_name: string }>(
              'SELECT embedding_setting_name FROM rag_sources WHERE id = ? LIMIT 1',
            )
            .get(sourceId);
          if (!settingRow) return { chunks: [] };

          const client = capturedResolveEmbeddingClient(settingRow.embedding_setting_name);
          const vectors = await client.embed([query]);
          const queryVec = new Float32Array(vectors[0] ?? []);

          const topK = Math.min(opts.topK ?? 5, 10);
          const vecResults = capturedVectorStore.search(queryVec, topK * 4);
          if (vecResults.length === 0) return { chunks: [] };

          interface ChunkJoinRow {
            chunk_id: string;
            chunk_text: string;
            chunk_position: number;
            doc_id: string;
            doc_source_id: string;
            doc_name: string;
            folder_path: string | null;
          }

          const placeholders = vecResults.map(() => '?').join(',');
          const chunkIds = vecResults.map((r) => r.chunkId);
          // Extra JOIN on rag_sources + s.deleted_at IS NULL filters out
          // chunks whose parent source has been soft-deleted (v8). Mirrors
          // the same filter in the hybrid index and rag-search route.
          const rows = ragDb.raw
            .prepare<string[], ChunkJoinRow>(
              `SELECT
                 c.id        AS chunk_id,
                 c.text      AS chunk_text,
                 c.position  AS chunk_position,
                 d.id        AS doc_id,
                 d.source_id AS doc_source_id,
                 d.name      AS doc_name,
                 f.path      AS folder_path
               FROM rag_chunks c
               JOIN rag_documents d ON d.id = c.document_id
               JOIN rag_sources s ON s.id = d.source_id
               LEFT JOIN rag_folders f ON f.id = d.folder_id
               WHERE c.id IN (${placeholders})
                 AND d.source_id = ?
                 AND d.deleted_at IS NULL
                 AND s.deleted_at IS NULL`,
            )
            .all(...chunkIds, sourceId);

          const filtered = rows.filter((row) => {
            if (opts.folders && opts.folders.length > 0) {
              const fp = row.folder_path ?? '';
              return opts.folders.some((f) => fp === f || fp.startsWith(f + '/'));
            }
            return true;
          });

          const distanceMap = new Map(vecResults.map((r) => [r.chunkId, r.distance]));

          return {
            chunks: filtered
              .sort(
                (a, b) =>
                  (distanceMap.get(a.chunk_id) ?? 1) - (distanceMap.get(b.chunk_id) ?? 1),
              )
              .slice(0, topK)
              .map((row) => ({
                text: row.chunk_text,
                score: 1 - (distanceMap.get(row.chunk_id) ?? 1),
                sourceId: row.doc_source_id,
                folder: row.folder_path ?? '',
                fileName: row.doc_name,
                position: row.chunk_position,
                documentId: row.doc_id,
              })),
          };
        },
      };
    }

    // ---------------------------------------------------------------------------
    // Reranker composition (Phase 5 / Tranche 2)
    //
    // Look up any AI setting that advertises the 'rerank' capability with a
    // Cohere apiKey + rerankModel. When present (and CALAME_RAG_RERANK != 'off')
    // wrap the first-stage index in a RerankingSearchIndex that calls Cohere
    // /v2/rerank to re-order the top-N candidates before returning top-K.
    //
    // No matching setting → searchIndex == baseIndex (hybrid only).
    // ---------------------------------------------------------------------------
    const rerankFlag = process.env.CALAME_RAG_RERANK;
    const rerankEnabled = rerankFlag !== 'off';

    const reranker = rerankEnabled
      ? resolveCohereReranker(aiSettingsManager, ragCore, log, rateLimiter)
      : null;

    const searchIndex: import('@calame-ee/rag-core').DocumentSearchIndex = reranker
      ? new ragCore.RerankingSearchIndex({
          base: baseIndex,
          reranker,
          candidatesPerSearch: 50,
          onAudit: (event) => {
            log.info(`[rag-audit] ${event.type} ${JSON.stringify(event.payload)}`);
          },
        })
      : baseIndex;
    if (reranker) {
      log.info(`RAG: rerank wrapper active (model=${reranker.model}).`);
    } else if (rerankFlag === 'off') {
      log.info('RAG: CALAME_RAG_RERANK=off — rerank disabled by env flag.');
    }

    // -----------------------------------------------------------------------
    // PII masking config (Phase 5 / Tranche 3)
    //
    // Parses CALAME_RAG_PII_MASK into a typed RagPiiMaskingConfig. The parser
    // is "safe-by-default": undefined / 'on' / typo → enabled with mode=replace
    // and the default category set (email, phone, credit_card, ip_address,
    // ssn). Only 'off' or 'none' actually disable masking.
    //
    // We pass the SAME config to every adapter — global behaviour. Per-source
    // overrides are deferred to a later phase (would require a UI flag on the
    // source CRUD).
    // -----------------------------------------------------------------------
    const piiMasking = ragCore.parseRagPiiConfig(process.env.CALAME_RAG_PII_MASK);
    if (piiMasking.enabled) {
      log.info(
        `RAG PII masking: enabled (mode=${piiMasking.mode}, categories=${piiMasking.categories.join(',')}).`,
      );
    } else {
      log.warn(
        'RAG PII masking: DISABLED (CALAME_RAG_PII_MASK=off). Chunk text and full ' +
          'document content are returned to the LLM verbatim. Not recommended for ' +
          'regulated industries.',
      );
    }

    // Build and register the adapter.
    const deps: import('@calame-ee/rag-core').DocumentAdapterDeps = {
      resolveConnector,
      searchIndex,
      storage,
      piiMasking,
    };

    const ADAPTERS_TO_REGISTER: ReadonlyArray<{ type: string; displayName: string }> = [
      { type: 'local', displayName: 'Local folder' },
      { type: 's3', displayName: 'Amazon S3' },
      { type: 'http', displayName: 'HTTP' },
      { type: 'gdrive', displayName: 'Google Drive' },
      { type: 'gsheets', displayName: 'Google Sheets' },
      { type: 'notion', displayName: 'Notion' },
      { type: 'sharepoint', displayName: 'SharePoint' },
      { type: 'git', displayName: 'Git' },
    ];

    for (const { type, displayName } of ADAPTERS_TO_REGISTER) {
      if (sourceAdapterRegistry.has(type)) continue;
      const adapter = ragCore.buildDocumentSourceAdapter(deps, type, displayName);
      sourceAdapterRegistry.register(adapter);
      log.info(`RAG DocumentSourceAdapter (${type}) registered in SourceAdapterRegistry.`);
    }
  }

  log.info(`RAG runtime initialized (vector dimension=${dimension}).`);
}

/**
 * Pick the first AI setting that advertises embeddings and resolves cleanly to
 * a known embedding model. Returns `null` when none is available.
 */
function pickDefaultEmbeddingClient(
  aiSettingsManager: AiSettingsManager,
  resolveEmbeddingClient: (settingName: string) => EmbeddingClient,
  log: { warn: (msg: string) => void },
): EmbeddingClient | null {
  const settings = aiSettingsManager.listSettings();
  for (const setting of settings) {
    if (!settingSupports(setting, 'embeddings')) continue;
    try {
      return resolveEmbeddingClient(setting.name);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Skipping AI setting "${setting.name}" for default embeddings: ${msg}`);
    }
  }
  return null;
}

/**
 * Stub client used only when no AI setting is configured. Throws on any call so
 * callers see a clear error instead of silently producing zero vectors.
 */
function makeUnconfiguredEmbeddingClient(dimensions: number): EmbeddingClient {
  return {
    dimensions,
    modelName: 'unconfigured',
    embed: () => {
      throw new Error(
        'No embedding-capable AI setting is configured. ' +
          'Create one via /api/ai-settings (capabilities includes "embeddings").',
      );
    },
  };
}

/**
 * Pick the first AI setting that advertises the `rerank` capability and has the
 * pieces a {@link CohereReranker} needs (apiKey + rerankModel). Returns the
 * built reranker, or null when no usable setting is configured.
 *
 * Note: we only support Cohere here. Voyage AI / local cross-encoder would
 * branch on `setting.provider`, but Phase 5 ships Cohere only.
 */
function resolveCohereReranker(
  aiSettingsManager: AiSettingsManager,
  ragCore: typeof import('@calame-ee/rag-core'),
  log: { info: (msg: string) => void; warn: (msg: string) => void },
  rateLimiter: RateLimiter | null,
): import('@calame-ee/rag-core').Reranker | null {
  const settings = aiSettingsManager.listSettings();
  for (const setting of settings) {
    if (!settingSupports(setting, 'rerank')) continue;
    if (!setting.apiKey) {
      log.warn(`Skipping rerank AI setting "${setting.name}": missing apiKey.`);
      continue;
    }
    if (!setting.rerankModel) {
      log.warn(`Skipping rerank AI setting "${setting.name}": missing rerankModel.`);
      continue;
    }
    try {
      const reranker = new ragCore.CohereReranker({
        apiKey: setting.apiKey,
        model: setting.rerankModel,
        baseUrl: setting.baseUrl,
      });
      // Share the runtime rate limiter so the `cohere` bucket throttles
      // every rerank call across the process — keeps trial-tier keys
      // (10 req/min) safe and avoids 429s under load.
      if (rateLimiter) {
        reranker.setRateLimiter(rateLimiter);
      }
      return reranker;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to build CohereReranker from "${setting.name}": ${msg}`);
    }
  }
  return null;
}

/** Read the dimension already in use by existing rag_sources, or null when empty. */
function readExistingDimension(raw: BetterSqlite3Database): number | null {
  // Defensive: the `embedding_dimensions` column may not exist yet if
  // migrations haven't run. Probe via PRAGMA before SELECTing.
  const cols = raw.pragma('table_info(rag_sources)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'embedding_dimensions')) return null;
  const row = raw
    .prepare(
      `SELECT embedding_dimensions FROM rag_sources
       WHERE embedding_dimensions > 0
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as { embedding_dimensions: number } | undefined;
  return row ? row.embedding_dimensions : null;
}
