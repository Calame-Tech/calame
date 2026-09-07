import type { Express } from 'express';
import { z } from 'zod';
import { getConnector } from '@calame/connectors';
import { makeDialect } from '@calame/core';
import type { AppState } from '../state.js';
import { redactSecrets } from '../sanitize.js';

const queryBodySchema = z.object({
  tableName: z.string().min(1, 'tableName is required'),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().min(0).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
});

/** Read the global query timeout from config or environment (default 10000ms). */
function getQueryTimeoutMs(): number {
  return parseInt(process.env.CALAME_QUERY_TIMEOUT_MS ?? '10000', 10) || 10000;
}

export function registerQueryRoute(app: Express, state: AppState): void {
  app.post('/api/query', async (req, res) => {
    try {
      const parsed = queryBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message ?? 'Invalid request body',
          errors: parsed.error.issues,
        });
        return;
      }

      const { tableName, limit, offset, filters } = parsed.data;

      if (!state.cachedSchema || !state.cachedConnectionString || !state.cachedDatabaseType) {
        res.status(400).json({ success: false, message: 'No database connected.' });
        return;
      }

      const table = state.cachedSchema.tables.find((t) => t.name === tableName);
      if (!table) {
        res
          .status(404)
          .json({ success: false, message: `Table "${tableName}" not found in schema.` });
        return;
      }

      const connector = getConnector(state.cachedDatabaseType);
      const connectionString = state.cachedConnectionString;
      const connState = state.getConnection('default');
      const connOptions = connState?.connection.sslConfig
        ? { ssl: connState.connection.sslConfig }
        : undefined;

      // Reuse the serve layer's dialect so quoting, placeholders and
      // pagination match what the MCP tools emit for the same backend.
      const dialect = makeDialect(state.cachedDatabaseType ?? 'postgresql');

      const quoteCol = (col: string): string => dialect.quoteIdent(col);
      const fromTarget = dialect.quoteTable(table.schema || dialect.defaultSchema, table.name);
      const placeholder = (index: number): string => dialect.param(index);

      const conditions: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      // Apply filters (simple equality) — validate column names against schema
      if (filters && typeof filters === 'object') {
        const validColumnNames = new Set(table.columns.map((c) => c.name));
        for (const [col, val] of Object.entries(filters as Record<string, unknown>)) {
          if (!validColumnNames.has(col)) {
            continue; // Ignore unknown columns to prevent SQL injection
          }
          if (val !== undefined && val !== null && val !== '') {
            conditions.push(`${quoteCol(col)} = ${placeholder(paramIndex)}`);
            values.push(val);
            paramIndex++;
          }
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const queryLimit = Math.min(Number(limit) || 50, 200);
      const queryOffset = Number(offset) || 0;

      values.push(queryLimit);
      const limitParam = placeholder(paramIndex);
      paramIndex++;
      values.push(queryOffset);
      const offsetParam = placeholder(paramIndex);

      // No ORDER BY here — the dialect injects a no-op one on SQL Server,
      // whose OFFSET/FETCH pagination requires it.
      const sql = `SELECT * FROM ${fromTarget} ${whereClause} ${dialect.paginate('', limitParam, offsetParam)}`;
      const result = await connector.query(connectionString, sql, {
        timeoutMs: getQueryTimeoutMs(),
        ...connOptions,
        params: values,
      });

      // Also get total count — count query uses only the filter params (no LIMIT/OFFSET)
      const countValues = values.slice(0, values.length - 2);
      const countSql = `SELECT COUNT(*) as total FROM ${fromTarget} ${whereClause}`;
      const countResult = await connector.query(connectionString, countSql, {
        timeoutMs: getQueryTimeoutMs(),
        ...connOptions,
        params: countValues,
      });
      const total = parseInt(String(countResult.rows[0]?.total ?? '0'), 10);

      res.json({
        success: true,
        rows: result.rows,
        rowCount: result.rows.length,
        total,
        columns: Object.keys(result.rows[0] ?? {}),
      });
    } catch (error: unknown) {
      const rawMessage = error instanceof Error ? error.message : 'Unknown error';
      const message = redactSecrets(rawMessage);
      state.logger?.error('Error', { component: 'query', error: message });
      res.status(500).json({ success: false, message });
    }
  });
}
