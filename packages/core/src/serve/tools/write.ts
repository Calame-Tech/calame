import type { PendingWriteQuery } from '../types.js';
import type { FilterValue } from '../filter-builder.js';
import { zodEnum, buildWriteArgsShape } from '../schema-builder.js';
import type { ToolContext, AccessibleTable } from '../tool-context.js';
import { resolveTable, structuredError, didYouMean } from '../tool-context.js';

// We use `as any` in server.tool() calls because the dynamic Zod schemas
// (Record<string, z.ZodTypeAny>) cause TS2589 "excessively deep" errors with
// the MCP SDK's generic overloads. The schemas are correctly constructed at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolArgs = any;

// ---------------------------------------------------------------------------
// Generic `write` tool — proposes INSERT/UPDATE/DELETE for admin approval.
// Nothing executes immediately; the request is queued via onWriteRequest.
// ---------------------------------------------------------------------------

export function registerWriteGeneric(
  ctx: ToolContext,
  accessible: AccessibleTable[],
  onWriteRequest: (query: Omit<PendingWriteQuery, 'id' | 'timestamp' | 'status'>) => string,
): void {
  const { server, dialect, onAuditLog, profileName, scopeGuard, toolName } = ctx;

  const eligible = accessible.filter((at) => at.enabledTools.includes('write'));
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map((at) => at.table.name));
  if (!tableEnum) return;

  const inputShape = buildWriteArgsShape(tableEnum);

  const desc =
    'Propose a write (INSERT/UPDATE/DELETE). Queued for admin approval — nothing executes immediately.';

  server.tool(
    toolName('write'),
    desc,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
      const resolved = resolveTable(args.table, accessible, 'write');
      if (!resolved.ok) return structuredError(resolved.payload);
      const at = resolved.at;

      const tableName = at.table.name;
      const schemaName = at.table.schema || 'public';
      const qualifiedTable = dialect.quoteTable(schemaName, tableName);
      const validColumnNames = new Set(at.visibleColumns.map((c) => c.name));
      const allowedFilterColumns = at.filterableCols.map((c) => c.name);

      const start = Date.now();
      const { operation, description, values, filters } = args as {
        operation: 'insert' | 'update' | 'delete';
        description: string;
        values?: Record<string, unknown>;
        filters?: Record<string, FilterValue | undefined>;
      };

      try {
        if (
          (operation === 'insert' || operation === 'update') &&
          (!values || Object.keys(values).length === 0)
        ) {
          return structuredError({
            error: `'${operation}' requires 'values' (column-value pairs)`,
          });
        }
        if (
          (operation === 'update' || operation === 'delete') &&
          (!filters || Object.keys(filters).length === 0)
        ) {
          return structuredError({
            error: `'${operation}' requires 'filters' to identify target rows`,
          });
        }
        if (values) {
          for (const colName of Object.keys(values)) {
            if (!validColumnNames.has(colName)) {
              return structuredError({
                error: `Invalid column '${colName}' for table '${tableName}'`,
                valid_columns: [...validColumnNames],
                did_you_mean: didYouMean(colName, [...validColumnNames]),
              });
            }
          }
        }

        let sql: string;
        const params: unknown[] = [];
        let paramIndex = 1;

        switch (operation) {
          case 'insert': {
            if (scopeGuard.active) {
              const scopeInfo = scopeGuard.getScopeInfo();
              const scopeFilter = scopeInfo.filters.find((f) => f.tableName === tableName);
              if (scopeFilter) {
                const currentVal = values![scopeFilter.column];
                if (currentVal !== undefined && currentVal !== scopeFilter.value) {
                  return structuredError({
                    error: `Cannot insert rows for another user. Column '${scopeFilter.column}' must match your identity.`,
                  });
                }
                if (currentVal === undefined) values![scopeFilter.column] = scopeFilter.value;
              }
            }
            const cols = Object.keys(values!);
            const colList = cols.map((c) => dialect.quoteIdent(c)).join(', ');
            const paramList = cols.map(() => dialect.param(paramIndex++)).join(', ');
            params.push(...cols.map((c) => values![c]));
            sql = `INSERT INTO ${qualifiedTable} (${colList}) VALUES (${paramList})`;
            break;
          }
          case 'update': {
            const setCols = Object.keys(values!);
            const setClause = setCols
              .map((c) => {
                params.push(values![c]);
                return `${dialect.quoteIdent(c)} = ${dialect.param(paramIndex++)}`;
              })
              .join(', ');
            const { clause: whereClause, values: whereValues } = scopeGuard.buildWhereClause(
              tableName,
              filters!,
              allowedFilterColumns,
              dialect,
              paramIndex,
            );
            params.push(...whereValues);
            if (!whereClause) {
              return structuredError({
                error: 'UPDATE requires at least one valid filter condition',
              });
            }
            sql = `UPDATE ${qualifiedTable} SET ${setClause} ${whereClause}`;
            break;
          }
          case 'delete': {
            const { clause: whereClause, values: whereValues } = scopeGuard.buildWhereClause(
              tableName,
              filters!,
              allowedFilterColumns,
              dialect,
              paramIndex,
            );
            params.push(...whereValues);
            if (!whereClause) {
              return structuredError({
                error: 'DELETE requires at least one valid filter condition',
              });
            }
            sql = `DELETE FROM ${qualifiedTable} ${whereClause}`;
            break;
          }
        }

        const id = onWriteRequest({
          profileName,
          sql,
          params,
          tableName,
          operation,
          description,
        });
        const durationMs = Date.now() - start;
        const writeResultText = `Write request submitted for approval (ID: ${id}). An admin will review it.\n\nOperation: ${operation.toUpperCase()}\nTable: ${tableName}\nSQL: ${sql}\nParams: ${JSON.stringify(params)}`;
        if (onAuditLog) {
          onAuditLog({
            profileName,
            toolName: toolName('write'),
            toolArgs: args,
            result: 'success',
            resultSummary: `Write request queued (ID: ${id})`,
            resultData: JSON.stringify({ id, operation, tableName, sql, params }),
            durationMs,
          });
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: writeResultText,
            },
          ],
        };
      } catch (err) {
        const durationMs = Date.now() - start;
        if (onAuditLog) {
          onAuditLog({
            profileName,
            toolName: toolName('write'),
            toolArgs: args,
            result: 'error',
            resultSummary: (err as Error).message,
            durationMs,
          });
        }
        return structuredError({ error: (err as Error).message });
      }
    },
  );
}
