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
import { chunkText, type TokenChunkOptions } from '../chunker/token-chunker.js';
import { getParserForMimeType } from '../parsers/index.js';

/** Constructor dependencies for the ingestion pipeline. */
export interface IngestionPipelineDeps {
	/** SQLite handle wired to the same DB as the host. */
	db: BetterSqlite3Database;
	/** Vector store (typically a {@link SqliteVecStore}) sharing the same DB. */
	vectorStore: VectorStore;
	/** Embedding client used to produce vectors for new chunks. */
	embeddingClient: EmbeddingClient;
	/** Optional chunker overrides (maxTokens / overlap). */
	chunkOptions?: TokenChunkOptions;
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
	private readonly chunkOptions: TokenChunkOptions | undefined;

	constructor(deps: IngestionPipelineDeps) {
		this.db = deps.db;
		this.vectorStore = deps.vectorStore;
		this.embeddingClient = deps.embeddingClient;
		this.chunkOptions = deps.chunkOptions;
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
		const parser = getParserForMimeType(input.mimeType);
		const parsed = await parser(input.buffer);
		const chunks = chunkText(parsed.text, this.chunkOptions);
		const embeddings: number[][] =
			chunks.length > 0 ? await this.embeddingClient.embed(chunks.map((c) => c.text)) : [];

		if (embeddings.length !== chunks.length) {
			throw new Error(
				`IngestionPipeline: embedding count (${embeddings.length}) does not match chunk count (${chunks.length})`,
			);
		}

		const dimensions = this.embeddingClient.dimensions;
		const now = new Date().toISOString();

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
						 (id, source_id, folder_id, path, name, mime_type, size, hash, etag, last_indexed_at, deleted_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
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
						now,
					);
			}

			const insertChunk = this.db.prepare(
				`INSERT INTO rag_chunks
				 (id, document_id, position, text, token_count, embedding_dimensions, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
					now,
				);
				this.vectorStore.upsert(chunkId, Float32Array.from(embedding));
			}
		});

		persist();

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
