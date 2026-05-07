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
} from '@calame-ee/rag-core';
import type { CalameDatabase } from './database.js';
import type { AiSettingsManager } from './ai-config.js';
import { settingSupports } from './ai-config.js';
import { deriveKeyFromEnv, encryptString, decryptString } from './crypto.js';

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
  /** Reference to the loaded @calame-ee/rag-core module — used to register routes. */
  ragCore: typeof import('@calame-ee/rag-core');
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
  state: { ragRuntime?: RagRuntime },
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

  // Run schema migrations against the host's SQLite DB.
  try {
    ragCore.runRagMigrations({ raw: db.raw });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to run RAG migrations: ${msg}. RAG features disabled.`);
    return;
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
      return;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`RAG: failed to inspect rag_chunks_vec: ${msg}. RAG features disabled.`);
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

  const pipeline = new ragCore.IngestionPipeline({
    db: db.raw,
    vectorStore,
    embeddingClient: defaultEmbeddingClient ?? makeUnconfiguredEmbeddingClient(dimension),
  });

  // Build a connector resolver. For Phase 1 only `local` is wired; other types
  // return null so the route layer can answer 501 with a clear message.
  const resolveConnector = (type: string): ConnectorLike | null => {
    if (!ragConnectors) return null;
    if (type === 'local') {
      return new ragConnectors.LocalFolderConnector() as unknown as ConnectorLike;
    }
    return null;
  };

  state.ragRuntime = {
    vectorStore,
    pipeline,
    encryptionKey,
    resolveEmbeddingSetting,
    resolveEmbeddingClient,
    encryptConfig,
    decryptConfig,
    resolveConnector,
    ragCore,
  };

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
