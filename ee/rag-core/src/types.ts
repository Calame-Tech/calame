// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Type of a document source. Extensible: new connectors can register their own
 * type strings. Kept as a string union so a connector author can widen it via
 * declaration merging if needed.
 */
export type RagSourceType =
  | 'local'
  | 's3'
  | 'http'
  | 'gdrive'
  | 'gsheets'
  | 'sharepoint'
  | 'notion'
  | 'git';

/**
 * A configured document source. The actual connector configuration (credentials,
 * root paths, polling intervals, etc.) is stored as an opaque encrypted blob in
 * `configEncrypted` — decryption is handled at the API boundary.
 */
export interface RagSource {
  id: string;
  name: string;
  type: RagSourceType;
  /** Opaque encrypted configuration blob — connector-specific shape after decrypt. */
  configEncrypted: string;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  /** Reference to AiSetting.name used to compute embeddings for this source. */
  embeddingSettingName: string;
  /** Frozen embedding model identifier captured at index time, for traceability. */
  embeddingModelVersion: string;
  /**
   * Optional auto-sync interval in seconds. When set, the in-process PollScheduler
   * triggers a background sync every N seconds. Range enforced at the API
   * boundary: 60s ≤ N ≤ 86400s (1 minute to 24 hours). `null` / `undefined`
   * means "manual sync only".
   */
  pollingIntervalSeconds?: number | null;
  /**
   * Multi-tenancy foundation (Phase A) — see migration v6 in
   * `storage/schema.ts`. Always `'default'` today; will be resolved from the
   * authenticated request in Phase B. Child rows (`rag_folders`,
   * `rag_documents`, `rag_chunks`, `rag_jobs`) inherit this value at INSERT
   * time so a future `WHERE tenant_id = ?` filter can be applied uniformly.
   */
  tenantId: string;
  /**
   * Soft-delete marker — see migration v8 in `storage/schema.ts`. When non-
   * null (ISO timestamp), the source is hidden from every listing query,
   * the poll scheduler / watch manager skip it on boot, and the cleanup
   * cron (`jobs/soft-delete-cleanup.ts`) hard-deletes it once
   * `deleted_at < now - 7 days`. Cascading FKs drop every dependent
   * `rag_folders` / `rag_documents` / `rag_chunks` / `rag_jobs` row in the
   * same transaction.
   */
  deletedAt: string | null;
}

/**
 * A logical folder inside a source. Hierarchical via `parentId`.
 *
 * Note on `tenantId`: optional so connectors (`ee/rag-connectors`) can
 * construct `RagFolder` instances without knowing about tenancy. The host
 * enriches the object with `tenantId` inherited from the parent source at
 * the storage boundary; downstream code reads the value off the SQLite row
 * (or via `rowToFolder`) where it is always present after migration v6.
 */
export interface RagFolder {
  id: string;
  sourceId: string;
  parentId: string | null;
  /** Full path / S3 prefix / Drive folder path. */
  path: string;
  name: string;
  createdAt: string;
  /**
   * Multi-tenancy (Phase A) — inherited from the parent source. Optional in
   * the type so connector-built instances don't need to set it; the host
   * enriches it before persisting.
   */
  tenantId?: string;
}

/**
 * A document tracked by the RAG layer. Soft-deleted via `deletedAt` to preserve
 * audit history.
 *
 * See {@link RagFolder} for the rationale behind the optional `tenantId`.
 */
export interface RagDocument {
  id: string;
  sourceId: string;
  folderId: string | null;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  /** Content hash (sha256) used for incremental sync. */
  hash: string;
  /** Source-provided ETag / version, when available. */
  etag: string | null;
  lastIndexedAt: string;
  deletedAt: string | null;
  /**
   * Non-null when the last sync attempted to ingest this file but the
   * pipeline couldn't process it (e.g. unsupported MIME type, parser error).
   * The document row is kept so the file still shows up in the tree view —
   * the frontend renders a badge using this message. NULL on healthy docs.
   *
   * Cleared automatically when a subsequent sync succeeds (e.g. after a new
   * parser is added for the format).
   */
  ingestError: string | null;
  /**
   * Multi-tenancy (Phase A) — inherited from the parent source. Optional in
   * the type so connector-built instances don't need to set it; the host
   * enriches it before persisting.
   */
  tenantId?: string;
}

/**
 * A chunk of a document used for retrieval. The embedding vector itself is
 * stored separately in a sqlite-vec virtual table and looked up by `id`.
 */
export interface RagChunk {
  id: string;
  documentId: string;
  /** 0-based ordinal of the chunk within its document. */
  position: number;
  text: string;
  tokenCount: number;
  embeddingDimensions: number;
  /** Multi-tenancy (Phase A) — inherited from the parent source. Optional. */
  tenantId?: string;
}

export type RagJobStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * State of an ingestion / re-index job. Useful for the UI progress card.
 */
export interface RagJob {
  id: string;
  sourceId: string;
  status: RagJobStatus;
  /** Progress in [0, 1]. */
  progress: number;
  totalDocuments: number;
  processedDocuments: number;
  /** Documents skipped pre-fetch because their source-side etag matched the indexed copy. */
  skippedByEtag: number;
  /** Documents soft-deleted by the GC pass because they were absent from the source listing. */
  gcDeleted: number;
  /**
   * Sum of `chunk.tokenCount` for every chunk actually sent to the embedding
   * client during this job. Skipped fast-path documents (hash match) do NOT
   * contribute. Populated at job completion (single UPDATE at the end of
   * `runSyncJob` / `rag-upload`). Defaults to 0 for pre-v7 rows.
   */
  tokensEmbedded: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Multi-tenancy (Phase A) — inherited from the parent source. Optional. */
  tenantId?: string;
}

/**
 * Per-profile RAG access allowlist. Three granularities supported in parallel:
 *  - source: everything in the source, present and future.
 *  - folder: everything under the folder, recursive, including future files.
 *  - document: exact file allowlist; new files are NOT auto-included.
 */
export interface ProfileRagAccess {
  allowedSources: string[];
  allowedFolders: Record<string, string[]>;
  allowedDocuments: Record<string, string[]>;
}

/**
 * Vector store abstraction. Implemented later by the sqlite-vec adapter
 * (default) and potentially by pgvector / Qdrant adapters in `ee/rag-advanced`.
 */
export interface VectorStore {
  upsert(chunkId: string, embedding: Float32Array): void;
  search(query: Float32Array, topK: number): Array<{ chunkId: string; distance: number }>;
  delete(chunkId: string): void;
  deleteByDocument(documentId: string): void;
}

/**
 * Embedding client abstraction. Implementations wrap an `AiSetting` from
 * `packages/cli/src/ai-config.ts` whose `capabilities` includes `embeddings`.
 */
export interface EmbeddingClient {
  /** Number of dimensions produced by the underlying model. */
  dimensions: number;
  /** Human-readable model identifier, persisted as `embeddingModelVersion`. */
  modelName: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Result of a `rag_search` call. Each chunk is enriched with the metadata the
 * LLM and audit log need to trace back to the original document.
 */
export interface RagSearchResult {
  chunks: Array<{
    text: string;
    score: number;
    sourceId: string;
    folder: string;
    fileName: string;
    position: number;
    documentId: string;
  }>;
}
