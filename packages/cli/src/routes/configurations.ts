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
};

/** Read all configurations from SQLite. Returns an empty structure if the table is empty.
 *  Each row is passed through `upgradeConfigurationShape` on read so that callers always
 *  receive the new `sources`/`scopes` shape. Legacy SQLite columns are preserved — the
 *  migrator only synthesises the new fields in memory (plan §1.3, §2 Phase 2).
 */
function readConfigurationsFile(db: CalameDatabase): ConfigurationsFileData {
  const rows = db.raw
    .prepare('SELECT name, label, connections, selected_tables, table_options, column_masking FROM configurations')
    .all() as ConfigRow[];

  const configurations: ConfigurationsFileData['configurations'] = {};
  for (const row of rows) {
    const legacyShape = {
      name: row.name,
      label: row.label,
      connections: JSON.parse(row.connections) as string[],
      selectedTables: JSON.parse(row.selected_tables) as Record<string, string[]>,
      tableOptions: row.table_options ? (JSON.parse(row.table_options) as Record<string, unknown>) : undefined,
      columnMasking: row.column_masking
        ? (JSON.parse(row.column_masking) as Record<string, Record<string, unknown>>)
        : undefined,
    };
    // Upgrade to new shape on read; idempotent for configurations already in new shape.
    configurations[row.name] = upgradeConfigurationShape(legacyShape);
  }
  return { configurations };
}

/** Write a single configuration to SQLite using INSERT OR REPLACE. */
function writeConfigurationRow(
  db: CalameDatabase,
  name: string,
  cfg: ConfigurationsFileData['configurations'][string],
): void {
  db.raw
    .prepare(
      `INSERT OR REPLACE INTO configurations (name, label, connections, selected_tables, table_options, column_masking)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      cfg.label,
      JSON.stringify(cfg.connections),
      JSON.stringify(cfg.selectedTables),
      cfg.tableOptions !== undefined ? JSON.stringify(cfg.tableOptions) : null,
      cfg.columnMasking !== undefined ? JSON.stringify(cfg.columnMasking) : null,
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
      const { name, label, connections, selectedTables, tableOptions, columnMasking } = req.body as {
        name?: unknown;
        label?: unknown;
        connections?: unknown;
        selectedTables?: unknown;
        tableOptions?: unknown;
        columnMasking?: unknown;
      };

      if (!name || typeof name !== 'string') {
        res.status(400).json({ success: false, message: 'name is required and must be a string' });
        return;
      }

      if (!connections || !Array.isArray(connections) || connections.length === 0) {
        res
          .status(400)
          .json({ success: false, message: 'connections is required and must be a non-empty array' });
        return;
      }

      if (!selectedTables || typeof selectedTables !== 'object') {
        res
          .status(400)
          .json({ success: false, message: 'selectedTables is required and must be an object' });
        return;
      }

      const configLabel = typeof label === 'string' && label.length > 0 ? label : name;
      const db = await getDb();

      // Check if this is an overwrite
      const existing = db.raw.prepare('SELECT name FROM configurations WHERE name = ?').get(name);
      const overwritten = !!existing;

      // Normalise through the migrator so that sources/scopes are always populated.
      // The legacy SQLite columns (selected_tables etc.) are kept for backward compat (plan §1.3).
      const upgraded = upgradeConfigurationShape({
        name,
        label: configLabel,
        connections: connections as string[],
        selectedTables: selectedTables as Record<string, string[]>,
        tableOptions: tableOptions as Record<string, unknown> | undefined,
        columnMasking: columnMasking as Record<string, Record<string, unknown>> | undefined,
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
