// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type {
	EmbeddingClient,
	RagDocument,
	RagFolder,
	RagSource,
	VectorStore,
} from '../types.js';
import { pickChunker } from '../chunker/index.js';
import type { ChunkOptions } from '../chunker/types.js';
import { getParserForMimeType } from '../parsers/index.js';
import { assertWithinCap, type EmbeddingCapConfig } from '../jobs/embedding-cap.js';

/** @deprecated Kept for backwards compatibility. Prefer `ChunkOptions`. */
export type TokenChunkOptions = ChunkOptions;

/** Constructor dependencies for the ingestion pipeline. */
export interface IngestionPipelineDeps {
	/** SQLite handle wired to the same DB as the host. */
	db: BetterSqlite3Database;
	/** Vector store (typically a {@link SqliteVecStore}) sharing the same DB. */
	vectorStore: VectorStore;
	/** Embedding client used to produce vectors for new chunks. */
	embeddingClient: EmbeddingClient;
	/** Optional chunker overrides (maxTokens / overlap / minTokens). */
	chunkOptions?: ChunkOptions;
	/**
	 * Optional hook fired once per `ingestDocument` call that actually embedded
	 * chunks (fast-path skips do NOT fire it). The `count` argument is the sum
	 * of `chunk.tokenCount` for every chunk sent to the embedding client.
	 *
	 * Why a callback rather than a return value: the pipeline is shared by the
	 * sync orchestrator (which aggregates over many documents per job row) AND
	 * the upload route (which records a single synthetic job per upload). A
	 * callback lets each caller decide how to accumulate without forcing every
	 * caller to thread the same wrapper API. Counts are precise because the
	 * chunker already computed `tokenCount` via gpt-tokenizer (o200k_base) —
	 * no extra round-trip to the provider is needed.
	 */
	onTokensEmbedded?: (count: number) => void;
	/**
	 * Optional monthly embedding-token cap. When set with `monthlyTokenCap > 0`,
	 * the pipeline calls {@link assertWithinCap} just BEFORE invoking the
	 * embedding client. If the pending embed would push the tenant's
	 * month-to-date total over the cap, the pipeline throws
	 * {@link EmbeddingCapExceededError} — no provider call is issued and no
	 * SQL writes occur (the cap check runs before the transaction opens).
	 *
	 * The sync orchestrator translates this into a `'failed'` job row with a
	 * clear `error` message; the UI surfaces it on the source card and the
	 * sync history panel. Undefined / `monthlyTokenCap <= 0` keeps the
	 * pre-cap behaviour (unbounded).
	 */
	capConfig?: EmbeddingCapConfig;
}

/** Inputs to {@link IngestionPipeline.ingestDocument}. */
export interface IngestDocumentInput {
	source: RagSource;
	folder: RagFolder | null;
	/** Source-relative path identifying the document. Must be stable across syncs. */
	path: string;
	mimeType: string;
	buffer: Buffer;
	/** Optional source-side ETag / version, when available. */
	etag?: string | null;
	/**
	 * Per-call override of the constructor-level `onTokensEmbedded` hook. When
	 * provided, this fires INSTEAD OF the constructor hook (not in addition),
	 * so each caller can choose to accumulate against its own counter. Skipped
	 * fast-path documents (hash match) do NOT fire the hook.
	 */
	onTokensEmbedded?: (count: number) => void;
}

interface DocumentRow {
	id: string;
	source_id: string;
	folder_id: string | null;
	path: string;
	name: string;
	mime_type: string;
	size: number;
	hash: string;
	etag: string | null;
	tenant_id: string;
	last_indexed_at: string;
	deleted_at: string | null;
}

function rowToDocument(row: DocumentRow): RagDocument {
	return {
		id: row.id,
		sourceId: row.source_id,
		folderId: row.folder_id,
		path: row.path,
		name: row.name,
		mimeType: row.mime_type,
		size: row.size,
		hash: row.hash,
		etag: row.etag,
		// Defensive `?? 'default'` for fixtures that bypass the migration.
		tenantId: row.tenant_id ?? 'default',
		lastIndexedAt: row.last_indexed_at,
		deletedAt: row.deleted_at,
	};
}

function sha256Hex(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

function deriveDocumentName(p: string): string {
	const base = path.basename(p);
	return base || p;
}

/**
 * Ingestion pipeline: parse → chunk → embed → persist. Handles incremental
 * updates by comparing content hashes (sha256) against the existing document
 * row keyed by `(source_id, path)`.
 */
export class IngestionPipeline {
	private readonly db: BetterSqlite3Database;
	private readonly vectorStore: VectorStore;
	private readonly embeddingClient: EmbeddingClient;
	private readonly chunkOptions: ChunkOptions | undefined;
	private readonly onTokensEmbedded: ((count: number) => void) | undefined;
	private readonly capConfig: EmbeddingCapConfig | undefined;

	constructor(deps: IngestionPipelineDeps) {
		this.db = deps.db;
		this.vectorStore = deps.vectorStore;
		this.embeddingClient = deps.embeddingClient;
		this.chunkOptions = deps.chunkOptions;
		this.onTokensEmbedded = deps.onTokensEmbedded;
		this.capConfig = deps.capConfig;
	}

	/**
	 * Ingest (or refresh) a single document. Returns the resulting
	 * {@link RagDocument} row. If the content hash matches the previously
	 * indexed copy, no work is performed.
	 */
	async ingestDocument(input: IngestDocumentInput): Promise<RagDocument> {
		const hash = sha256Hex(input.buffer);
		const name = deriveDocumentName(input.path);
		const size = input.buffer.byteLength;
		const folderId = input.folder?.id ?? null;
		const sourceId = input.source.id;

		const existing = this.db
			.prepare<[string, string], DocumentRow>(
				`SELECT * FROM rag_documents WHERE source_id = ? AND path = ?`,
			)
			.get(sourceId, input.path);

		// Fast path — same content.
		if (existing && existing.hash === hash && existing.deleted_at === null) {
			return rowToDocument(existing);
		}

		// Parse + chunk + embed BEFORE we touch the DB so we don't leave it half-written.
		// Pass the source-relative path so the dispatcher can route generic
		// `text/plain` to the code parser when the extension is recognized.
		const parser = getParserForMimeType(input.mimeType, input.path);
		const parsed = await parser(input.buffer, input.path);
		// Pick the chunker that matches the parser's declared format. Falls
		// back to the plain chunker when the parser omits a format hint.
		// For `code`, the chunker also needs the detected language and the
		// filename so it can emit a language-appropriate preamble.
		const chunker = pickChunker(parsed.format, {
			language: parsed.language,
			filename: parsed.filename ?? deriveDocumentName(input.path),
		});
		const chunks = chunker(parsed.text, this.chunkOptions);

		// Monthly embedding-cap gate. Runs BEFORE the provider call so we
		// never pay for tokens we're about to refuse to persist. The chunker
		// has already computed `tokenCount` for every chunk via
		// gpt-tokenizer — accurate enough for cap accounting (the cap is a
		// kill-switch, not invoice reconciliation). When `capConfig` is
		// undefined or `monthlyTokenCap <= 0`, `assertWithinCap` is a no-op.
		// Defensive tenant fallback mirrors the one below (line ~182) so a
		// caller that built `RagSource` before Phase A still gates against
		// 'default'.
		if (this.capConfig && chunks.length > 0) {
			const attempted = chunks.reduce((sum, c) => sum + c.tokenCount, 0);
			const tenantForCap: string = input.source.tenantId ?? 'default';
			assertWithinCap(
				{ db: this.db, config: this.capConfig },
				tenantForCap,
				attempted,
			);
		}

		const embeddings: number[][] =
			chunks.length > 0 ? await this.embeddingClient.embed(chunks.map((c) => c.text)) : [];

		if (embeddings.length !== chunks.length) {
			throw new Error(
				`IngestionPipeline: embedding count (${embeddings.length}) does not match chunk count (${chunks.length})`,
			);
		}

		const dimensions = this.embeddingClient.dimensions;
		const now = new Date().toISOString();
		// Phase A multi-tenancy — the document inherits the parent source's
		// tenant. Defensive fallback to `'default'` covers callers (mostly
		// tests) that built a `RagSource` object before the `tenantId` field
		// existed.
		const tenantId: string = input.source.tenantId ?? 'default';

		// Reuse id when updating; new id otherwise.
		const documentId = existing ? existing.id : nanoid();

		// Wrap the write in a transaction. Vector store upserts are NOT inside the
		// SQL transaction (sqlite-vec writes through the same connection so they
		// are atomic with the surrounding transaction by default).
		const persist = this.db.transaction(() => {
			if (existing) {
				// Drop old chunks (vector + relational) before re-inserting.
				this.vectorStore.deleteByDocument(existing.id);
				this.db
					.prepare(`DELETE FROM rag_chunks WHERE document_id = ?`)
					.run(existing.id);
				this.db
					.prepare(
						`UPDATE rag_documents
						 SET folder_id = ?, name = ?, mime_type = ?, size = ?, hash = ?, etag = ?,
						     last_indexed_at = ?, deleted_at = NULL
						 WHERE id = ?`,
					)
					.run(
						folderId,
						name,
						input.mimeType,
						size,
						hash,
						input.etag ?? null,
						now,
						existing.id,
					);
			} else {
				this.db
					.prepare(
						`INSERT INTO rag_documents
						 (id, source_id, folder_id, path, name, mime_type, size, hash, etag,
						  tenant_id, last_indexed_at, deleted_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
					)
					.run(
						documentId,
						sourceId,
						folderId,
						input.path,
						name,
						input.mimeType,
						size,
						hash,
						input.etag ?? null,
						tenantId,
						now,
					);
			}

			const insertChunk = this.db.prepare(
				`INSERT INTO rag_chunks
				 (id, document_id, position, text, token_count, embedding_dimensions,
				  tenant_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			);

			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i]!;
				const embedding = embeddings[i]!;
				if (embedding.length !== dimensions) {
					throw new Error(
						`IngestionPipeline: embedding[${i}] has length ${embedding.length}, expected ${dimensions}`,
					);
				}
				const chunkId = nanoid();
				insertChunk.run(
					chunkId,
					documentId,
					chunk.position,
					chunk.text,
					chunk.tokenCount,
					dimensions,
					tenantId,
					now,
				);
				this.vectorStore.upsert(chunkId, Float32Array.from(embedding));
			}
		});

		persist();

		// Fire the tokens-embedded hook after persistence succeeds, so a thrown
		// transaction doesn't credit tokens we never actually used. Counts come
		// straight from the chunker (gpt-tokenizer, o200k_base) — no extra
		// provider round-trip required. Skipped fast-path returns above don't
		// reach this code, which is by design: a hash-match doesn't re-embed.
		if (chunks.length > 0) {
			const tokensEmbedded = chunks.reduce((sum, c) => sum + c.tokenCount, 0);
			const hook = input.onTokensEmbedded ?? this.onTokensEmbedded;
			hook?.(tokensEmbedded);
		}

		const refreshed = this.db
			.prepare<[string], DocumentRow>(`SELECT * FROM rag_documents WHERE id = ?`)
			.get(documentId);
		if (!refreshed) throw new Error(`IngestionPipeline: document ${documentId} vanished after insert`);
		return rowToDocument(refreshed);
	}

	/**
	 * Soft-delete a document: drop its vector entries and chunks, then mark
	 * `deleted_at`. The row is preserved for audit history.
	 */
	markDocumentDeleted(documentId: string): void {
		const now = new Date().toISOString();
		const apply = this.db.transaction(() => {
			this.vectorStore.deleteByDocument(documentId);
			this.db.prepare(`DELETE FROM rag_chunks WHERE document_id = ?`).run(documentId);
			this.db
				.prepare(`UPDATE rag_documents SET deleted_at = ? WHERE id = ?`)
				.run(now, documentId);
		});
		apply();
	}
}
