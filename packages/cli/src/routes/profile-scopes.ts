import type { Express } from 'express';
import type { AppState } from '../state.js';
import type { CalameDatabase } from '../database.js';
import { z } from 'zod';
import { upgradeProfileShape, sourceAdapterRegistry } from '@calame/core';
import type { ScopeSelection } from '@calame/core';

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

const profileScopesBodySchema = z.object({
  sources: z.array(z.string()).min(1, 'At least one source is required'),
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

      const row = db.raw
        .prepare("SELECT data FROM profiles WHERE key = 'main'")
        .get() as { data: string } | undefined;

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
        .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
        .run(JSON.stringify(data));

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
   * Phase 2 implementation: skeletal — counts are derived from the profile's
   * `scopes` record. Phase 3+ will enrich these counts by querying the actual
   * source schema via the adapter registry.
   */
  app.get('/api/profiles/:name/scopes/preview', async (req, res) => {
    const profileName = req.params.name as string;

    try {
      const db = await getDb();

      const row = db.raw
        .prepare("SELECT data FROM profiles WHERE key = 'main'")
        .get() as { data: string } | undefined;

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

      let totalTables = 0;
      let totalFolders = 0;
      let totalDocuments = 0;

      const perSource = sources.map((sourceId) => {
        const scope = scopes[sourceId];
        if (!scope) {
          return { id: sourceId, kind: 'unknown', summary: {} };
        }

        if (scope.kind === 'relational') {
          const tableCount = Object.keys(scope.selectedTables ?? {}).length;
          totalTables += tableCount;
          return { id: sourceId, kind: 'relational', summary: { selectedTables: tableCount } };
        }

        if (scope.kind === 'document') {
          const folderCount = scope.allowedFolders?.length ?? 0;
          const docCount = scope.allowedDocuments?.length ?? 0;
          totalFolders += folderCount;
          totalDocuments += docCount;
          return {
            id: sourceId,
            kind: 'document',
            summary: { allowedFolders: folderCount, allowedDocuments: docCount },
          };
        }

        return { id: sourceId, kind: (scope as { kind: string }).kind, summary: {} };
      });

      res.json({
        success: true,
        sources: perSource,
        totals: { tables: totalTables, folders: totalFolders, documents: totalDocuments },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Scopes preview error', { component: `profiles/${profileName}/scopes/preview`, error: message });
      res.status(500).json({ success: false, message: 'Failed to load scopes preview' });
    }
  });
}
