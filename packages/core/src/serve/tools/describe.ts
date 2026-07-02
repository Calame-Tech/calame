import { zodEnum, buildDescribeArgsShape } from '../schema-builder.js';
import { executeWithAudit } from '../middleware/audit.js';
import { applyMasking } from '../middleware/masking.js';
import { snakeCaseToLabel, friendlyType } from '../response-formatter.js';
import type { ToolContext, AccessibleTable } from '../tool-context.js';
import { resolveTable, structuredError, isTextType, detectDateFormat } from '../tool-context.js';

// We use `as any` in server.tool() calls because the dynamic Zod schemas
// (Record<string, z.ZodTypeAny>) cause TS2589 "excessively deep" errors with
// the MCP SDK's generic overloads. The schemas are correctly constructed at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolArgs = any;

// ---------------------------------------------------------------------------
// Generic `describe` tool. Returns runtime stats: row count, per-column null
// counts and distinct counts, low-cardinality distinct values (preferring the
// boot-cached set), text samples, numeric min/max/avg, and FK relations.
// ---------------------------------------------------------------------------

export function registerDescribeGeneric(
  ctx: ToolContext,
  accessible: AccessibleTable[],
  distinctValuesByTable: Record<string, Record<string, unknown[]>>,
): void {
  const {
    server,
    executeQuery,
    dialect,
    onAuditLog,
    profileName,
    responseMode,
    wrapResponse,
    scopeGuard,
    toolName,
  } = ctx;
  const friendly = responseMode === 'friendly';

  const eligible = accessible.filter((at) => at.enabledTools.includes('describe'));
  if (eligible.length === 0) return;
  const tableEnum = zodEnum(eligible.map((at) => at.table.name));
  if (!tableEnum) return;

  const inputShape = buildDescribeArgsShape(tableEnum);

  const desc =
    'Explore a table schema at runtime: row count, column types, null rates, distinct counts, low-cardinality enum values, text samples, numeric min/max/avg, and FK relations to other tables. Call this when unsure about column names, valid values, or how tables relate.';

  server.tool(
    toolName('describe'),
    desc,
    inputShape as AnyToolArgs,
    async (args: Record<string, unknown>) => {
      const resolved = resolveTable(args.table, accessible, 'describe');
      if (!resolved.ok) return structuredError(resolved.payload);
      const at = resolved.at;

      const tableName = at.table.name;
      const schemaName = at.table.schema || 'public';
      const qualifiedTable = dialect.quoteTable(schemaName, tableName);
      const includeStats =
        at.enabledTools.includes('aggregate') || at.enabledTools.includes('query');
      const numericCols = includeStats ? at.numericCols : [];
      const textCols = includeStats
        ? at.visibleColumns.filter((c) => isTextType(c.type)).map((c) => c.name)
        : [];

      return executeWithAudit(
        {
          executeQuery,
          dialect,
          onAuditLog,
          profileName,
          toolName: toolName('describe'),
          toolArgs: args,
        },
        async (exec) => {
          const { clause: scopeWhere, values: scopeValues } = scopeGuard.buildScopeOnlyWhereClause(
            tableName,
            dialect,
          );

          const countResult = await exec(
            `SELECT COUNT(*) as total FROM ${qualifiedTable} ${scopeWhere}`,
            scopeValues,
          );
          const rowCount = Number(countResult.rows[0].total);

          const numericStats: Record<string, { min: unknown; max: unknown; avg: unknown }> = {};
          const colStats: Record<string, { nullCount: number; distinctCount: number }> = {};
          const allColsForStats = includeStats ? at.visibleColumns : [];
          if (allColsForStats.length > 0) {
            const parts: string[] = [];
            for (const c of allColsForStats) {
              const qi = dialect.quoteIdent(c.name);
              parts.push(
                `SUM(CASE WHEN ${qi} IS NULL THEN 1 ELSE 0 END) as ${dialect.quoteIdent(`${c.name}__nulls`)}`,
                `COUNT(DISTINCT ${qi}) as ${dialect.quoteIdent(`${c.name}__distinct`)}`,
              );
            }
            for (const col of numericCols) {
              const qi = dialect.quoteIdent(col);
              parts.push(
                `MIN(${qi}) as ${dialect.quoteIdent(`${col}__min`)}`,
                `MAX(${qi}) as ${dialect.quoteIdent(`${col}__max`)}`,
                `AVG(${qi}) as ${dialect.quoteIdent(`${col}__avg`)}`,
              );
            }
            const statsResult = await exec(
              `SELECT ${parts.join(', ')} FROM ${qualifiedTable} ${scopeWhere}`,
              [...scopeValues],
            );
            const row = statsResult.rows[0] as Record<string, unknown>;
            for (const c of allColsForStats) {
              colStats[c.name] = {
                nullCount: Number(row[`${c.name}__nulls`] ?? 0),
                distinctCount: Number(row[`${c.name}__distinct`] ?? 0),
              };
            }
            for (const col of numericCols) {
              const key = friendly ? (at.labelMap[col] ?? snakeCaseToLabel(col)) : col;
              numericStats[key] = {
                min: row[`${col}__min`],
                max: row[`${col}__max`],
                avg: row[`${col}__avg`],
              };
            }
          }

          const MAX_ENUM = 20;
          const MAX_SAMPLE = 50;
          const distinctByCol: Record<string, unknown[]> = {};
          const sampleByCol: Record<string, string[] | undefined> = {};

          // Reuse the boot-time distinct values when available
          const cached = distinctValuesByTable[tableName] ?? {};
          for (const [col, vals] of Object.entries(cached)) {
            if (Array.isArray(vals) && vals.length > 0 && vals.length <= MAX_ENUM) {
              distinctByCol[col] = vals;
            }
          }

          for (const c of allColsForStats) {
            if (distinctByCol[c.name]) continue;
            const stats = colStats[c.name];
            if (!stats) continue;
            const distinct = stats.distinctCount;
            const isLowCardinality = distinct > 0 && distinct <= MAX_ENUM;
            const isSampleable =
              isTextType(c.type) && distinct > MAX_ENUM && distinct <= MAX_SAMPLE;
            if (!isLowCardinality && !isSampleable) continue;
            try {
              const qi = dialect.quoteIdent(c.name);
              const notNullCondition = `${qi} IS NOT NULL`;
              const valWhere = scopeWhere
                ? `${scopeWhere} AND ${notNullCondition}`
                : `WHERE ${notNullCondition}`;
              const cap = isLowCardinality ? MAX_ENUM : MAX_SAMPLE;
              const valSql = `SELECT DISTINCT ${qi} AS val FROM ${qualifiedTable} ${valWhere} ORDER BY val LIMIT ${cap + 1}`;
              const valResult = await exec(valSql, [...scopeValues]);
              const rawVals = valResult.rows.map((r) => (r as Record<string, unknown>).val);
              if (isLowCardinality) {
                let vals: unknown[] = rawVals;
                const colMaskRule = at.maskingRules[c.name];
                if (
                  colMaskRule &&
                  (colMaskRule.mode === 'hash' ||
                    colMaskRule.mode === 'truncate' ||
                    colMaskRule.mode === 'replace')
                ) {
                  vals = applyMasking(
                    rawVals.map((v) => ({ [c.name]: v })),
                    { [c.name]: colMaskRule },
                  ).map((r) => r[c.name]);
                }
                distinctByCol[c.name] = vals;
              } else {
                let vals = rawVals.map((v) => String(v));
                const colMaskRule = at.maskingRules[c.name];
                if (
                  colMaskRule &&
                  (colMaskRule.mode === 'hash' ||
                    colMaskRule.mode === 'truncate' ||
                    colMaskRule.mode === 'replace')
                ) {
                  vals = applyMasking(
                    vals.map((v) => ({ [c.name]: v })),
                    { [c.name]: colMaskRule },
                  ).map((r) => String(r[c.name]));
                }
                if (vals.length <= MAX_SAMPLE) sampleByCol[c.name] = vals;
              }
            } catch {
              // Skip
            }
          }

          // Legacy textStats shape kept for backward compatibility
          const textStats: Record<string, { distinctCount: number; sampleValues?: string[] }> = {};
          for (const col of textCols) {
            const stats = colStats[col];
            if (!stats) continue;
            const key = friendly ? (at.labelMap[col] ?? snakeCaseToLabel(col)) : col;
            const sample = sampleByCol[col];
            const lowCardVals = distinctByCol[col];
            const sampleValues = sample
              ? sample
              : lowCardVals
                ? lowCardVals.map((v) => String(v))
                : undefined;
            textStats[key] = sampleValues
              ? { distinctCount: stats.distinctCount, sampleValues }
              : { distinctCount: stats.distinctCount };
          }

          const columnsMetadata = friendly
            ? at.visibleColumns.map((c) => {
                const colMeta: Record<string, unknown> = {
                  name: at.labelMap[c.name] ?? snakeCaseToLabel(c.name),
                  column_name: c.name,
                  type: friendlyType(c.type),
                  required: !c.nullable,
                };
                if (distinctByCol[c.name]) colMeta.possibleValues = distinctByCol[c.name];
                else if (sampleByCol[c.name]) colMeta.sampleValues = sampleByCol[c.name];
                const describeSamples = distinctByCol[c.name] ?? sampleByCol[c.name] ?? [];
                const detectedFmt = detectDateFormat(c.type, describeSamples);
                if (detectedFmt) colMeta.date_format = detectedFmt;
                const stats = colStats[c.name];
                if (stats?.distinctCount !== undefined && rowCount > 0) {
                  colMeta.is_unique = stats.distinctCount === rowCount;
                }
                if (stats?.distinctCount === 1 && distinctByCol[c.name]?.length === 1) {
                  colMeta.effectively_constant = true;
                  colMeta.constant_value = distinctByCol[c.name]![0];
                }
                return colMeta;
              })
            : at.visibleColumns.map((c) => {
                const stats = colStats[c.name];
                const nullCount = stats?.nullCount;
                const distinctCount = stats?.distinctCount;
                const nullRatio =
                  stats && rowCount > 0
                    ? Math.round((nullCount! / rowCount) * 10000) / 10000
                    : undefined;
                const colMeta: Record<string, unknown> = {
                  name: c.name,
                  type: c.type,
                  nullable: c.nullable,
                  defaultValue: c.defaultValue,
                };
                if (nullCount !== undefined) colMeta.null_count = nullCount;
                if (nullRatio !== undefined) colMeta.null_ratio = nullRatio;
                if (distinctCount !== undefined) colMeta.distinct_count = distinctCount;
                if (distinctCount !== undefined && rowCount > 0)
                  colMeta.is_unique = distinctCount === rowCount;
                if (distinctByCol[c.name]) colMeta.distinct_values = distinctByCol[c.name];
                else if (sampleByCol[c.name]) colMeta.sample_values = sampleByCol[c.name];
                // Detect ISO date format for string-typed columns
                const describeSamples = distinctByCol[c.name] ?? sampleByCol[c.name] ?? [];
                const detectedFmt = detectDateFormat(c.type, describeSamples);
                if (detectedFmt) colMeta.date_format = detectedFmt;
                // Signal effectively-constant columns to avoid wasting filter / group-by attempts
                if (distinctCount === 1 && distinctByCol[c.name]?.length === 1) {
                  colMeta.effectively_constant = true;
                  colMeta.constant_value = distinctByCol[c.name]![0];
                }
                return colMeta;
              });

          const relationsMetadata = at.relations.map((r) => ({
            from_table: friendly ? snakeCaseToLabel(r.fromTable) : r.fromTable,
            from_table_name: r.fromTable,
            from_column: friendly ? snakeCaseToLabel(r.fromColumn) : r.fromColumn,
            from_column_name: r.fromColumn,
            to_table: friendly ? snakeCaseToLabel(r.toTable) : r.toTable,
            to_table_name: r.toTable,
            to_column: friendly ? snakeCaseToLabel(r.toColumn) : r.toColumn,
            to_column_name: r.toColumn,
          }));

          const displayName = friendly ? snakeCaseToLabel(tableName) : tableName;
          const payload = friendly
            ? {
                table: displayName,
                table_name: tableName,
                columns: columnsMetadata,
                rowCount,
                relations: relationsMetadata,
              }
            : {
                table: tableName,
                schema: schemaName,
                columns: columnsMetadata,
                rowCount,
                numericStats,
                textStats,
                relations: relationsMetadata,
              };

          const text = wrapResponse(JSON.stringify(payload, null, 2));
          return {
            content: [{ type: 'text' as const, text }],
            resultSummary: `${rowCount} rows, ${at.visibleColumns.length} columns`,
            resultData: text,
          };
        },
      );
    },
  );
}
