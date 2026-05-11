// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * HybridSearchIndex — combines SQLite FTS5 keyword search with vector
 * similarity through Reciprocal Rank Fusion (RRF).
 *
 * Pure vector search (the previous default) struggles with proper nouns,
 * acronyms, and rare technical terms because their embeddings cluster
 * with semantically-similar but lexically-different content. Adding a
 * keyword branch and fusing the two ranked lists with RRF (k=60 from the
 * original paper) materially improves recall on exact-match queries
 * without hurting recall on semantic ones.
 *
 * Architectural notes:
 *
 *  - Implementation of {@link DocumentSearchIndex} so the host can swap
 *    the previous vector-only adapter in `packages/cli/src/rag-runtime.ts`
 *    without touching the MCP `rag_search` tool or any other consumer.
 *
 *  - The FTS5 mirror table (`rag_chunks_fts`) is created and kept in
 *    sync by the v5 RAG schema migration via INSERT / UPDATE / DELETE
 *    triggers on `rag_chunks`. See storage/schema.ts.
 *
 *  - When the FTS table is absent (pre-v5 DB) the index transparently
 *    falls back to pure vector search and logs a one-time warning.
 *
 *  - Commercial frontier: this module is in `ee/rag-core/` today; if the
 *    Pro vs Free boundary later moves hybrid + reranker into a separate
 *    `ee/rag-advanced` package, only this file plus the FTS5 migration
 *    block move with it. The `DocumentSearchIndex` interface is the
 *    stable contract.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { DocumentSearchIndex } from '../source-adapter.js';
import type { EmbeddingClient, RagSearchResult, VectorStore } from '../types.js';

/** Constructor dependencies for the HybridSearchIndex. */
export interface HybridSearchDeps {
	/** Shared SQLite handle. Must already have the v5 RAG schema applied. */
	db: BetterSqlite3Database;
	/** Vector store providing the semantic-similarity branch. */
	vectorStore: VectorStore;
	/**
	 * Resolver from a source's `embedding_setting_name` to the
	 * matching EmbeddingClient. Mirrors the resolver wired by the host
	 * in rag-runtime.ts; passed in to avoid coupling this module to
	 * the AI settings layer.
	 */
	resolveEmbeddingClient: (settingName: string) => EmbeddingClient;
	/**
	 * Reciprocal Rank Fusion constant. Default 60 per the original
	 * Cormack/Clarke/Buettcher 2009 paper. Increase to flatten the
	 * curve (favours wide coverage); decrease to sharpen it (favours
	 * top hits in each list).
	 */
	rrfK?: number;
	/**
	 * How many candidates to retrieve from EACH branch (vector and
	 * keyword) before fusing. Larger values improve recall but cost
	 * more SQL / vector work. Default 50.
	 */
	candidatesPerMethod?: number;
	/**
	 * Optional logger used for the pre-v5 fallback warning. Defaults
	 * to a no-op so tests don't pollute stdout.
	 */
	logger?: { warn: (msg: string) => void };
}

const DEFAULT_RRF_K = 60;
const DEFAULT_CANDIDATES_PER_METHOD = 50;

interface FtsRow {
	chunk_id: string;
	chunk_text: string;
	chunk_position: number;
	doc_id: string;
	doc_source_id: string;
	doc_name: string;
	folder_path: string | null;
	mime_type: string;
	keyword_score: number;
}

interface VectorJoinRow {
	chunk_id: string;
	chunk_text: string;
	chunk_position: number;
	doc_id: string;
	doc_source_id: string;
	doc_name: string;
	folder_path: string | null;
	mime_type: string;
}

interface ChunkMetadata {
	text: string;
	position: number;
	documentId: string;
	sourceId: string;
	fileName: string;
	folder: string;
}

/**
 * Escape a user-supplied query for FTS5. The MATCH parser treats a number
 * of characters as syntax (parentheses, quotes, `:`, `*`, `^`, `-`, …).
 * For the MVP we strip everything outside a permissive alphanumeric +
 * Unicode-letter set and collapse runs of whitespace; the resulting token
 * stream is passed to FTS5 as a plain bag-of-words MATCH expression.
 *
 * Returns an empty string when the cleaned query has no tokens — callers
 * should skip the FTS branch in that case rather than executing a MATCH
 * with an empty pattern (which would throw).
 *
 * Note: this is intentionally simple. A production-grade FTS5 query
 * builder (phrase queries, NEAR, etc.) is out of scope for this tranche.
 */
export function escapeFtsQuery(query: string): string {
	// Allow letters (incl. Unicode latin range À-ſ), digits, underscores
	// and whitespace; replace everything else with a space.
	const cleaned = query.replace(/[^a-zA-Z0-9_\sÀ-ſ]+/g, ' ').trim().replace(/\s+/g, ' ');
	if (cleaned.length === 0) return '';
	// Wrap each term in double quotes to force FTS5 to treat it literally —
	// this dodges the rare case where a stray reserved keyword (AND, OR,
	// NOT, NEAR) sneaks through after the strip above.
	const terms = cleaned.split(' ').map((t) => `"${t}"`);
	return terms.join(' OR ');
}

/**
 * Check whether the FTS5 mirror table is present in the DB. Cheap —
 * a single SELECT against sqlite_master.
 */
function ftsTableExists(db: BetterSqlite3Database): boolean {
	const row = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rag_chunks_fts'`)
		.get() as { name: string } | undefined;
	return row !== undefined;
}

export class HybridSearchIndex implements DocumentSearchIndex {
	private readonly db: BetterSqlite3Database;
	private readonly vectorStore: VectorStore;
	private readonly resolveEmbeddingClient: (settingName: string) => EmbeddingClient;
	private readonly rrfK: number;
	private readonly candidatesPerMethod: number;
	private readonly logger: { warn: (msg: string) => void };
	/** True once we've logged the "FTS table missing" fallback so we don't spam. */
	private fallbackWarned = false;

	constructor(deps: HybridSearchDeps) {
		this.db = deps.db;
		this.vectorStore = deps.vectorStore;
		this.resolveEmbeddingClient = deps.resolveEmbeddingClient;
		this.rrfK = deps.rrfK ?? DEFAULT_RRF_K;
		this.candidatesPerMethod = deps.candidatesPerMethod ?? DEFAULT_CANDIDATES_PER_METHOD;
		this.logger = deps.logger ?? { warn: () => {} };
	}

	async search(
		sourceId: string,
		query: string,
		opts: {
			topK: number;
			folders?: readonly string[];
			fileTypes?: readonly string[];
		},
	): Promise<RagSearchResult> {
		const topK = Math.max(1, opts.topK);
		const candidates = Math.max(topK, this.candidatesPerMethod);

		// Resolve the embedding setting for this source — the vector branch
		// needs to embed the query in the same model used at index time.
		// Filter out soft-deleted sources (v8) so a retired source returns
		// empty results instead of leaking dangling chunks.
		const settingRow = this.db
			.prepare<[string], { embedding_setting_name: string }>(
				'SELECT embedding_setting_name FROM rag_sources WHERE id = ? AND deleted_at IS NULL LIMIT 1',
			)
			.get(sourceId);
		if (!settingRow) return { chunks: [] };

		const hasFts = ftsTableExists(this.db);
		if (!hasFts && !this.fallbackWarned) {
			this.logger.warn(
				'HybridSearchIndex: rag_chunks_fts is missing (pre-v5 schema?). Falling back to pure vector search.',
			);
			this.fallbackWarned = true;
		}

		// ----- Vector branch ----------------------------------------------------
		// We over-fetch (candidates * 3) when folder/fileType filters are active
		// so the post-SQL filter has room to discard non-matches. Without filters
		// the over-fetch is unnecessary; clamp to `candidates` to avoid wasted
		// work.
		const overFetch =
			(opts.folders && opts.folders.length > 0) || (opts.fileTypes && opts.fileTypes.length > 0)
				? candidates * 3
				: candidates;

		let vectorRanked: Array<{ chunkId: string; meta: ChunkMetadata }> = [];
		try {
			const client = this.resolveEmbeddingClient(settingRow.embedding_setting_name);
			const vectors = await client.embed([query]);
			const queryVec = new Float32Array(vectors[0] ?? []);
			const vecResults = this.vectorStore.search(queryVec, overFetch);
			if (vecResults.length > 0) {
				vectorRanked = this.hydrateVectorHits(
					vecResults.map((r) => r.chunkId),
					sourceId,
					opts.folders,
					opts.fileTypes,
					// Preserve the vec0 distance ordering: it returns nearest first,
					// so the input array is already ranked. The hydration query loses
					// ordering through `IN (...)`, so we re-sort against the input.
					new Map(vecResults.map((r, i) => [r.chunkId, i])),
				);
			}
		} catch (err: unknown) {
			// A failing vector branch should not nuke the search — fall back
			// to keyword-only. The keyword branch below catches its own errors
			// the same way.
			const msg = err instanceof Error ? err.message : String(err);
			this.logger.warn(`HybridSearchIndex: vector branch failed: ${msg}`);
		}

		// ----- Keyword branch (FTS5) -------------------------------------------
		let keywordRanked: Array<{ chunkId: string; meta: ChunkMetadata }> = [];
		const ftsPattern = escapeFtsQuery(query);
		if (hasFts && ftsPattern.length > 0) {
			try {
				keywordRanked = this.runFtsQuery(
					ftsPattern,
					sourceId,
					overFetch,
					opts.folders,
					opts.fileTypes,
				);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.warn(`HybridSearchIndex: FTS5 branch failed: ${msg}`);
			}
		}

		// ----- RRF fusion -------------------------------------------------------
		// score(c) = sum over methods m of  1 / (k + rank_m(c))
		// Rank is 1-based, ties broken by stable insertion order.
		const fused = new Map<
			string,
			{ score: number; meta: ChunkMetadata; vectorRank: number | null; keywordRank: number | null }
		>();

		for (let i = 0; i < vectorRanked.length; i++) {
			const entry = vectorRanked[i]!;
			const rank = i + 1;
			const contrib = 1 / (this.rrfK + rank);
			fused.set(entry.chunkId, {
				score: contrib,
				meta: entry.meta,
				vectorRank: rank,
				keywordRank: null,
			});
		}

		for (let i = 0; i < keywordRanked.length; i++) {
			const entry = keywordRanked[i]!;
			const rank = i + 1;
			const contrib = 1 / (this.rrfK + rank);
			const existing = fused.get(entry.chunkId);
			if (existing) {
				existing.score += contrib;
				existing.keywordRank = rank;
			} else {
				fused.set(entry.chunkId, {
					score: contrib,
					meta: entry.meta,
					vectorRank: null,
					keywordRank: rank,
				});
			}
		}

		const ordered = Array.from(fused.values()).sort((a, b) => b.score - a.score);
		const top = ordered.slice(0, topK);

		return {
			chunks: top.map((entry) => ({
				text: entry.meta.text,
				score: entry.score,
				sourceId: entry.meta.sourceId,
				folder: entry.meta.folder,
				fileName: entry.meta.fileName,
				position: entry.meta.position,
				documentId: entry.meta.documentId,
			})),
		};
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	/**
	 * Hydrate vector hits into rich metadata rows joined with rag_documents
	 * and rag_folders, then re-rank them against the input vector order.
	 * Drops chunks whose document is soft-deleted, has the wrong source_id,
	 * or fails the folders / fileTypes filter.
	 */
	private hydrateVectorHits(
		chunkIds: string[],
		sourceId: string,
		folders: readonly string[] | undefined,
		fileTypes: readonly string[] | undefined,
		rankByChunkId: Map<string, number>,
	): Array<{ chunkId: string; meta: ChunkMetadata }> {
		if (chunkIds.length === 0) return [];
		const placeholders = chunkIds.map(() => '?').join(',');
		// Extra JOIN on rag_sources filters out chunks whose parent source
		// has been soft-deleted (v8) — their rows are kept until the cleanup
		// cron runs but should never surface in search results.
		const rows = this.db
			.prepare<string[], VectorJoinRow>(
				`SELECT
				   c.id        AS chunk_id,
				   c.text      AS chunk_text,
				   c.position  AS chunk_position,
				   d.id        AS doc_id,
				   d.source_id AS doc_source_id,
				   d.name      AS doc_name,
				   d.mime_type AS mime_type,
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

		const filtered = rows.filter((row) => passesFilters(row, folders, fileTypes));
		// Re-order against vec0's distance ranking. Rows missing from the input
		// rank map (shouldn't happen, but defensive) sort to the end.
		filtered.sort((a, b) => {
			const ra = rankByChunkId.get(a.chunk_id) ?? Number.POSITIVE_INFINITY;
			const rb = rankByChunkId.get(b.chunk_id) ?? Number.POSITIVE_INFINITY;
			return ra - rb;
		});
		return filtered.map((row) => ({
			chunkId: row.chunk_id,
			meta: rowToMeta(row),
		}));
	}

	/**
	 * Run the FTS5 MATCH query joined with rag_documents/rag_folders so
	 * folder / fileType filters are applied at the SQL level. The bm25()
	 * scoring function returns a negative value (more negative = better
	 * match) — we order ASC and rely on insertion order, not the raw
	 * score, for RRF.
	 */
	private runFtsQuery(
		ftsPattern: string,
		sourceId: string,
		limit: number,
		folders: readonly string[] | undefined,
		fileTypes: readonly string[] | undefined,
	): Array<{ chunkId: string; meta: ChunkMetadata }> {
		// We can't push folder/fileType into the WHERE on a MATCH query without
		// hurting the query planner, so we filter in JS after the SQL fetch.
		// The over-fetch (caller passed candidatesPerMethod * 3 when filters
		// are active) keeps recall acceptable.
		const rows = this.db
			.prepare<[string, string, number], FtsRow>(
				`SELECT
				   c.id           AS chunk_id,
				   c.text         AS chunk_text,
				   c.position     AS chunk_position,
				   d.id           AS doc_id,
				   d.source_id    AS doc_source_id,
				   d.name         AS doc_name,
				   d.mime_type    AS mime_type,
				   f.path         AS folder_path,
				   bm25(rag_chunks_fts) AS keyword_score
				 FROM rag_chunks_fts fts
				 JOIN rag_chunks c ON c.rowid = fts.rowid
				 JOIN rag_documents d ON d.id = c.document_id
				 JOIN rag_sources s ON s.id = d.source_id
				 LEFT JOIN rag_folders f ON f.id = d.folder_id
				 WHERE rag_chunks_fts MATCH ?
				   AND d.source_id = ?
				   AND d.deleted_at IS NULL
				   AND s.deleted_at IS NULL
				 ORDER BY keyword_score
				 LIMIT ?`,
			)
			.all(ftsPattern, sourceId, limit);

		return rows
			.filter((row) => passesFilters(row, folders, fileTypes))
			.map((row) => ({
				chunkId: row.chunk_id,
				meta: rowToMeta(row),
			}));
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FilterableRow {
	folder_path: string | null;
	mime_type: string;
	doc_name: string;
}

function passesFilters(
	row: FilterableRow,
	folders: readonly string[] | undefined,
	fileTypes: readonly string[] | undefined,
): boolean {
	if (folders && folders.length > 0) {
		const fp = row.folder_path ?? '';
		const matchesFolder = folders.some((f) => fp === f || fp.startsWith(f + '/'));
		if (!matchesFolder) return false;
	}
	if (fileTypes && fileTypes.length > 0) {
		// Accept either a MIME type ("application/pdf") or an extension
		// (".pdf" / "pdf"). Extension match is done against doc_name.
		const lowerName = row.doc_name.toLowerCase();
		const matchesType = fileTypes.some((t) => {
			const normalized = t.toLowerCase();
			if (normalized.includes('/')) return row.mime_type.toLowerCase() === normalized;
			const ext = normalized.startsWith('.') ? normalized : '.' + normalized;
			return lowerName.endsWith(ext);
		});
		if (!matchesType) return false;
	}
	return true;
}

function rowToMeta(row: VectorJoinRow | FtsRow): ChunkMetadata {
	return {
		text: row.chunk_text,
		position: row.chunk_position,
		documentId: row.doc_id,
		sourceId: row.doc_source_id,
		fileName: row.doc_name,
		folder: row.folder_path ?? '',
	};
}
