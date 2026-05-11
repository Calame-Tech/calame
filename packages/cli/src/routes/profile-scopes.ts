import type { Express } from 'express';
import type { AppState } from '../state.js';
import type { CalameDatabase } from '../database.js';
import { z } from 'zod';
import { upgradeProfileShape, sourceAdapterRegistry } from '@calame/core';
import type { ScopeSelection } from '@calame/core';
import { getTenantId } from '../tenancy.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * Validates a `scopes` map by iterating the registered adapter registry and
 * using each adapter's `scopeSelectionSchema` for the matching source kind.
 * Unknown kinds fall back to a permissive passthrough so that future adapters
 * (Phase 3+) slot in without requiring a CLI update.
 *
 * For Phase 2 only the `relational` arm is wired (the `db-adapter` from
 * `@calame/connectors` is the only adapter in the registry during tests
 * without RAG). The iteration-based structure ensures the RAG document adapter
 * slots in for free once Phase 3 registers it.
 */
function buildScopesValidator(): z.ZodType<Record<string, ScopeSelection>> {
  // Collect per-kind schemas from the registry.
  const kindSchemas = new Map<string, z.ZodType<ScopeSelection>>();
  for (const adapter of sourceAdapterRegistry.list()) {
    kindSchemas.set(adapter.type, adapter.scopeSelectionSchema);
  }

  // If no adapters are registered, fall back to a generic record validator.
  if (kindSchemas.size === 0) {
    return z.record(z.string(), z.unknown() as z.ZodType<ScopeSelection>);
  }

  // Build a union of all registered kind schemas.
  const schemas = Array.from(kindSchemas.values());
  const unionSchema: z.ZodType<ScopeSelection> =
    schemas.length === 1
      ? schemas[0]
      : (z.union(schemas as [z.ZodType<ScopeSelection>, z.ZodType<ScopeSelection>, ...z.ZodType<ScopeSelection>[]]));

  return z.record(z.string(), unionSchema);
}

/**
 * `sources: []` is intentionally allowed — a profile may legitimately have no
 * source assigned (e.g. just been created, or the admin de-selected every
 * source via the RagAccessSelector). Validation is therefore additive: we
 * require an array, but accept an empty one. Empty `scopes` is also legal in
 * that case.
 */
const profileScopesBodySchema = z.object({
  sources: z.array(z.string()),
  scopes: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerProfileScopesRoute(app: Express, state: AppState): void {
  async function getDb(): Promise<CalameDatabase> {
    if (!state.db) {
      const dataDir = state.config?.dataDir ?? process.cwd();
      const { CalameDatabase } = await import('../database.js');
      state.db = new CalameDatabase(dataDir);
    }
    return state.db;
  }

  /**
   * POST /api/profiles/:name/scopes
   *
   * Update the `sources` and `scopes` fields of an existing profile.
   * Accepts both the new shape and the legacy shape — the body is run through
   * `upgradeProfileShape` after merging so storage is always in the new shape.
   *
   * Validates `scopes` entries via the adapter registry's `scopeSelectionSchema`
   * per kind. Unknown kinds are allowed (permissive passthrough) so that future
   * Phase-3 adapters can be tested against this endpoint without a CLI change.
   */
  app.post('/api/profiles/:name/scopes', async (req, res) => {
    const profileName = req.params.name as string;

    const parsed = profileScopesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: 'Invalid request body',
        errors: parsed.error.issues,
      });
      return;
    }

    // Validate scopes entries against the registry if any adapters are registered.
    const scopesValidator = buildScopesValidator();
    const scopesValidation = scopesValidator.safeParse(parsed.data.scopes);
    if (!scopesValidation.success) {
      res.status(400).json({
        success: false,
        message: 'Invalid scopes: one or more entries failed adapter schema validation',
        errors: scopesValidation.error.issues,
      });
      return;
    }

    try {
      const db = await getDb();

      // Phase B multi-tenancy — bind tenant on the read AND the rewrite.
      const tenantId = getTenantId(req);
      const row = db.raw
        .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
        .get(tenantId) as { data: string } | undefined;

      if (!row) {
        res.status(404).json({ success: false, message: `Profile "${profileName}" not found.` });
        return;
      }

      const data = JSON.parse(row.data) as { profiles?: Record<string, Record<string, unknown>> };

      if (!data.profiles || !data.profiles[profileName]) {
        res.status(404).json({ success: false, message: `Profile "${profileName}" not found.` });
        return;
      }

      // Merge the new sources/scopes into the existing profile, then normalise.
      const existing = data.profiles[profileName];
      const merged: Record<string, unknown> = {
        ...existing,
        sources: parsed.data.sources,
        scopes: parsed.data.scopes as Record<string, ScopeSelection>,
      };

      const upgraded = upgradeProfileShape(merged);
      data.profiles[profileName] = upgraded as unknown as Record<string, unknown>;

      db.raw
        .prepare("INSERT OR REPLACE INTO profiles (key, data, tenant_id) VALUES ('main', ?, ?)")
        .run(JSON.stringify(data), tenantId);

      // Reflect in AppState if this profile is currently loaded.
      if (state.serveProfiles[profileName]) {
        state.serveProfiles[profileName] = upgraded;
      }

      // Invalidate tool schema cache so the next chat turn re-fetches tools.
      const { invalidateToolSchemaCache } = await import('../chat-engine.js');
      invalidateToolSchemaCache(profileName);

      res.json({ success: true, profile: upgraded });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Scopes update error', { component: `profiles/${profileName}/scopes`, error: message });
      res.status(500).json({ success: false, message: 'Failed to update profile scopes' });
    }
  });

  /**
   * GET /api/profiles/:name/scopes/preview
   *
   * Returns aggregated scope counts per source (how many tables / folders /
   * documents are accessible) plus a global summary.
   *
   * Counting semantics by scope kind:
   *
   * - `relational` — `tables` is the number of selected tables in the scope;
   *   `columns` is the sum of selected columns across all tables. Always
   *   `live: true` (counts come straight from `selectedTables`).
   *
   * - `document` mode `allowAll` — every non-soft-deleted document under the
   *   source is accessible. Counts come from a `COUNT(*)` over `rag_documents`
   *   / `rag_folders` / `rag_chunks JOIN rag_documents` filtered by `source_id`
   *   and `deleted_at IS NULL`. Requires `state.ragRuntime`.
   *
   * - `document` mode `allowList` — accessible documents are the **union** of
   *   (a) documents under any folder whose path is in `allowedFolders`, and
   *   (b) documents whose id is in `allowedDocuments` (validated for
   *   non-soft-deletion). Implementation uses 3 constant-cost queries:
   *   one JOIN for folder-based docs, one `IN (?…)` for explicit doc IDs, one
   *   `IN (?…)` over `rag_chunks` for the union. Requires `state.ragRuntime`.
   *
   * - When `state.ragRuntime` is absent (RAG disabled), document counts fall
   *   back to naive array-length values and the response carries `live: false`
   *   so clients can flag the approximation.
   *
   * Backward-compatible: the existing `summary` and `totals` fields are preserved.
   * New fields (`counts`, `live`, `totals.columns`, `totals.chunks`) are additive.
   */
  app.get('/api/profiles/:name/scopes/preview', async (req, res) => {
    const profileName = req.params.name as string;

    try {
      const db = await getDb();

      const tenantId = getTenantId(req);
      const row = db.raw
        .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
        .get(tenantId) as { data: string } | undefined;

      if (!row) {
        res.status(404).json({ success: false, message: `Profile "${profileName}" not found.` });
        return;
      }

      const data = JSON.parse(row.data) as { profiles?: Record<string, Record<string, unknown>> };

      if (!data.profiles || !data.profiles[profileName]) {
        res.status(404).json({ success: false, message: `Profile "${profileName}" not found.` });
        return;
      }

      const profile = upgradeProfileShape(data.profiles[profileName]);

      const scopes = (profile.scopes ?? {}) as Record<string, ScopeSelection>;
      const sources = profile.sources ?? [];

      // Determine whether live RAG counts are available.
      const ragDb = state.ragRuntime ? db.raw : null;

      let totalTables = 0;
      let totalColumns = 0;
      let totalFolders = 0;
      let totalDocuments = 0;
      let totalChunks = 0;

      type PerSourceEntry =
        | {
            id: string;
            kind: 'relational';
            summary: { selectedTables: number };
            counts: { tables: number; columns: number };
            live: boolean;
          }
        | {
            id: string;
            kind: 'document';
            summary: { allowedFolders: number; allowedDocuments: number };
            counts: { folders: number; documents: number; chunks: number };
            live: boolean;
          }
        | { id: string; kind: string; summary: Record<string, unknown>; counts: Record<string, unknown>; live: boolean };

      const perSource: PerSourceEntry[] = sources.map((sourceId) => {
        const scope = scopes[sourceId];
        if (!scope) {
          return { id: sourceId, kind: 'unknown', summary: {}, counts: {}, live: false };
        }

        if (scope.kind === 'relational') {
          const tableKeys = Object.keys(scope.selectedTables ?? {});
          const tableCount = tableKeys.length;
          const columnCount = tableKeys.reduce(
            (acc, tbl) => acc + ((scope.selectedTables ?? {})[tbl]?.length ?? 0),
            0,
          );
          totalTables += tableCount;
          totalColumns += columnCount;
          return {
            id: sourceId,
            kind: 'relational' as const,
            summary: { selectedTables: tableCount },
            counts: { tables: tableCount, columns: columnCount },
            live: true,
          };
        }

        if (scope.kind === 'document') {
          // Naive fallback values (used when RAG is not available).
          const naiveFolders = scope.allowedFolders?.length ?? 0;
          const naiveDocs = scope.allowedDocuments?.length ?? 0;

          if (!ragDb) {
            totalFolders += naiveFolders;
            totalDocuments += naiveDocs;
            return {
              id: sourceId,
              kind: 'document' as const,
              summary: { allowedFolders: naiveFolders, allowedDocuments: naiveDocs },
              counts: { folders: naiveFolders, documents: naiveDocs, chunks: 0 },
              live: false,
            };
          }

          // Live counts from SQLite RAG tables.
          let liveDocCount = 0;
          let liveFolderCount = 0;
          let liveChunkCount = 0;

          // Phase B multi-tenancy: every count below binds `tenant_id = ?`
          // so a forged profile referencing a foreign-tenant source id
          // surfaces zero rows rather than the foreign tenant's stats.
          if (scope.mode === 'allowAll') {
            // Count every non-deleted document for this source.
            const docRow = ragDb
              .prepare<[string, string], { n: number }>(
                'SELECT COUNT(*) AS n FROM rag_documents WHERE source_id = ? AND tenant_id = ? AND deleted_at IS NULL',
              )
              .get(sourceId, tenantId);
            liveDocCount = docRow?.n ?? 0;

            // Count all folders for this source.
            const folderRow = ragDb
              .prepare<[string, string], { n: number }>(
                'SELECT COUNT(*) AS n FROM rag_folders WHERE source_id = ? AND tenant_id = ?',
              )
              .get(sourceId, tenantId);
            liveFolderCount = folderRow?.n ?? 0;

            // Count all chunks for this source.
            const chunkRow = ragDb
              .prepare<[string, string], { n: number }>(
                `SELECT COUNT(*) AS n
                 FROM rag_chunks c
                 JOIN rag_documents d ON d.id = c.document_id
                 WHERE d.source_id = ? AND d.tenant_id = ? AND d.deleted_at IS NULL`,
              )
              .get(sourceId, tenantId);
            liveChunkCount = chunkRow?.n ?? 0;
          } else {
            // mode === 'allowList': resolve folder-based and explicit-document sets.
            // Replaces the previous N+1 loop (one SELECT per folder + one per explicit doc)
            // with three constant-cost queries regardless of allowlist size.
            const allowedFolderPaths = (scope.allowedFolders ?? []) as string[];
            const allowedDocIds = (scope.allowedDocuments ?? []) as string[];

            liveFolderCount = allowedFolderPaths.length;

            const folderDocIds = new Set<string>();
            if (allowedFolderPaths.length > 0) {
              // One JOIN: docs whose folder is among the allowed paths.
              const placeholders = allowedFolderPaths.map(() => '?').join(',');
              const folderDocs = ragDb
                .prepare<string[], { id: string }>(
                  `SELECT d.id
                   FROM rag_documents d
                   JOIN rag_folders f ON f.id = d.folder_id
                   WHERE d.source_id = ?
                     AND d.tenant_id = ?
                     AND d.deleted_at IS NULL
                     AND f.source_id = ?
                     AND f.tenant_id = ?
                     AND f.path IN (${placeholders})`,
                )
                .all(sourceId, tenantId, sourceId, tenantId, ...allowedFolderPaths);
              for (const row of folderDocs) folderDocIds.add(row.id);
            }

            // Validate explicit doc IDs in a single round-trip.
            const existingExplicitDocIds = new Set<string>();
            if (allowedDocIds.length > 0) {
              const placeholders = allowedDocIds.map(() => '?').join(',');
              const existingDocs = ragDb
                .prepare<string[], { id: string }>(
                  `SELECT id FROM rag_documents
                   WHERE id IN (${placeholders}) AND tenant_id = ? AND deleted_at IS NULL`,
                )
                .all(...allowedDocIds, tenantId);
              for (const row of existingDocs) existingExplicitDocIds.add(row.id);
            }

            // Union of folder-based and explicit docs.
            const allDocIds = new Set([...folderDocIds, ...existingExplicitDocIds]);
            liveDocCount = allDocIds.size;

            // Count chunks for the union of doc IDs.
            if (allDocIds.size > 0) {
              const idList = Array.from(allDocIds);
              const placeholders = idList.map(() => '?').join(',');
              const chunkRow = ragDb
                .prepare<string[], { n: number }>(
                  `SELECT COUNT(*) AS n FROM rag_chunks WHERE document_id IN (${placeholders}) AND tenant_id = ?`,
                )
                .get(...idList, tenantId);
              liveChunkCount = chunkRow?.n ?? 0;
            }
          }

          totalFolders += liveFolderCount;
          totalDocuments += liveDocCount;
          totalChunks += liveChunkCount;

          return {
            id: sourceId,
            kind: 'document' as const,
            summary: { allowedFolders: liveFolderCount, allowedDocuments: liveDocCount },
            counts: { folders: liveFolderCount, documents: liveDocCount, chunks: liveChunkCount },
            live: true,
          };
        }

        return {
          id: sourceId,
          kind: (scope as { kind: string }).kind,
          summary: {},
          counts: {},
          live: false,
        };
      });

      res.json({
        success: true,
        sources: perSource,
        // Legacy totals (kept for backward-compat).
        totals: {
          tables: totalTables,
          folders: totalFolders,
          documents: totalDocuments,
          // New additive fields.
          columns: totalColumns,
          chunks: totalChunks,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Scopes preview error', {
        component: `profiles/${profileName}/scopes/preview`,
        error: message,
      });
      res.status(500).json({ success: false, message: 'Failed to load scopes preview' });
    }
  });
}
