// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { EmbeddingClient, VectorStore } from '../types.js';
import type { IngestionPipeline } from '../pipeline/ingest.js';

/** Audit hook entry — matches the shape used by the host's audit log. */
export interface RagAuditEntry {
	type: string;
	payload: unknown;
	timestamp: string;
}

/**
 * Minimal duck-typed shape of a DocumentSourceConnector that route handlers
 * need. Defined here (and not imported from @calame-ee/rag-connectors) to keep
 * the dependency direction one-way (rag-connectors → rag-core, never back).
 */
export interface ConnectorLike {
	type: string;
	testConnection(config: Record<string, unknown>): Promise<void>;
	listFolders(
		config: Record<string, unknown>,
		sourceId: string,
		parent?: { id: string; path: string } | undefined,
	): Promise<Array<{ id: string; sourceId: string; parentId: string | null; path: string; name: string; createdAt: string }>>;
	listDocuments(
		config: Record<string, unknown>,
		sourceId: string,
		folder?: { id: string; path: string } | undefined,
	): Promise<Array<{ id: string; sourceId: string; folderId: string | null; path: string; name: string; mimeType: string; size: number; hash: string; etag: string | null; lastIndexedAt: string; deletedAt: string | null }>>;
	fetchDocument(
		config: Record<string, unknown>,
		sourceId: string,
		docId: string,
	): Promise<{ stream: NodeJS.ReadableStream; mimeType: string }>;
}

/**
 * Resolves an embedding-capable AI setting to its concrete `(model, dimensions)`
 * pair. Used at source-create time to derive `embedding_model_version` and
 * `embedding_dimensions` from a single user-facing field (`embeddingSettingName`).
 *
 * Implementations MUST throw when:
 *  - the setting does not exist,
 *  - the setting does not advertise the `embeddings` capability,
 *  - the embedding model is not in the host's known model→dim map.
 */
export interface ResolvedEmbeddingSetting {
	embeddingModel: string;
	dimensions: number;
}

/**
 * Shared dependencies wired by the host (packages/cli) when registering RAG
 * routes. Keeps ee/rag-core decoupled from packages/cli internals.
 */
export interface RagRouteDeps {
	/** SQLite handle, shared with the host's CalameDatabase. */
	db: BetterSqlite3Database;
	/** Pipeline used to (re)index documents. */
	pipeline: IngestionPipeline;
	/** Vector store backing the search endpoint. */
	vectorStore: VectorStore;
	/**
	 * Resolves an EmbeddingClient from an AI setting name. Wired by the host
	 * from `AiSettingsManager.getSetting()` + a known dimension.
	 */
	resolveEmbeddingClient: (settingName: string) => EmbeddingClient;
	/**
	 * Resolves the `(model, dimensions)` pair for an AI setting name. Used at
	 * source-create / source-update time to materialize `embedding_model_version`
	 * and `embedding_dimensions` without requiring the client to send them.
	 */
	resolveEmbeddingSetting: (settingName: string) => ResolvedEmbeddingSetting;
	/** Encrypt connector configuration before persisting. */
	encryptConfig: (plaintext: string) => string;
	/** Decrypt connector configuration on read. */
	decryptConfig: (encrypted: string) => string;
	/**
	 * Resolves a connector instance for a given source type. The host pre-loads
	 * `@calame-ee/rag-connectors` (when installed) and exposes connector
	 * instances via this lookup.
	 */
	resolveConnector?: (type: string) => ConnectorLike | null;
	/** Optional audit hook called on success and failure. */
	onAudit?: (entry: RagAuditEntry) => void;
}
