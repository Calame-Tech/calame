// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { VectorStore } from '../types.js';

/**
 * Thrown when sqlite-vec cannot be loaded into the better-sqlite3 instance.
 * This typically happens on Windows when the native binary needs a rebuild.
 */
export class SqliteVecLoadError extends Error {
	constructor(cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(
			`Failed to load sqlite-vec extension. On Windows, run "pnpm rebuild" to ` +
				`rebuild the native better-sqlite3 binding, then retry. Underlying error: ${reason}`,
		);
		this.name = 'SqliteVecLoadError';
	}
}

/**
 * Thrown when an existing rag_chunks_vec table has a different dimension than
 * the one requested by this store instance.
 */
export class SqliteVecDimensionMismatchError extends Error {
	constructor(existing: number, requested: number) {
		super(
			`rag_chunks_vec already exists with dimension=${existing}, but this store ` +
				`was constructed with dimension=${requested}. The vector table dimension is ` +
				`fixed at create time — drop or migrate the table before changing dimension.`,
		);
		this.name = 'SqliteVecDimensionMismatchError';
	}
}

/**
 * Attempt to drop and recreate the vec0 table when its declared dimension
 * differs from `requestedDimension` AND no chunks would be lost (rag_chunks
 * table is empty). Returns `true` when a reset happened.
 *
 * Use case: an admin switches embedding model in their AI setting before
 * indexing anything. The vec0 table was created with the old dimension at the
 * first boot; we can safely recreate it with the new dimension.
 *
 * Refuses to drop when chunks exist — the caller gets `false` and should
 * surface a clear error.
 */
export function resetVecTableIfDimensionMismatch(
	db: BetterSqlite3Database,
	requestedDimension: number,
): { reset: boolean; reason?: string; previousDimension?: number; chunkCount?: number } {
	const existing = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='rag_chunks_vec'`)
		.get() as { sql: string } | undefined;
	if (!existing) return { reset: false, reason: 'no-table' };

	const match = /FLOAT\[(\d+)\]/i.exec(existing.sql);
	const declared = match ? Number.parseInt(match[1] ?? '0', 10) : 0;
	if (declared === requestedDimension) return { reset: false, reason: 'dimension-matches' };

	const chunkRow = db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks`).get() as { n: number };
	if (chunkRow.n > 0) {
		return {
			reset: false,
			reason: 'chunks-present',
			previousDimension: declared,
			chunkCount: chunkRow.n,
		};
	}

	// Safe to recreate. sqlite-vec must be loaded to DROP a vec0 virtual table.
	try {
		sqliteVec.load(db);
	} catch (error) {
		throw new SqliteVecLoadError(error);
	}
	db.exec('DROP TABLE rag_chunks_vec');
	return { reset: true, previousDimension: declared };
}

/**
 * sqlite-vec backed vector store. Stores chunk embeddings in a vec0 virtual
 * table keyed by `chunk_id`. The vector dimension is fixed at table-create time
 * and validated on construction.
 */
export class SqliteVecStore implements VectorStore {
	private readonly db: BetterSqlite3Database;
	private readonly dimensions: number;
	private readonly stmtUpsert: Statement;
	private readonly stmtSearch: Statement;
	private readonly stmtDelete: Statement;
	private readonly stmtDeleteByDocument: Statement;

	constructor(db: BetterSqlite3Database, dimensions: number) {
		if (!Number.isInteger(dimensions) || dimensions <= 0) {
			throw new Error(`SqliteVecStore: dimensions must be a positive integer, got ${dimensions}`);
		}
		this.db = db;
		this.dimensions = dimensions;

		try {
			sqliteVec.load(db);
		} catch (error) {
			throw new SqliteVecLoadError(error);
		}

		this.ensureVecTable();

		this.stmtUpsert = db.prepare(
			`INSERT OR REPLACE INTO rag_chunks_vec (chunk_id, embedding) VALUES (?, ?)`,
		);
		this.stmtSearch = db.prepare(
			`SELECT chunk_id AS chunkId, distance FROM rag_chunks_vec
			 WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
		);
		this.stmtDelete = db.prepare(`DELETE FROM rag_chunks_vec WHERE chunk_id = ?`);
		this.stmtDeleteByDocument = db.prepare(
			`DELETE FROM rag_chunks_vec WHERE chunk_id IN (
			   SELECT id FROM rag_chunks WHERE document_id = ?
			 )`,
		);
	}

	/**
	 * Create the vec0 virtual table if missing, otherwise validate that its
	 * declared dimension matches. The dimension is fixed at create time.
	 */
	private ensureVecTable(): void {
		const existing = this.db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='rag_chunks_vec'`)
			.get() as { sql: string } | undefined;

		if (existing) {
			const match = /FLOAT\[(\d+)\]/i.exec(existing.sql);
			const declared = match ? Number.parseInt(match[1] ?? '0', 10) : 0;
			if (declared !== this.dimensions) {
				throw new SqliteVecDimensionMismatchError(declared, this.dimensions);
			}
			return;
		}

		this.db.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_vec USING vec0(
			   chunk_id TEXT PRIMARY KEY,
			   embedding FLOAT[${this.dimensions}]
			 )`,
		);
	}

	upsert(chunkId: string, embedding: Float32Array): void {
		if (embedding.length !== this.dimensions) {
			throw new Error(
				`SqliteVecStore.upsert: embedding length=${embedding.length} does not match ` +
					`store dimension=${this.dimensions}`,
			);
		}
		// sqlite-vec accepts a Buffer view of a Float32Array as a vector blob.
		this.stmtUpsert.run(chunkId, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
	}

	search(query: Float32Array, topK: number): Array<{ chunkId: string; distance: number }> {
		if (query.length !== this.dimensions) {
			throw new Error(
				`SqliteVecStore.search: query length=${query.length} does not match ` +
					`store dimension=${this.dimensions}`,
			);
		}
		if (!Number.isInteger(topK) || topK <= 0) {
			throw new Error(`SqliteVecStore.search: topK must be a positive integer, got ${topK}`);
		}
		const blob = Buffer.from(query.buffer, query.byteOffset, query.byteLength);
		return this.stmtSearch.all(blob, topK) as Array<{ chunkId: string; distance: number }>;
	}

	delete(chunkId: string): void {
		this.stmtDelete.run(chunkId);
	}

	deleteByDocument(documentId: string): void {
		this.stmtDeleteByDocument.run(documentId);
	}
}
