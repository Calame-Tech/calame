// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Request } from 'express';
import type { EmbeddingClient, VectorStore } from '../types.js';
import type { IngestionPipeline } from '../pipeline/ingest.js';
import type { SyncQueue } from '../jobs/sync-queue.js';
import type { PollScheduler } from '../jobs/poll-scheduler.js';
import type { WatchManager } from '../jobs/watch-manager.js';
import type { EmbeddingCapConfig } from '../jobs/embedding-cap.js';

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
	/**
	 * FIFO queue used by `POST /api/rag/sources/:id/sync` to schedule background
	 * sync jobs. The host wires a single shared instance (one queue per
	 * process) so deduping by `sourceId` works across all concurrent HTTP
	 * requests.
	 */
	syncQueue: SyncQueue;
	/**
	 * In-process timer registry that triggers periodic syncs for sources
	 * configured with `polling_interval_seconds`. The sources route handler
	 * calls `upsert` on POST/PATCH and `remove` on DELETE so the scheduler
	 * stays in sync with the persisted source set.
	 */
	pollScheduler: PollScheduler;
	/**
	 * Real-time filesystem watcher registry for sources whose connector
	 * supports `watch()` (today: `local` only). The sources route handler
	 * calls `upsert` on POST/PATCH and `remove` on DELETE so the manager
	 * stays in sync with the persisted source set.
	 */
	watchManager: WatchManager;
	/**
	 * Resolve the multi-tenant id for the supplied request (Phase A: always
	 * `'default'`). Wired by the host so `ee/rag-core` can stay decoupled
	 * from `packages/cli/src/tenancy.ts`. Routes pass `req` through; non-
	 * request contexts (background workers, schedulers) call this without
	 * an argument to obtain the default.
	 *
	 * The handler is optional so tests that build deps inline keep working —
	 * when absent, the routes fall back to the literal `'default'` so
	 * INSERTs still bind the column explicitly.
	 */
	getTenantId?: (req?: Request) => string;
	/** Optional audit hook called on success and failure. */
	onAudit?: (entry: RagAuditEntry) => void;
	/**
	 * Optional monthly embedding-token cap config. Wired by the host from the
	 * `CALAME_RAG_MONTHLY_TOKEN_CAP` env var. The usage route reads this to
	 * include `cap` in its response so the dashboard can render the progress
	 * bar / warning banners. When absent the cap section is reported as
	 * `monthlyTokenCap: 0` (unlimited) so the UI can render a unified shape.
	 */
	capConfig?: EmbeddingCapConfig;
	/**
	 * Optional structured logger injected by the host. Used by the sync worker
	 * to emit per-document progress at info/warn level so operators can observe
	 * mid-job failures without waiting for the terminal audit event.
	 * When absent all `deps.logger?.*` calls are no-ops.
	 */
	logger?: {
		info: (msg: string, meta?: Record<string, unknown>) => void;
		warn: (msg: string, meta?: Record<string, unknown>) => void;
	};
}
