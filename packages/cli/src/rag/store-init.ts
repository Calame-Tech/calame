// Vector-store bootstrap: picks the vec0 dimension (honouring whatever existing
// sources declared), auto-heals a mismatched table when safe, and constructs
// the SqliteVecStore. Extracted from `rag-runtime.ts` so the dimension logic
// and its failure-degradation paths live in one place.

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { VectorStore } from '@calame-ee/rag-core';
import type { CalameDatabase } from '../database.js';
import type { RagLogger } from './types.js';

/** Default vector dimension used when bootstrapping the vec0 table eagerly.
 *
 * Phase 1 limitation: the sqlite-vec virtual table has a fixed dimension at
 * create time. We default to 1536 (OpenAI text-embedding-3-small) so the
 * default install works out of the box. Operators that want a different
 * dimension must drop the table and restart — see routes/rag-sources.ts. */
export const DEFAULT_DIMENSION = 1536;

/** Read the dimension already in use by existing rag_sources, or null when empty. */
export function readExistingDimension(raw: BetterSqlite3Database): number | null {
  // Defensive: the `embedding_dimensions` column may not exist yet if
  // migrations haven't run. Probe via PRAGMA before SELECTing.
  const cols = raw.pragma('table_info(rag_sources)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'embedding_dimensions')) return null;
  const row = raw
    .prepare(
      `SELECT embedding_dimensions FROM rag_sources
       WHERE embedding_dimensions > 0
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as { embedding_dimensions: number } | undefined;
  return row ? row.embedding_dimensions : null;
}

/**
 * Pick the vec0 dimension, auto-heal a mismatched table when no chunks would be
 * lost, and construct the SqliteVecStore. Returns `null` (after logging and
 * setting `state.ragDisabledReason`) on any failure so the caller can bail out
 * of `initRagRuntime`.
 */
export function initVectorStore(
  ragCore: typeof import('@calame-ee/rag-core'),
  db: CalameDatabase,
  state: { ragDisabledReason: string | null },
  log: RagLogger,
): { vectorStore: VectorStore; dimension: number } | null {
  // Pick a dimension for the vec0 table. Use whatever existing sources have
  // declared (single-dimension Phase 1 invariant), else fall back to the default.
  const existingDim = readExistingDimension(db.raw);
  const dimension = existingDim ?? DEFAULT_DIMENSION;

  // Auto-heal: if the existing vec0 table has the wrong dimension AND no chunks
  // would be lost, drop it so the SqliteVecStore constructor recreates it at
  // the correct dimension. Refuses to drop when chunks exist.
  try {
    const result = ragCore.resetVecTableIfDimensionMismatch(db.raw, dimension);
    if (result.reset) {
      log.info(
        `RAG: rebuilt rag_chunks_vec from dimension=${result.previousDimension} to ${dimension} (no chunks present).`,
      );
    } else if (result.reason === 'chunks-present') {
      log.warn(
        `RAG: rag_chunks_vec dimension=${result.previousDimension} ≠ requested ${dimension}, ` +
          `but ${result.chunkCount} chunks present — refusing to drop. Manually wipe rag_chunks ` +
          `and rag_chunks_vec to switch dimensions. RAG features disabled.`,
      );
      state.ragDisabledReason =
        `Vector store dimension mismatch (rag_chunks_vec=${result.previousDimension}, ` +
        `expected ${dimension}) and chunks already present — manually wipe rag_chunks/rag_chunks_vec ` +
        `to switch dimensions`;
      return null;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`RAG: failed to inspect rag_chunks_vec: ${msg}. RAG features disabled.`);
    state.ragDisabledReason = `Failed to inspect rag_chunks_vec: ${msg}`;
    return null;
  }

  // Build the vector store. Native binding errors are surfaced as warnings —
  // they're typically a Windows rebuild issue and shouldn't crash the host.
  let vectorStore: VectorStore;
  try {
    vectorStore = new ragCore.SqliteVecStore(db.raw, dimension);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to initialize RAG vector store: ${msg}. RAG features disabled.`);
    state.ragDisabledReason = `Failed to initialize sqlite-vec native binding: ${msg}`;
    return null;
  }

  return { vectorStore, dimension };
}
