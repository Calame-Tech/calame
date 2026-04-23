import type { Express } from 'express';
import type { AppState } from '../state.js';
import type { CalameDatabase } from '../database.js';
import { z } from 'zod';

export interface ProfileWarning {
  profile: string;
  type: 'missing_table' | 'missing_column';
  table: string;
  column?: string;
}

/**
 * Validate loaded profiles against the current database schema.
 * Returns a list of warnings for stale tables/columns.
 */
export function validateProfiles(
  profiles: Record<string, { selectedTables?: Record<string, string[]>; tableOptions?: Record<string, unknown> }>,
  schemaTables: { name: string; columns: { name: string }[] }[],
): ProfileWarning[] {
  const warnings: ProfileWarning[] = [];
  const tableMap = new Map<string, Set<string>>();

  for (const table of schemaTables) {
    tableMap.set(table.name, new Set(table.columns.map((c) => c.name)));
  }

  for (const [profileName, profile] of Object.entries(profiles)) {
    const selected = profile.selectedTables;
    if (!selected) continue;

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
      let existingProfiles: Record<string, Record<string, unknown>> = {};
      try {
        const existingRow = db.raw
          .prepare("SELECT data FROM profiles WHERE key = 'main'")
          .get() as { data: string } | undefined;
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

      db.raw
        .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
        .run(JSON.stringify(data));

      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Save error', { component: 'profiles', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  app.get('/api/profiles/load', async (_req, res) => {
    try {
      const db = await getDb();
      const row = db.raw
        .prepare("SELECT data FROM profiles WHERE key = 'main'")
        .get() as { data: string } | undefined;

      if (!row) {
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
        error: 'Invalid request body',
        details: parsed.error.issues.map((i) => i.message).join('; '),
      });
      return;
    }

    const { mode } = parsed.data;

    try {
      const db = await getDb();

      const row = db.raw
        .prepare("SELECT data FROM profiles WHERE key = 'main'")
        .get() as { data: string } | undefined;

      if (!row) {
        res.status(404).json({ error: `Profile "${profileName}" not found.` });
        return;
      }

      const data = JSON.parse(row.data) as { profiles?: Record<string, Record<string, unknown>> };

      if (!data.profiles || !data.profiles[profileName]) {
        res.status(404).json({ error: `Profile "${profileName}" not found.` });
        return;
      }

      data.profiles[profileName].responseMode = mode;

      db.raw
        .prepare("INSERT OR REPLACE INTO profiles (key, data) VALUES ('main', ?)")
        .run(JSON.stringify(data));

      // Reflect the update in AppState if the profile is currently loaded
      if (state.serveProfiles[profileName]) {
        state.serveProfiles[profileName].responseMode = mode;
      }

      res.json({ success: true, profile: data.profiles[profileName] });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Response mode update error', { component: 'profiles', error: message });
      res.status(500).json({ error: 'Failed to update response mode', details: message });
    }
  });
}
