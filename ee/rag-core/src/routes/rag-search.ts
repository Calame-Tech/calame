// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { RagSearchResult } from '../types.js';
import type { RagRouteDeps } from './types.js';

/**
 * Resolve the tenant id for a request, falling back to the literal
 * `'default'` when the host hasn't wired a resolver (e.g. test deps).
 */
function resolveTenantId(deps: RagRouteDeps, req?: Request): string {
  return deps.getTenantId ? deps.getTenantId(req) : 'default';
}

const searchSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(100).optional(),
  sourceIds: z.array(z.string()).optional(),
  folderIds: z.array(z.string()).optional(),
  /** Required for cross-source / cross-model searches. Names the AI setting whose
   * embedding model is used to embed the query. */
  settingName: z.string().min(1).optional(),
});

interface ChunkJoinRow {
  chunk_id: string;
  chunk_text: string;
  chunk_position: number;
  document_id: string;
  document_path: string;
  document_name: string;
  source_id: string;
  folder_path: string | null;
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/**
 * POST /api/rag/search — vector search.
 *
 * Body: `{ query, topK?, sourceIds?, folderIds?, settingName? }`
 *
 * Phase 1 limitation: this endpoint currently uses a single embedding client
 * for the query — either the explicit `settingName` from the body, or the
 * embedding setting of the first listed source. Mixing sources with different
 * embedding models in one query is an error.
 */
export function registerRagSearchRoutes(app: Express, deps: RagRouteDeps): void {
  app.post('/api/rag/search', async (req: Request, res: Response) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, parsed.error.issues.map((i) => i.message).join('; '));
      return;
    }
    const { query, topK = 10, sourceIds, folderIds, settingName } = parsed.data;
    const tenantId = resolveTenantId(deps, req);

    try {
      // Resolve the embedding setting to use for the query vector.
      // Soft-deleted sources are excluded — searching from a retired
      // source would mix dangling chunks back into results. The tenant
      // filter ensures we never reach for a foreign-tenant source even
      // when the caller pre-supplies its `id` in `sourceIds`.
      let resolvedSettingName: string | null = settingName ?? null;
      if (!resolvedSettingName) {
        const firstSource = sourceIds?.[0]
          ? (deps.db
              .prepare<[string, string], { embedding_setting_name: string }>(
                `SELECT embedding_setting_name FROM rag_sources
								 WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
              )
              .get(sourceIds[0], tenantId) ?? null)
          : (deps.db
              .prepare<[string], { embedding_setting_name: string }>(
                `SELECT embedding_setting_name FROM rag_sources
								 WHERE tenant_id = ? AND deleted_at IS NULL
								 ORDER BY created_at ASC LIMIT 1`,
              )
              .get(tenantId) ?? null);
        if (!firstSource) {
          sendError(res, 400, 'No source available to derive an embedding setting.');
          return;
        }
        resolvedSettingName = firstSource.embedding_setting_name;
      }

      const embedClient = deps.resolveEmbeddingClient(resolvedSettingName);
      const queryEmbeddings = await embedClient.embed([query]);
      const queryEmbedding = queryEmbeddings[0];
      if (!queryEmbedding) {
        sendError(res, 500, 'Embedding client returned no vector for the query.');
        return;
      }

      const hits = deps.vectorStore.search(Float32Array.from(queryEmbedding), topK);
      if (hits.length === 0) {
        const empty: RagSearchResult = { chunks: [] };
        res.json(empty);
        return;
      }

      // Hydrate chunk metadata in a single SQL roundtrip.
      // The extra JOIN on `rag_sources` + `s.deleted_at IS NULL` filters
      // out chunks whose parent source has been soft-deleted — their
      // rows are kept in the DB until the cleanup cron runs but should
      // never surface in search results.
      //
      // Phase B multi-tenancy: `s.tenant_id = ?` ensures the JOIN drops
      // any chunk whose parent source belongs to another tenant. This
      // is the load-bearing filter for the search endpoint — even when
      // the vec0 search returns hits from a foreign tenant (the vector
      // index is shared per process), they're discarded here.
      const placeholders = hits.map(() => '?').join(',');
      const ids = hits.map((h) => h.chunkId);
      const rows = deps.db
        .prepare(
          `SELECT
					   c.id AS chunk_id,
					   c.text AS chunk_text,
					   c.position AS chunk_position,
					   d.id AS document_id,
					   d.path AS document_path,
					   d.name AS document_name,
					   d.source_id AS source_id,
					   f.path AS folder_path
					 FROM rag_chunks c
					 JOIN rag_documents d ON d.id = c.document_id
					 JOIN rag_sources s ON s.id = d.source_id
					 LEFT JOIN rag_folders f ON f.id = d.folder_id
					 WHERE c.id IN (${placeholders})
					   AND d.deleted_at IS NULL
					   AND s.deleted_at IS NULL
					   AND s.tenant_id = ?`,
        )
        .all(...ids, tenantId) as ChunkJoinRow[];

      const byId = new Map<string, ChunkJoinRow>();
      for (const r of rows) byId.set(r.chunk_id, r);

      const allowedSources = sourceIds && sourceIds.length > 0 ? new Set(sourceIds) : null;
      const allowedFolders = folderIds && folderIds.length > 0 ? new Set(folderIds) : null;

      const chunks: RagSearchResult['chunks'] = [];
      for (const hit of hits) {
        const meta = byId.get(hit.chunkId);
        if (!meta) continue;
        if (allowedSources && !allowedSources.has(meta.source_id)) continue;
        if (allowedFolders) {
          // folderIds filter is applied via document.folder_id — we look it up.
          const docFolder = deps.db
            .prepare<
              [string],
              { folder_id: string | null }
            >(`SELECT folder_id FROM rag_documents WHERE id = ?`)
            .get(meta.document_id);
          if (!docFolder?.folder_id || !allowedFolders.has(docFolder.folder_id)) continue;
        }
        // vec0 returns L2 distance; map to a [0,1] similarity score (best-effort).
        const score = 1 / (1 + hit.distance);
        chunks.push({
          text: meta.chunk_text,
          score,
          sourceId: meta.source_id,
          folder: meta.folder_path ?? path.dirname(meta.document_path),
          fileName: meta.document_name,
          position: meta.chunk_position,
          documentId: meta.document_id,
        });
      }

      deps.onAudit?.({
        type: 'rag.search.ok',
        payload: { query, topK, hits: chunks.length },
        timestamp: new Date().toISOString(),
      });

      const result: RagSearchResult = { chunks };
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      deps.onAudit?.({
        type: 'rag.search.failed',
        payload: { error: message },
        timestamp: new Date().toISOString(),
      });
      sendError(res, 500, message);
    }
  });
}
