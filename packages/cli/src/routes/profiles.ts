import type { Express } from 'express';
import type { AppState } from '../state.js';
import type { CalameDatabase } from '../database.js';
import { z } from 'zod';
import { upgradeProfileShape } from '@calame/core';
import { getTenantId } from '../tenancy.js';

export interface ProfileWarning {
  profile: string;
  type: 'missing_table' | 'missing_column';
  table: string;
  column?: string;
}

/**
 * Validate loaded profiles against the current database schema.
 * Returns a list of warnings for stale tables/columns.
 *
 * Reads through `getProfileSelectedTables` so it covers both the unified
 * shape (`scopes[sid].selectedTables`) and the legacy `selectedTables`
 * fallback for profiles that haven't been through `upgradeProfileShape`.
 */
import { getProfileSelectedTables } from '@calame/core';

export function validateProfiles(
  profiles: Record<
    string,
    {
      selectedTables?: Record<string, string[]>;
      tableOptions?: Record<string, unknown>;
      sources?: string[];
      scopes?: Parameters<typeof getProfileSelectedTables>[0]['scopes'];
    }
  >,
  schemaTables: { name: string; columns: { name: string }[] }[],
): ProfileWarning[] {
  const warnings: ProfileWarning[] = [];
  const tableMap = new Map<string, Set<string>>();

  for (const table of schemaTables) {
    tableMap.set(table.name, new Set(table.columns.map((c) => c.name)));
  }

  for (const [profileName, profile] of Object.entries(profiles)) {
    // Cast: validateProfiles' input type carries `tableOptions: Record<string, unknown>`
    // for backward compat with callers; the accessor's `ProfileScopeShape`
    // expects the structural `TableToolOptions`. They are interchangeable here
    // because the accessor only reads `selectedTables` from the relational
    // scope.
    const selected = getProfileSelectedTables(profile as Parameters<typeof getProfileSelectedTables>[0]);

    for (const [tableName, columns] of Object.entries(selected)) {
      const schemaColumns = tableMap.get(tableName);

      if (!schemaColumns) {
        warnings.push({ profile: profileName, type: 'missing_table', table: tableName });
        continue;
      }

      for (const col of columns) {
        if (!schemaColumns.has(col)) {
          warnings.push({ profile: profileName, type: 'missing_column', table: tableName, column: col });
        }
      }
    }
  }

  return warnings;
}

export function registerProfilesRoute(app: Express, state: AppState): void {
  async function getDb(): Promise<CalameDatabase> {
    if (!state.db) {
      const dataDir = state.config?.dataDir ?? process.cwd();
      const { CalameDatabase } = await import('../database.js');
      state.db = new CalameDatabase(dataDir);
    }
    return state.db;
  }

  app.post('/api/profiles/save', async (req, res) => {
    try {
      const data = req.body;
      if (!data || !data.profiles) {
        res.status(400).json({ success: false, message: 'Missing profiles data.' });
        return;
      }

      if (typeof data.profiles === 'object' && Object.keys(data.profiles).length === 0) {
        res.status(400).json({ success: false, message: 'Cannot save empty profiles. At least one profile is required.' });
        return;
      }

      // Ensure each profile has a connections field (default to ['default'])
      // Also preserve OAuth clientSecret if the masked value '***' is sent back
      const db = await getDb();
      // Phase B multi-tenancy — bind `tenant_id` on the read of the existing
      // row so each tenant only ever merges against its own profile blob.
      // The `profiles` table still has a singleton PK on `key='main'`, so in
      // practice there is at most one row per DB; a future migration will
      // promote the PK to `(tenant_id, key)` to lift that constraint.
      const tenantId = getTenantId(req);
      let existingProfiles: Record<string, Record<string, unknown>> = {};
      try {
        const existingRow = db.raw
          .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
          .get(tenantId) as { data: string } | undefined;
        if (existingRow) {
          const existing = JSON.parse(existingRow.data) as { profiles?: Record<string, Record<string, unknown>> };
          existingProfiles = existing.profiles ?? {};
        }
      } catch { /* ignore */ }

      for (const [profileName, profile] of Object.entries(data.profiles as Record<string, Record<string, unknown>>)) {
        if (!profile.connections || !Array.isArray(profile.connections) || profile.connections.length === 0) {
          profile.connections = ['default'];
        }
        // Preserve OAuth clientSecret if masked value sent back from frontend
        if (profile.oauthConfig && typeof profile.oauthConfig === 'object') {
          const oauthCfg = profile.oauthConfig as Record<string, unknown>;
          if (typeof oauthCfg.clientSecret === 'string' && (oauthCfg.clientSecret as string).includes('***')) {
            const existingOauth = existingProfiles[profileName]?.oauthConfig as Record<string, unknown> | undefined;
            oauthCfg.clientSecret = existingOauth?.clientSecret ?? '';
          }
        }
      }
      // Merge incoming profile data with existing data (preserve fields not sent by the frontend).
      // Strip undefined values from the incoming profile before merging so that fields absent
      // from the frontend state (e.g. dataScopeRules, sharedTables) do not overwrite existing
      // stored values with undefined.
      for (const [profileName, incomingProfile] of Object.entries(data.profiles as Record<string, Record<string, unknown>>)) {
        const existing = existingProfiles[profileName];
        if (existing) {
          const definedFields = Object.fromEntries(
            Object.entries(incomingProfile).filter(([, v]) => v !== undefined),
          );
          data.profiles[profileName] = { ...existing, ...definedFields };
        }
      }

      // Normalize every profile to the new shape (sources + scopes) at the write boundary.
      // upgradeProfileShape is idempotent: profiles already in the new shape pass through unchanged.
      // Legacy fields (connections / selectedTables / tableOptions / columnMasking) are preserved on
      // the returned object so that Phase-3-unaware code paths keep working until Phase 3 removes them.
      for (const [profileName, rawProfile] of Object.entries(data.profiles as Record<string, Record<string, unknown>>)) {
        try {
          data.profiles[profileName] = upgradeProfileShape(rawProfile) as unknown as Record<string, unknown>;
        } catch {
          // If migration fails (e.g. unexpected shape), log and keep the raw object as-is.
          state.logger?.warn(`upgradeProfileShape failed for profile "${profileName}" — persisting as-is`, {
            component: 'profiles',
          });
        }
      }

      // Phase B multi-tenancy — bind `tenant_id` explicitly so the row lands
      // under the caller's tenant. The current `profiles` row is keyed by the
      // literal 'main' regardless of tenant; a future migration will reshape
      // the PK to `(tenant_id, key)` so several tenants can coexist.
      db.raw
        .prepare("INSERT OR REPLACE INTO profiles (key, data, tenant_id) VALUES ('main', ?, ?)")
        .run(JSON.stringify(data), tenantId);

      // Invalidate tool schema cache for all saved profiles so the next chat turn re-fetches tools
      const { invalidateToolSchemaCache } = await import('../chat-engine.js');
      for (const profileName of Object.keys(data.profiles as Record<string, unknown>)) {
        invalidateToolSchemaCache(profileName);
      }

      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Save error', { component: 'profiles', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  app.get('/api/profiles/load', async (req, res) => {
    try {
      const db = await getDb();
      // Phase B multi-tenancy — only return the profile blob for the
      // caller's tenant. Other tenants' blobs surface as `{ found: false }`,
      // which the UI treats as "no profiles saved yet" (the same first-run
      // state that has always existed).
      const tenantId = getTenantId(req);
      const row = db.raw
        .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
        .get(tenantId) as { data: string } | undefined;

      if (!row) {
        // Intentionally not { success: false } — this is not an error.
        // { found: false } signals "no profiles have been saved yet" (normal first-run state).
        res.json({ found: false });
        return;
      }

      const data = JSON.parse(row.data) as Record<string, unknown>;

      // Backward compat: set default connections on profiles that lack the field
      if (data.profiles && typeof data.profiles === 'object') {
        for (const profile of Object.values(data.profiles as Record<string, Record<string, unknown>>)) {
          if (!profile.connections || !Array.isArray(profile.connections) || profile.connections.length === 0) {
            profile.connections = ['default'];
          }
        }
      }

      // Upgrade every profile to the new shape (sources + scopes) on read.
      // Idempotent — profiles already in the new shape pass through unchanged.
      if (data.profiles && typeof data.profiles === 'object') {
        const profiles = data.profiles as Record<string, Record<string, unknown>>;
        for (const [name, rawProfile] of Object.entries(profiles)) {
          try {
            profiles[name] = upgradeProfileShape(rawProfile) as unknown as Record<string, unknown>;
          } catch {
            // Unexpected shape — leave unchanged rather than crashing the load.
            state.logger?.warn(`upgradeProfileShape failed on load for profile "${name}"`, {
              component: 'profiles',
            });
          }
        }
      }

      // Strip OAuth clientSecret from profiles before sending to the browser
      if (data.profiles && typeof data.profiles === 'object') {
        for (const profile of Object.values(data.profiles as Record<string, Record<string, unknown>>)) {
          if (profile.oauthConfig && typeof profile.oauthConfig === 'object') {
            const oauthCfg = profile.oauthConfig as Record<string, unknown>;
            if (oauthCfg.clientSecret && typeof oauthCfg.clientSecret === 'string') {
              const s = oauthCfg.clientSecret as string;
              oauthCfg.clientSecret = s.length > 4
                ? s.slice(0, 2) + '***' + s.slice(-2)
                : '***';
            }
          }
        }
      }

      // Validate against current schema if available
      let warnings: ProfileWarning[] = [];
      if (data.profiles && state.cachedSchema) {
        warnings = validateProfiles(
          data.profiles as Record<string, { selectedTables?: Record<string, string[]>; tableOptions?: Record<string, unknown> }>,
          state.cachedSchema.tables,
        );
      }

      res.json({ found: true, warnings, ...data });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Load error', { component: 'profiles', error: message });
      res.status(500).json({ found: false, message });
    }
  });

  const responseModeSchema = z.object({
    mode: z.enum(['friendly', 'raw']),
  });

  app.patch('/api/profiles/:name/response-mode', async (req, res) => {
    const profileName = req.params.name as string;

    const parsed = responseModeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: 'Invalid request body',
        errors: parsed.error.issues,
      });
      return;
    }

    const { mode } = parsed.data;

    try {
      const db = await getDb();

      // Phase B multi-tenancy — bind the tenant on the existing-row lookup
      // and on the resulting INSERT OR REPLACE. Cross-tenant profile names
      // surface as 404 here, even when a profile of that name exists in
      // another tenant.
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

      // Upgrade on read so that the persisted object is in the new shape.
      try {
        data.profiles[profileName] = upgradeProfileShape(data.profiles[profileName]) as unknown as Record<string, unknown>;
      } catch { /* ignore — unexpected shape, keep as-is */ }

      data.profiles[profileName].responseMode = mode;

      db.raw
        .prepare("INSERT OR REPLACE INTO profiles (key, data, tenant_id) VALUES ('main', ?, ?)")
        .run(JSON.stringify(data), tenantId);

      // Reflect the update in AppState if the profile is currently loaded
      if (state.serveProfiles[profileName]) {
        state.serveProfiles[profileName].responseMode = mode;
      }

      res.json({ success: true, profile: data.profiles[profileName] });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Response mode update error', { component: 'profiles', error: message });
      res.status(500).json({ success: false, message: 'Failed to update response mode' });
    }
  });
}
