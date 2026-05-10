import type { Express } from 'express';
import type { AppState } from '../state.js';
import type { CalameDatabase } from '../database.js';
import type { ServeConfiguration } from '@calame/core';
import { upgradeConfigurationShape } from '@calame/core';

interface ConfigurationsFileData {
  configurations: Record<string, ServeConfiguration>;
}

type ConfigRow = {
  name: string;
  label: string;
  connections: string;
  selected_tables: string;
  table_options: string | null;
  column_masking: string | null;
  /** Added in migration v10 — stores the Phase 5 unified sources/scopes blob. */
  sources_scopes: string | null;
};

/** Read all configurations from SQLite. Returns an empty structure if the table is empty.
 *  Each row is passed through `upgradeConfigurationShape` on read so that callers always
 *  receive the new `sources`/`scopes` shape.
 *
 *  Migration v10 added the `sources_scopes` column. When it is populated (Phase 5 rows),
 *  its blob is used directly so that the unified shape survives the round-trip without loss.
 *  Older rows fall back to the legacy columns (connections, selected_tables, …) which the
 *  migrator synthesises into sources/scopes in memory.
 */
function readConfigurationsFile(db: CalameDatabase): ConfigurationsFileData {
  const rows = db.raw
    .prepare(
      'SELECT name, label, connections, selected_tables, table_options, column_masking, sources_scopes FROM configurations',
    )
    .all() as ConfigRow[];

  const configurations: ConfigurationsFileData['configurations'] = {};
  for (const row of rows) {
    // Prefer the unified blob (written by Phase 5 writes) when available.
    const rawShape: Record<string, unknown> = row.sources_scopes
      ? (JSON.parse(row.sources_scopes) as Record<string, unknown>)
      : {
          name: row.name,
          label: row.label,
          connections: JSON.parse(row.connections) as string[],
          selectedTables: JSON.parse(row.selected_tables) as Record<string, string[]>,
          tableOptions: row.table_options
            ? (JSON.parse(row.table_options) as Record<string, unknown>)
            : undefined,
          columnMasking: row.column_masking
            ? (JSON.parse(row.column_masking) as Record<string, Record<string, unknown>>)
            : undefined,
        };
    // upgradeConfigurationShape is idempotent — unified blobs pass through unchanged.
    configurations[row.name] = upgradeConfigurationShape(rawShape);
  }
  return { configurations };
}

/** Write a single configuration to SQLite using INSERT OR REPLACE.
 *
 * Phase 5: `upgradeConfigurationShape` strips the legacy root fields
 * (`connections`, `selectedTables`, `tableOptions`, `columnMasking`) from the
 * returned object and moves their data into `sources`/`scopes`. The SQLite
 * legacy columns carry NOT NULL constraints (initial schema — plan §1.3), so
 * we write empty JSON fallbacks for them to avoid constraint violations.
 * The full unified blob is stored in `sources_scopes` (migration v10) so that
 * Phase 5 data survives the read round-trip without going through synthesis.
 */
function writeConfigurationRow(
  db: CalameDatabase,
  name: string,
  cfg: ConfigurationsFileData['configurations'][string],
): void {
  db.raw
    .prepare(
      `INSERT OR REPLACE INTO configurations
         (name, label, connections, selected_tables, table_options, column_masking, sources_scopes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      cfg.label,
      // Legacy NOT-NULL columns: write empty fallbacks when Phase 5 has stripped them.
      JSON.stringify(cfg.connections ?? []),
      JSON.stringify(cfg.selectedTables ?? {}),
      cfg.tableOptions !== undefined ? JSON.stringify(cfg.tableOptions) : null,
      cfg.columnMasking !== undefined ? JSON.stringify(cfg.columnMasking) : null,
      // Unified blob: always written so reads prefer it over the legacy reconstruction.
      JSON.stringify(cfg),
    );
}

/** Delete a single configuration from SQLite. */
function deleteConfigurationRow(db: CalameDatabase, name: string): void {
  db.raw.prepare('DELETE FROM configurations WHERE name = ?').run(name);
}

export { readConfigurationsFile };

export function registerConfigurationsRoute(app: Express, state: AppState): void {
  async function getDb(): Promise<CalameDatabase> {
    if (!state.db) {
      const dataDir = state.config?.dataDir ?? process.cwd();
      const { CalameDatabase } = await import('../database.js');
      state.db = new CalameDatabase(dataDir);
    }
    return state.db;
  }

  // GET /api/configurations — List all configurations
  app.get('/api/configurations', async (_req, res) => {
    try {
      const db = await getDb();
      const fileData = readConfigurationsFile(db);
      res.json({ success: true, configurations: fileData.configurations });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[configurations] GET error:', message);
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/configurations — Create or update a configuration
  app.post('/api/configurations', async (req, res) => {
    try {
      const payload = req.body as Record<string, unknown>;
      const { name, label } = payload as { name?: unknown; label?: unknown };

      if (!name || typeof name !== 'string') {
        res.status(400).json({ success: false, message: 'name is required and must be a string' });
        return;
      }

      // Accept either the legacy shape (connections + selectedTables) or the Phase 5 unified
      // shape (sources + scopes). Normalisation is fully delegated to upgradeConfigurationShape
      // which handles both variants and is idempotent.
      const hasLegacy =
        Array.isArray(payload['connections']) &&
        (payload['connections'] as unknown[]).length > 0 &&
        payload['selectedTables'] !== null &&
        typeof payload['selectedTables'] === 'object';

      const hasUnified =
        (Array.isArray(payload['sources']) && (payload['sources'] as unknown[]).length > 0) ||
        (payload['scopes'] !== null &&
          typeof payload['scopes'] === 'object' &&
          !Array.isArray(payload['scopes']) &&
          Object.keys(payload['scopes'] as Record<string, unknown>).length > 0);

      if (!hasLegacy && !hasUnified) {
        res.status(400).json({
          success: false,
          message: 'must provide either (connections + selectedTables) or (sources + scopes)',
        });
        return;
      }

      const configLabel = typeof label === 'string' && label.length > 0 ? label : name;
      const db = await getDb();

      // Check if this is an overwrite
      const existing = db.raw.prepare('SELECT name FROM configurations WHERE name = ?').get(name);
      const overwritten = !!existing;

      // Normalise through the migrator so that sources/scopes are always populated.
      // Pass the full payload so upgradeConfigurationShape receives both legacy and unified
      // fields without losing any data. The deep-copy inside the migrator ensures the
      // original request object is never mutated.
      const upgraded = upgradeConfigurationShape({
        ...payload,
        name,
        label: configLabel,
      });

      writeConfigurationRow(db, name, upgraded);

      res.json({ success: true, name, overwritten });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[configurations] POST error:', message);
      res.status(500).json({ success: false, message });
    }
  });

  // DELETE /api/configurations/:name — Remove a configuration
  app.delete('/api/configurations/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const db = await getDb();

      const existing = db.raw.prepare('SELECT name FROM configurations WHERE name = ?').get(name);
      if (!existing) {
        res.status(404).json({ success: false, message: `Configuration "${name}" not found` });
        return;
      }

      deleteConfigurationRow(db, name);

      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[configurations] DELETE error:', message);
      res.status(500).json({ success: false, message });
    }
  });
}
