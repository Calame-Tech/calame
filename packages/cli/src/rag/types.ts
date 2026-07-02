// Shared types for the RAG runtime modules. Splitting these out of
// `rag-runtime.ts` lets the bootstrap / store / connector / embedding / adapter
// modules reference the runtime shape (and a common logger surface) without
// importing the orchestrator, which would create an import cycle.

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
  DocumentAdapterDeps,
} from '@calame-ee/rag-core';

/**
 * Minimal logger surface used across the RAG runtime modules. Mirrors the
 * subset of the host logger the runtime touches (info / warn) so each module
 * can accept a logger without depending on the concrete implementation.
 */
export interface RagLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

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
  /**
   * Shared DocumentAdapterDeps built once at boot.
   * Exposed so serve.ts can pass them to `registerMergedDocumentRagTools`
   * without re-constructing the search index / storage closures.
   * All document source adapters (local, s3, http, gdrive, …) share the
   * same deps instance — only the connector type differs per source.
   */
  documentAdapterDeps: DocumentAdapterDeps;
}
