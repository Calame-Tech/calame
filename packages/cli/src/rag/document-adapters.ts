// DocumentAdapterDeps assembly: builds the SQLite-backed DocumentStorage and
// the (hybrid + optional rerank) DocumentSearchIndex, parses the PII-masking
// config, and registers a DocumentSourceAdapter per source type into the global
// SourceAdapterRegistry. Extracted from `rag-runtime.ts` — this was ~450 lines
// of closures nested inside `initRagRuntime`.

import type {
  ConnectorLike,
  DocumentAdapterDeps,
  EmbeddingClient,
  RateLimiter,
  VectorStore,
} from '@calame-ee/rag-core';
import { sourceAdapterRegistry } from '@calame/core';
import type { CalameDatabase } from '../database.js';
import type { AiSettingsManager } from '../ai-config.js';
import { DEFAULT_TENANT_ID } from '../tenancy.js';
import type { RagLogger } from './types.js';
import { normaliseFolderArg, resolveFolderId } from './folder-helpers.js';
import { resolveCohereReranker } from './embeddings.js';

/** Inputs needed to assemble the shared DocumentAdapterDeps. */
export interface BuildDocumentAdapterDepsParams {
  db: CalameDatabase;
  ragCore: typeof import('@calame-ee/rag-core');
  vectorStore: VectorStore;
  resolveEmbeddingClient: (settingName: string) => EmbeddingClient;
  resolveConnector: (type: string) => ConnectorLike | null;
  aiSettingsManager: AiSettingsManager;
  rateLimiter: RateLimiter;
  log: RagLogger;
}

/**
 * Build the shared DocumentAdapterDeps (storage + search index + PII config)
 * once at boot. The same instance backs every registered document adapter —
 * only the connector type differs per source. Storage and searchIndex are
 * implemented as closures over `db` so they stay synchronous on top of
 * better-sqlite3.
 */
export function buildDocumentAdapterDeps(
  params: BuildDocumentAdapterDepsParams,
): DocumentAdapterDeps {
  const {
    db,
    ragCore,
    vectorStore,
    resolveEmbeddingClient,
    resolveConnector,
    aiSettingsManager,
    rateLimiter,
    log,
  } = params;
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

  // Local row-to-domain mappers (keep them co-located with the row types).
  const mapFolder = (r: RagFolderRow) => ({
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
  });

  const mapDocument = (r: RagDocumentRow) => ({
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
    // Defensive `?? null` for fixtures or pre-v9 rows.
    ingestError: (r as RagDocumentRow & { ingest_error?: string | null }).ingest_error ?? null,
  });

  const storage: import('@calame-ee/rag-core').DocumentStorage = {
    async listFolders(sourceId: string, parent?: string) {
      // The `parent` argument is accepted as a folder id OR a folder path.
      // MCP tools (rag_list_folders) pass a path (e.g. "D4.1", "/", "");
      // the UI and other callers may pass an id. Both forms are resolved
      // via a single lookup: SELECT id … WHERE id = ? OR path = ?.

      const normalised = normaliseFolderArg(parent);

      if (normalised === undefined || normalised === '') {
        // undefined or blank (covers "", "/", whitespace-only) → list ALL folders
        // for the source (root-level listing from the MCP tool's perspective).
        return ragDb.raw
          .prepare<
            [string],
            RagFolderRow
          >('SELECT * FROM rag_folders WHERE source_id = ? ORDER BY path ASC')
          .all(sourceId)
          .map(mapFolder);
      }

      // Resolve the normalised value to a folder id (id-or-path lookup).
      const folderId = resolveFolderId(ragDb.raw, sourceId, normalised);
      if (!folderId) return [];

      return ragDb.raw
        .prepare<
          [string, string],
          RagFolderRow
        >('SELECT * FROM rag_folders WHERE source_id = ? AND parent_id = ? ORDER BY path ASC')
        .all(sourceId, folderId)
        .map(mapFolder);
    },

    async listDocuments(sourceId: string, folder?: string) {
      // The `folder` argument is accepted as a folder id OR a folder path.
      // MCP tools (rag_list_documents) pass a path (e.g. "D4.1", "/", "");
      // the UI and other callers may pass an id. Both forms are resolved
      // via a single lookup: SELECT id … WHERE id = ? OR path = ?.

      const normalised = normaliseFolderArg(folder);

      if (normalised === undefined) {
        // No folder constraint → list ALL non-deleted documents for the source.
        return ragDb.raw
          .prepare<[string], RagDocumentRow>(
            `SELECT * FROM rag_documents
               WHERE source_id = ? AND deleted_at IS NULL
               ORDER BY path ASC`,
          )
          .all(sourceId)
          .map(mapDocument);
      }

      if (normalised === '') {
        // Blank after normalisation (covers "", "/") → root documents only
        // (documents that have no parent folder).
        return ragDb.raw
          .prepare<[string], RagDocumentRow>(
            `SELECT * FROM rag_documents
               WHERE source_id = ? AND folder_id IS NULL AND deleted_at IS NULL
               ORDER BY path ASC`,
          )
          .all(sourceId)
          .map(mapDocument);
      }

      // Resolve the normalised value to a folder id (id-or-path lookup).
      const folderId = resolveFolderId(ragDb.raw, sourceId, normalised);
      if (!folderId) return [];

      return ragDb.raw
        .prepare<[string, string], RagDocumentRow>(
          `SELECT * FROM rag_documents
             WHERE source_id = ? AND folder_id = ? AND deleted_at IS NULL
             ORDER BY path ASC`,
        )
        .all(sourceId, folderId)
        .map(mapDocument);
    },

    async getDocument(documentId: string) {
      const row = ragDb.raw
        .prepare<[string], RagDocumentRow>('SELECT * FROM rag_documents WHERE id = ?')
        .get(documentId);
      if (!row) return null;
      const chunks = ragDb.raw
        .prepare<
          [string],
          RagChunkRow
        >('SELECT * FROM rag_chunks WHERE document_id = ? ORDER BY position ASC')
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
          ingestError:
            (row as RagDocumentRow & { ingest_error?: string | null }).ingest_error ?? null,
        },
        text,
      };
    },

    async getDocumentFolderChain(documentId: string) {
      // Recursive CTE walks the rag_folders tree from the document's
      // immediate folder upward via `parent_id` until it hits the root
      // (or a missing link — Phase 6 doesn't enforce referential integrity
      // on parent_id so legacy rows with orphan parents stop cleanly).
      interface ChainRow {
        id: string;
        path: string;
      }
      const rows = ragDb.raw
        .prepare<[string], ChainRow>(
          `WITH RECURSIVE chain(id, parent_id, path) AS (
               SELECT f.id, f.parent_id, f.path
               FROM rag_folders f
               JOIN rag_documents d ON d.folder_id = f.id
               WHERE d.id = ?
               UNION ALL
               SELECT p.id, p.parent_id, p.path
               FROM rag_folders p
               JOIN chain c ON c.parent_id = p.id
             )
             SELECT id, path FROM chain`,
        )
        .all(documentId);
      return rows.map((r) => ({ id: r.id, path: r.path }));
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
          .prepare<
            [string],
            { embedding_setting_name: string }
          >('SELECT embedding_setting_name FROM rag_sources WHERE id = ? LIMIT 1')
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
            .sort((a, b) => (distanceMap.get(a.chunk_id) ?? 1) - (distanceMap.get(b.chunk_id) ?? 1))
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

  // Build the shared DocumentAdapterDeps and expose them on the runtime so
  // serve.ts can call registerMergedDocumentRagTools without rebuilding the
  // search index / storage closures.
  const deps: DocumentAdapterDeps = {
    resolveConnector,
    searchIndex,
    storage,
    piiMasking,
  };
  return deps;
}

/**
 * Register a DocumentSourceAdapter per source type into the global
 * SourceAdapterRegistry. Idempotent per-type via `has()` so a second call
 * (or a type already registered elsewhere) is a no-op rather than an error.
 */
export function registerDocumentAdapters(
  ragCore: typeof import('@calame-ee/rag-core'),
  deps: DocumentAdapterDeps,
  log: RagLogger,
): void {
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
