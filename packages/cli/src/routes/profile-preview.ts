import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import { getConnector } from '@calame/connectors';
import type { AppState } from '../state.js';
import type { TableToolOptions, ColumnMasking, ScopeSelection, ServeConfiguration } from '@calame/core';
import {
  getProfileSelectedTables,
  getProfileTableOptions,
  getProfileColumnMasking,
  getProfileRelationalSources,
} from '@calame/core';
import { mergeConfigurations } from './serve.js';
import { readConfigurationsFile } from './configurations.js';
import { getTenantId } from '../tenancy.js';

interface PreviewColumnInfo {
  name: string;
  type: string;
  visible: boolean;
  masking?: string;
}

interface PreviewTableResult {
  name: string;
  enabledTools: string[];
  columns: PreviewColumnInfo[];
  rowCount: number;
  sampleRow: Record<string, unknown> | null;
}

interface PreviewResult {
  profileName: string;
  tables: PreviewTableResult[];
}

/** Apply column masking to a single row for preview. */
function applyPreviewMasking(
  row: Record<string, unknown>,
  tableName: string,
  columnMasking: Record<string, Record<string, ColumnMasking>> | undefined,
): Record<string, unknown> {
  if (!columnMasking) return row;
  const tableMasking = columnMasking[tableName];
  if (!tableMasking) return row;

  const masked = { ...row };
  for (const [col, config] of Object.entries(tableMasking)) {
    if (!(col in masked)) continue;
    const mode = config.maskingMode;
    if (mode === 'exclude' || mode === 'aggregate_only') {
      delete masked[col];
    } else if (mode === 'hash') {
      const val = String(masked[col] ?? '');
      if (val.length > 0) {
        masked[col] = crypto.createHash('sha256').update(val).digest('hex').slice(0, 16);
      }
    } else if (mode === 'truncate') {
      const val = String(masked[col] ?? '');
      const showFirst = config.truncateOptions?.showFirst ?? 3;
      const showLast = config.truncateOptions?.showLast ?? 0;
      if (val.length > showFirst + showLast) {
        masked[col] = val.slice(0, showFirst) + '...' + (showLast > 0 ? val.slice(-showLast) : '');
      }
    } else if (mode === 'replace') {
      masked[col] = config.replaceValue ?? '[REDACTED]';
    }
  }
  return masked;
}

/** Quote a table name for the given database type. */
function quoteTableName(tableName: string, databaseType: string): string {
  if (databaseType === 'mysql') return `\`${tableName}\``;
  return `"${tableName}"`;
}

/** Quote a column name for the given database type. */
function quoteColumnName(colName: string, databaseType: string): string {
  if (databaseType === 'mysql') return `\`${colName}\``;
  return `"${colName}"`;
}

export function registerProfilePreviewRoute(app: Express, state: AppState): void {
  /**
   * POST /api/profiles/:name/preview
   * Dry-run a profile: resolve its configuration and return column info + sample data per table.
   */
  app.post('/api/profiles/:name/preview', async (req: Request, res: Response) => {
    const profileName = req.params.name as string;

    try {
      if (!state.db) {
        res.status(500).json({ success: false, message: 'Database not initialized.' });
        return;
      }

      // Load the profile from the profiles store. Phase B multi-tenancy:
      // bind the tenant on the lookup so cross-tenant profile names resolve
      // as 404, not as the other tenant's profile.
      const tenantId = getTenantId(req);
      const row = state.db.raw
        .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
        .get(tenantId) as { data: string } | undefined;

      if (!row) {
        res.status(404).json({ success: false, message: `Profile "${profileName}" not found.` });
        return;
      }

      const profilesData = JSON.parse(row.data) as {
        profiles?: Record<
          string,
          {
            label?: string;
            connections?: string[];
            configurations?: string[];
            selectedTables?: Record<string, string[]>;
            tableOptions?: Record<string, TableToolOptions>;
            columnMasking?: Record<string, Record<string, ColumnMasking>>;
            // Phase 2+ unified shape — read by accessors with fallback to the
            // legacy fields above for profiles authored before the migration.
            sources?: string[];
            scopes?: Record<string, ScopeSelection>;
          }
        >;
      };

      const profile = profilesData.profiles?.[profileName];
      if (!profile) {
        res.status(404).json({ success: false, message: `Profile "${profileName}" not found.` });
        return;
      }

      // Resolve effective config (same logic as serve.ts)
      let effectiveConnections: string[];
      let effectiveSelectedTables: Record<string, string[]>;
      let effectiveTableOptions: Record<string, TableToolOptions> | undefined;
      let effectiveColumnMasking: Record<string, Record<string, ColumnMasking>> | undefined;

      if (profile.configurations && profile.configurations.length > 0) {
        // Phase B multi-tenancy: bind tenant on the configurations read so
        // a cross-tenant configuration name does not leak into the preview.
        const configsFile = readConfigurationsFile(state.db, tenantId);
        const resolvedConfigs = profile.configurations
          .map((configName) => configsFile.configurations[configName])
          .filter(Boolean) as ServeConfiguration[];

        if (resolvedConfigs.length === 0) {
          res.status(400).json({ success: false, message: 'No valid configurations found for this profile.' });
          return;
        }

        const merged = mergeConfigurations(resolvedConfigs);
        effectiveConnections = merged.connections;
        effectiveSelectedTables = merged.selectedTables;
        effectiveTableOptions = merged.tableOptions;
        effectiveColumnMasking = merged.columnMasking;
      } else {
        const profileShape = profile;
        const relationalSources = getProfileRelationalSources(profileShape);
        effectiveConnections = relationalSources.length
          ? relationalSources
          : [...state.connections.keys()];
        effectiveSelectedTables = getProfileSelectedTables(profileShape);
        effectiveTableOptions = getProfileTableOptions(profileShape);
        effectiveColumnMasking = getProfileColumnMasking(profileShape);
      }

      const tables: PreviewTableResult[] = [];

      for (const [tableName, selectedColumns] of Object.entries(effectiveSelectedTables)) {
        // Find the connection that owns this table
        let connectionString: string | undefined;
        let databaseType: string | undefined;
        let tableColumns: Array<{ name: string; type: string }> = [];

        for (const connName of effectiveConnections) {
          const cs = state.getConnection(connName);
          if (!cs) continue;
          const tableInfo = cs.schema.tables.find((t) => t.name === tableName);
          if (tableInfo) {
            connectionString = cs.connection.connectionString;
            databaseType = cs.connection.databaseType;
            tableColumns = tableInfo.columns.map((c) => ({ name: c.name, type: c.type }));
            break;
          }
        }

        const tableOpts = effectiveTableOptions?.[tableName];
        const enabledTools = tableOpts?.enabledTools ?? ['describe', 'aggregate', 'query'];
        const tableMasking = effectiveColumnMasking?.[tableName] ?? {};

        // Build column visibility info
        const resolvedColumns = selectedColumns.length > 0 ? selectedColumns : tableColumns.map((c) => c.name);
        const columns: PreviewColumnInfo[] = tableColumns
          .filter((col) => resolvedColumns.includes(col.name))
          .map((col) => {
            const maskingConfig = tableMasking[col.name];
            if (maskingConfig?.maskingMode === 'exclude') {
              return { name: col.name, type: col.type, visible: false };
            }
            if (maskingConfig && maskingConfig.maskingMode !== 'none') {
              return {
                name: col.name,
                type: col.type,
                visible: true,
                masking: maskingConfig.maskingMode,
              };
            }
            return { name: col.name, type: col.type, visible: true };
          });

        // Fetch row count and sample row via connector
        let rowCount = 0;
        let sampleRow: Record<string, unknown> | null = null;

        if (connectionString && databaseType) {
          const connector = getConnector(databaseType as Parameters<typeof getConnector>[0]);
          const quotedTable = quoteTableName(tableName, databaseType);

          try {
            const countResult = await connector.query(
              connectionString,
              `SELECT COUNT(*) AS cnt FROM ${quotedTable}`,
              { timeoutMs: 10000 },
            );
            const countRow = countResult.rows[0];
            if (countRow) {
              rowCount = Number(countRow['cnt'] ?? countRow['COUNT(*)'] ?? 0);
            }
          } catch {
            rowCount = 0;
          }

          // Fetch sample row using only visible columns
          const visibleCols = columns.filter((c) => c.visible).map((c) => c.name);
          if (visibleCols.length > 0) {
            const quotedCols = visibleCols
              .map((c) => quoteColumnName(c, databaseType!))
              .join(', ');
            try {
              const sampleResult = await connector.query(
                connectionString,
                `SELECT ${quotedCols} FROM ${quotedTable} LIMIT 1`,
                { timeoutMs: 10000 },
              );
              if (sampleResult.rows.length > 0) {
                sampleRow = applyPreviewMasking(
                  sampleResult.rows[0],
                  tableName,
                  effectiveColumnMasking,
                );
              }
            } catch {
              sampleRow = null;
            }
          }
        }

        tables.push({
          name: tableName,
          enabledTools: enabledTools as string[],
          columns,
          rowCount,
          sampleRow,
        });
      }

      const result: PreviewResult = { profileName, tables };
      res.json({ success: true, preview: result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[POST /api/profiles/${profileName}/preview] ${message}`);
      res.status(500).json({ success: false, message: 'Preview failed' });
    }
  });
}
