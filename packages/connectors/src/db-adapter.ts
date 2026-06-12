import { z } from 'zod';
import { registerDynamicTools } from '@calame/core';
import type {
  SourceAdapter,
  SourceSchema,
  ScopeSelection,
  McpRegistrationContext,
  TableInfo,
  Relation,
  AuditLogEntry,
} from '@calame/core';
import type { DatabaseConnector, DatabaseType, SslConfig, ConnectionOptions } from './types.js';
import { PostgreSQLConnector } from './postgresql.js';
import { MySQLConnector } from './mysql.js';
import { SQLiteConnector } from './sqlite.js';

// Local connector map — mirrors index.ts registry but kept separate to avoid
// a circular import (index.ts imports db-adapter.ts, so db-adapter.ts cannot
// import from index.ts without introducing a cycle).
const connectors: Record<DatabaseType, DatabaseConnector> = {
  postgresql: new PostgreSQLConnector(),
  mysql: new MySQLConnector(),
  sqlite: new SQLiteConnector(),
};

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

export interface DatabaseAdapterConfig {
  connectionString: string;
  ssl?: SslConfig;
  // SSH tunnel metadata is opaque at this layer — the CLI routes resolve it
  // before the adapter is called.
  ssh?: unknown;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const sslConfigSchema = z.object({
  enabled: z.boolean(),
  ca: z.string().optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
  rejectUnauthorized: z.boolean().optional(),
});

const configSchema = z.object({
  connectionString: z.string().min(1),
  ssl: sslConfigSchema.optional(),
  ssh: z.unknown().optional(),
});

// Phase 1: tableOptions and columnMasking are validated loosely; Phase 3 will
// tighten these to the full TableToolOptions and ColumnMasking Zod shapes.
const scopeSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('relational'),
    selectedTables: z.record(z.string(), z.array(z.string())),
    tableOptions: z.record(z.string(), z.unknown()).optional(),
    columnMasking: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  }),
  z.object({
    kind: z.literal('document'),
    mode: z.enum(['allowAll', 'allowList']),
    allowedFolders: z.array(z.string()),
    allowedDocuments: z.array(z.string()),
  }),
]) as z.ZodType<ScopeSelection>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type RelationalSchema = Extract<SourceSchema, { kind: 'relational' }>;

type DbCaps = 'introspect' | 'query' | 'enumerate' | 'sample';

/**
 * Builds a SourceAdapter that delegates to the existing DatabaseConnector for
 * a given database type. The adapter itself does not execute queries — query
 * execution is host-injected via McpRegistrationContext.executeQuery (relational
 * adapters require this from the host, per the §1.4 contract in the design plan).
 */
export function buildDatabaseSourceAdapter(
  type: DatabaseType,
  displayName: string,
): SourceAdapter<DatabaseAdapterConfig, RelationalSchema, DbCaps> {
  return {
    type,
    displayName,
    capabilities: ['introspect', 'query', 'enumerate', 'sample'] as const,
    configSchema,
    scopeSelectionSchema,

    async testConnection(config: DatabaseAdapterConfig): Promise<void> {
      const options = buildConnectionOptions(config);
      await connectors[type].testConnection(config.connectionString, options);
    },

    async introspect(
      config: DatabaseAdapterConfig,
      _sourceId: string,
    ): Promise<RelationalSchema> {
      const options = buildConnectionOptions(config);
      const schema = await connectors[type].introspect(config.connectionString, options);
      return { kind: 'relational', tables: schema.tables, relations: schema.relations };
    },

    // `query` is intentionally absent. The DatabaseConnector.query() method
    // already enforces read-only transactions at the driver level. Query
    // execution for MCP tools is host-injected via ctx.executeQuery — see
    // registerMcpTools below. Declaring 'query' in capabilities signals that
    // this adapter supports querying; the actual execution path is resolved
    // by the host caller (serve.ts) and injected through the context.

    async listScopes(
      config: DatabaseAdapterConfig,
      sourceId: string,
    ): Promise<ReadonlyArray<{ id: string; name: string; tableCount: number }>> {
      const schema = await this.introspect!(config, sourceId);
      const bySchema = new Map<string, number>();
      for (const table of schema.tables) {
        bySchema.set(table.schema, (bySchema.get(table.schema) ?? 0) + 1);
      }
      return Array.from(bySchema.entries()).map(([name, tableCount]) => ({
        id: name,
        name,
        tableCount,
      }));
    },

    async listItems(
      config: DatabaseAdapterConfig,
      sourceId: string,
      scope?: string,
    ): Promise<ReadonlyArray<{ id: string; name: string; type?: string }>> {
      const schema = await this.introspect!(config, sourceId);
      if (scope === undefined) {
        return schema.tables.map((t) => ({ id: `${t.schema}.${t.name}`, name: t.name }));
      }
      const table = schema.tables.find((t) => t.name === scope || t.schema === scope);
      if (!table) return [];
      return table.columns.map((c) => ({ id: c.name, name: c.name, type: c.type }));
    },

    async sampleValues(
      config: DatabaseAdapterConfig,
      _sourceId: string,
      scope: string,
      item: string,
      limit?: number,
    ): Promise<ReadonlyArray<unknown>> {
      const options = buildConnectionOptions(config);
      return connectors[type].sampleColumnValues(
        config.connectionString,
        scope,
        item,
        limit,
        options,
      );
    },

    registerMcpTools(
      ctx: McpRegistrationContext<DatabaseAdapterConfig, RelationalSchema>,
    ): void {
      if (ctx.selection.kind !== 'relational') {
        throw new Error(
          `DatabaseSourceAdapter(${type}): expected relational selection, got '${ctx.selection.kind}'`,
        );
      }

      const { selectedTables, tableOptions, columnMasking } = ctx.selection;

      // DynamicToolsOptions.onAuditLog receives entries without id/timestamp
      // (the tool internals add those fields before calling the host callback).
      // McpRegistrationContext.onAuditLog receives complete AuditLogEntry objects.
      // The wrapper satisfies the narrower type expected by registerDynamicTools
      // while forwarding the full entry to the host.
      const onAuditLog = (entry: Omit<AuditLogEntry, 'id' | 'timestamp'>) =>
        ctx.onAuditLog(entry as AuditLogEntry);

      registerDynamicTools({
        server: ctx.server,
        tables: ctx.schema.tables as TableInfo[],
        relations: ctx.schema.relations as Relation[],
        selectedTables,
        tableOptions,
        columnMasking,
        // Cast: McpRegistrationContext.executeQuery returns Promise<unknown> while
        // DynamicToolsOptions.executeQuery returns the typed query result. The host
        // (serve.ts) always provides a function that returns the full result shape;
        // the looser McpRegistrationContext type is intentional for adapter generality.
        executeQuery: ctx.executeQuery! as (
          sql: string,
          params: unknown[],
        ) => Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }>,
        scopeGuard: ctx.scopeGuard,
        profileName: ctx.profileName,
        onAuditLog,
        responseMode: ctx.responseMode,
        databaseType: type,
        toolNamespace: ctx.toolNamespace,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildConnectionOptions(config: DatabaseAdapterConfig): ConnectionOptions {
  return config.ssl ? { ssl: config.ssl } : {};
}
