/**
 * Manifest size measurement for the test-logistique profile.
 *
 * Walks the same registerDynamicTools path the MCP server uses, captures
 * every tool registration, and serializes each input schema with
 * zod-to-json-schema so the byte/token cost reflects what an MCP client
 * actually receives in tools/list.
 *
 * Usage: pnpm --filter calame exec tsx scripts/manifest-stats.ts
 */

import Database from 'better-sqlite3';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4-mini';
import { registerDynamicTools, createScopeGuard, computeDistinctValues } from '@calame/core';
import type { TableInfo, Relation } from '@calame/core';

// The MCP SDK uses Zod v4-mini's toJSONSchema for v4 schemas (see
// @modelcontextprotocol/sdk/server/zod-json-schema-compat.js). We reuse the
// same converter so the script's byte counts match what an MCP client
// receives in tools/list over the wire.

interface CapturedTool {
  name: string;
  description: string;
  inputShape: Record<string, z.ZodTypeAny>;
}

class CaptureServer {
  readonly tools: CapturedTool[] = [];
  // The real McpServer has a richer surface; we only need .tool() here.
  tool(
    name: string,
    description: string,
    inputShape: Record<string, z.ZodTypeAny>,
    _handler: unknown,
  ): void {
    this.tools.push({ name, description, inputShape });
  }
}

interface ConfigRow {
  selected_tables: string;
  table_options: string | null;
  column_masking: string | null;
  connections: string;
}

interface SqliteColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function introspectSqliteSchema(dbPath: string): { tables: TableInfo[]; relations: Relation[] } {
  const db = new Database(dbPath, { readonly: true });
  const tableNames = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>
  ).map((r) => r.name);
  const tables: TableInfo[] = tableNames.map((tname) => {
    const cols = db.prepare(`PRAGMA table_info(${tname})`).all() as SqliteColumn[];
    return {
      name: tname,
      schema: 'main',
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.notnull === 0,
        defaultValue: c.dflt_value,
      })),
    };
  });
  const relations: Relation[] = [];
  for (const tname of tableNames) {
    const fks = db
      .prepare(`PRAGMA foreign_key_list(${tname})`)
      .all() as Array<{ from: string; table: string; to: string }>;
    for (const fk of fks) {
      relations.push({
        fromTable: tname,
        fromColumn: fk.from,
        toTable: fk.table,
        toColumn: fk.to,
      });
    }
  }
  db.close();
  return { tables, relations };
}

function approxTokens(text: string): number {
  // Rough heuristic for JSON Schema content: ~3.5 bytes per token.
  // Good enough for relative comparisons before/after a fix.
  return Math.round(Buffer.byteLength(text, 'utf8') / 3.5);
}

function categorizeBlock(json: string): {
  describePct: number;
  enumPct: number;
  rest: number;
} {
  // Heuristic: count substrings tagged as describe/description, enum lists,
  // and everything else. Returns percentage of total bytes.
  const total = Buffer.byteLength(json, 'utf8');
  const describeMatches = json.match(/"description":"[^"]*"/g) ?? [];
  const describeBytes = describeMatches.reduce((s, m) => s + Buffer.byteLength(m, 'utf8'), 0);
  const enumMatches = json.match(/"enum":\[[^\]]*\]/g) ?? [];
  const enumBytes = enumMatches.reduce((s, m) => s + Buffer.byteLength(m, 'utf8'), 0);
  const rest = total - describeBytes - enumBytes;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    describePct: pct(describeBytes),
    enumPct: pct(enumBytes),
    rest: pct(rest),
  };
}

async function main(): Promise<void> {
  const adminDb = new Database('calame.db', { readonly: true });
  const row = adminDb.prepare(`SELECT data FROM profiles WHERE key = 'main'`).get() as { data: string } | undefined;
  if (!row) throw new Error('no profile main row');
  const adminProfileFile = JSON.parse(row.data) as {
    profiles: Record<string, { configurations?: string[]; selectedTables?: Record<string, string[]>; tableOptions?: Record<string, unknown> }>;
  };
  const profile = adminProfileFile.profiles['test-logistique'];
  if (!profile) throw new Error('test-logistique not found');

  const configName = profile.configurations?.[0];
  if (!configName) throw new Error('test-logistique has no configuration');
  const cfgRow = adminDb.prepare(`SELECT * FROM configurations WHERE name = ?`).get(configName) as ConfigRow | undefined;
  if (!cfgRow) throw new Error('config not found: ' + configName);
  adminDb.close();

  const selectedTables = JSON.parse(cfgRow.selected_tables) as Record<string, string[]>;
  const tableOptions = cfgRow.table_options ? JSON.parse(cfgRow.table_options) : {};
  const columnMasking = cfgRow.column_masking ? JSON.parse(cfgRow.column_masking) : {};

  const { tables, relations } = introspectSqliteSchema('demo-logistique-v2.db');
  const visibleTables = tables.filter((t) => selectedTables[t.name]);

  // Phase 2.5: pre-compute distinct values so the catalogue baked into the
  // tool descriptions shows `enum:a|b|c` for low-cardinality columns.
  const dataDb = new Database('demo-logistique-v2.db', { readonly: true });
  const exec = async (sql: string, params: unknown[]) => {
    const rows = dataDb.prepare(sql).all(...params) as Record<string, unknown>[];
    return { rows, fields: Object.keys(rows[0] ?? {}).map((name) => ({ name })) };
  };
  const distinctValuesByTable = await computeDistinctValues({
    tables: visibleTables,
    selectedTables,
    columnMasking,
    executeQuery: exec,
    databaseType: 'sqlite',
  });

  const server = new CaptureServer();
  registerDynamicTools({
    server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
    tables: visibleTables,
    relations,
    selectedTables,
    tableOptions,
    columnMasking,
    distinctValuesByTable,
    executeQuery: exec,
    profileName: 'test-logistique',
    databaseType: 'sqlite',
    responseMode: 'friendly',
    wrapResponse: (s) => s,
    scopeGuard: createScopeGuard([]),
  });

  console.log('=== Manifest size — profile test-logistique ===');
  console.log('');
  const headers = ['tool', 'bytes', 'tokens', '%describe', '%enum', '%rest'];
  console.log(headers.map((h, i) => h.padEnd(i === 0 ? 32 : 10)).join(' '));
  console.log('-'.repeat(80));

  let totalBytes = 0;
  let totalTokens = 0;
  const rows: Array<{ name: string; bytes: number; tokens: number; describePct: number; enumPct: number; rest: number }> = [];
  for (const t of server.tools) {
    const schema = toJSONSchema(z.object(t.inputShape) as never, { target: 'draft-7' });
    const json = JSON.stringify({ name: t.name, description: t.description, inputSchema: schema });
    const bytes = Buffer.byteLength(json, 'utf8');
    const tokens = approxTokens(json);
    const cats = categorizeBlock(json);
    rows.push({ name: t.name, bytes, tokens, ...cats });
    totalBytes += bytes;
    totalTokens += tokens;
  }
  rows.sort((a, b) => b.tokens - a.tokens);
  for (const r of rows) {
    console.log(
      r.name.padEnd(32),
      String(r.bytes).padStart(8),
      String(r.tokens).padStart(8),
      `${r.describePct}%`.padStart(9),
      `${r.enumPct}%`.padStart(9),
      `${r.rest}%`.padStart(9),
    );
  }
  console.log('-'.repeat(80));
  console.log(
    'TOTAL'.padEnd(32),
    String(totalBytes).padStart(8),
    String(totalTokens).padStart(8),
  );
  console.log('');
  console.log(`Tools registered: ${server.tools.length}`);
  console.log(`Approx tokens / tool: ${Math.round(totalTokens / Math.max(server.tools.length, 1))}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
