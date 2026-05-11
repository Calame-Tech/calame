// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

// ---------- Types ----------
export type {
	EmbeddingClient,
	ProfileRagAccess,
	RagChunk,
	RagDocument,
	RagFolder,
	RagJob,
	RagJobStatus,
	RagSearchResult,
	RagSource,
	RagSourceType,
	VectorStore,
} from './types.js';

// ---------- Storage ----------
export { runRagMigrations } from './storage/schema.js';
export type { RagMigrationDb } from './storage/schema.js';
export {
	SqliteVecStore,
	SqliteVecLoadError,
	SqliteVecDimensionMismatchError,
	resetVecTableIfDimensionMismatch,
} from './storage/sqlite-vec-store.js';

// ---------- Chunker ----------
export {
	pickChunker,
	chunkPlainText,
	chunkMarkdown,
	chunkCsv,
	chunkCode,
	countTokens,
} from './chunker/index.js';
export type {
	Chunk,
	ChunkOptions,
	Chunker,
	CodeChunkOptions,
	CodeChunkExtraOptions,
	PickChunkerHints,
} from './chunker/index.js';
// Legacy aliases — keep external consumers building until the next major.
export { chunkText } from './chunker/token-chunker.js';
export type { TokenChunk, TokenChunkOptions } from './chunker/token-chunker.js';

// ---------- Embeddings ----------
export {
	OpenAiCompatibleEmbeddingClient,
	createEmbeddingClient,
	EmbeddingNotSupportedError,
	EmbeddingModelMissingError,
	EmbeddingBaseUrlMissingError,
} from './embeddings/openai-client.js';
export type {
	OpenAiCompatibleEmbeddingClientOptions,
	EmbeddingSettingShape,
} from './embeddings/openai-client.js';

// ---------- Parsers ----------
export {
	getParserForMimeType,
	listSupportedMimeTypes,
	UnsupportedMimeTypeError,
	pdfParser,
	docxParser,
	markdownParser,
	csvParser,
	htmlParser,
	codeParser,
	detectLanguageFromFilename,
} from './parsers/index.js';
export type {
	DocumentParser,
	ParsedDocument,
	ParsedDocumentFormat,
	CodeLanguage,
} from './parsers/types.js';

// ---------- Pipeline ----------
export { IngestionPipeline } from './pipeline/ingest.js';
export type { IngestionPipelineDeps, IngestDocumentInput } from './pipeline/ingest.js';

// ---------- Jobs ----------
export { SyncQueue, recoverOrphanedJobs } from './jobs/sync-queue.js';
export type { SyncQueueDeps } from './jobs/sync-queue.js';
export { PollScheduler } from './jobs/poll-scheduler.js';
export type { PollSchedulerDeps, PollAuditEntry } from './jobs/poll-scheduler.js';
export { WatchManager } from './jobs/watch-manager.js';
export type {
	WatchManagerDeps,
	WatchAuditEntry,
	WatchableConnector,
} from './jobs/watch-manager.js';
export { RateLimiter, DEFAULT_LIMITS } from './jobs/rate-limiter.js';
export type {
	RateLimit,
	RateLimiterDeps,
	RateLimitAuditEntry,
} from './jobs/rate-limiter.js';
export { runSoftDeleteCleanup } from './jobs/soft-delete-cleanup.js';
export type {
	SoftDeleteCleanupDeps,
	SoftDeleteCleanupResult,
	SoftDeleteCleanupAuditEntry,
} from './jobs/soft-delete-cleanup.js';
export { runSyncJob } from './routes/rag-index.js';

// ---------- Source Adapter ----------
export { buildDocumentSourceAdapter } from './source-adapter.js';
export type {
	DocumentAdapterDeps,
	LocalDocumentAdapterConfig,
	ConnectorLike as DocumentConnectorLike,
	DocumentSearchIndex,
	DocumentStorage,
} from './source-adapter.js';

// ---------- PII Masking ----------
export { parseRagPiiConfig, maskSearchResult } from './pii-masking.js';
export type { RagPiiMaskingConfig } from './pii-masking.js';

// ---------- Search ----------
export { HybridSearchIndex, escapeFtsQuery } from './search/hybrid-search.js';
export type { HybridSearchDeps } from './search/hybrid-search.js';
export { CohereReranker, RerankerError } from './search/reranker.js';
export type {
	Reranker,
	RerankerInput,
	RerankerResult,
	CohereRerankerConfig,
} from './search/reranker.js';
export { RerankingSearchIndex } from './search/reranking-search-index.js';
export type { RerankingSearchDeps, RerankAuditEntry } from './search/reranking-search-index.js';

// ---------- Routes ----------
export { registerRagSourcesRoutes } from './routes/rag-sources.js';
export { registerRagContentRoutes } from './routes/rag-content.js';
export { registerRagUploadRoutes } from './routes/rag-upload.js';
export { registerRagIndexRoutes } from './routes/rag-index.js';
export { registerRagSearchRoutes } from './routes/rag-search.js';
export { registerRagUsageRoutes } from './routes/rag-usage.js';
export type { RagUsageResponse } from './routes/rag-usage.js';
export type {
	RagRouteDeps,
	RagAuditEntry,
	ResolvedEmbeddingSetting,
	ConnectorLike,
} from './routes/types.js';
export type { RagSourcePublic } from './routes/api-types.js';

// ---------- Pricing ----------
export {
	EMBEDDING_PRICES_PER_1M_TOKENS,
	estimateCostUsd,
	isKnownEmbeddingModel,
} from './pricing.js';
