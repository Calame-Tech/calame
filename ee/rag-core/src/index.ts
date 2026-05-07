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
} from './parsers/index.js';
export type { DocumentParser, ParsedDocument } from './parsers/types.js';

// ---------- Pipeline ----------
export { IngestionPipeline } from './pipeline/ingest.js';
export type { IngestionPipelineDeps, IngestDocumentInput } from './pipeline/ingest.js';

// ---------- Routes ----------
export { registerRagSourcesRoutes } from './routes/rag-sources.js';
export { registerRagContentRoutes } from './routes/rag-content.js';
export { registerRagUploadRoutes } from './routes/rag-upload.js';
export { registerRagIndexRoutes } from './routes/rag-index.js';
export { registerRagSearchRoutes } from './routes/rag-search.js';
export type {
	RagRouteDeps,
	RagAuditEntry,
	ResolvedEmbeddingSetting,
	ConnectorLike,
} from './routes/types.js';
export type { RagSourcePublic } from './routes/api-types.js';
