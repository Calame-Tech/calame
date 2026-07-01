import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getConnector } from '@calame/connectors';
import type { AppState, ConnectionState } from '../../state.js';
import type {
  TableToolOptions,
  ColumnMasking,
  ScopeSelection,
  McpRegistrationContext,
  Source,
  SourceAdapter,
  AuditLogEntry,
} from '@calame/core';
import {
  registerDynamicTools,
  registerCalcTool,
  computeDistinctValues,
  sourceAdapterRegistry,
} from '@calame/core';
import { DEFAULT_TENANT_ID } from '../../tenancy.js';
import { distinctValuesCache, distinctValuesCacheKey, getQueryTimeoutMs } from './routing.js';

// ---------------------------------------------------------------------------
// Phase 3c — adapter-driven tool registration
// ---------------------------------------------------------------------------

/** Options passed down to the adapter-driven registration helper. */
export interface RegisterAdaptersOptions {
  mcpServer: McpServer;
  profile: import('@calame/core').ServeProfile;
  state: AppState;
  profileName: string;
  /** Tenant id resolved from the MCP URL — flows into every audit entry. */
  tenantId: string;
  profileConnections: ConnectionState[];
  effectiveSelectedTables: Record<string, string[]>;
  effectiveTableOptions: Record<string, TableToolOptions> | undefined;
  effectiveColumnMasking: Record<string, Record<string, ColumnMasking>> | undefined;
  /**
   * Merged document scopes from Data Configurations (empty object on the legacy
   * no-configurations path — `profile.scopes` is the sole source in that case).
   * For each sourceId: profile.scopes wins when a document scope is already declared
   * there; otherwise the merged config scope fills the gap.
   */
  effectiveDocumentScopes: Record<string, Extract<ScopeSelection, { kind: 'document' }>>;
  scopeGuard: import('@calame/core').ScopeGuard;
  responseMode: 'friendly' | 'raw';
  wrapResponse: (json: string) => string;
  resolvedTokenLabel: string | undefined;
}

/**
 * Resolve the owning tenant of a fan-out target connection. Reads
 * `rag_sources.tenant_id`; a missing row — or a missing `rag_sources` table
 * (RAG schema not initialised, e.g. EE absent) — means the connection is
 * config-defined/legacy and belongs to the default tenant.
 */
export function lookupSourceTenant(state: AppState, sourceId: string): string {
  try {
    const row = state.db?.raw
      .prepare<
        [string],
        { tenant_id: string | null }
      >('SELECT tenant_id FROM rag_sources WHERE id = ?')
      .get(sourceId);
    return row?.tenant_id ?? DEFAULT_TENANT_ID;
  } catch {
    return DEFAULT_TENANT_ID;
  }
}

/**
 * Sanitizes a source name/id into a tool-name-safe prefix:
 * lowercase alphanumeric + underscore, max 32 chars, trailing underscore appended by caller.
 */
function sanitizeToolNamespace(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32);
}

/**
 * Resolve the human-readable display name for a source.
 * For DB connections: uses the connection label. For RAG sources: uses the rag_sources.name.
 */
function resolveSourceDisplayName(sourceId: string, state: AppState): string {
  // DB connection?
  const connState = state.connections.get(sourceId);
  if (connState) {
    return connState.connection.label ?? sourceId;
  }
  // RAG source? Read from the rag_sources SQLite table.
  if (state.ragRuntime && state.db) {
    try {
      const row = state.db.raw
        .prepare<[string], { name: string }>('SELECT name FROM rag_sources WHERE id = ? LIMIT 1')
        .get(sourceId);
      if (row) return row.name;
    } catch {
      // Defensive: if rag_sources doesn't exist yet (no migrations run), fall through.
    }
  }
  return sourceId;
}

/**
 * Resolve the SourceAdapter for a given sourceId.
 * Returns the adapter and a synthesized Source record, or null when not resolvable.
 */
function resolveAdapterForSource(
  sourceId: string,
  scope: ScopeSelection,
  state: AppState,
): { adapter: SourceAdapter; source: Source } | null {
  if (scope.kind === 'relational') {
    // DB source — look up the connection to get its databaseType
    const connState = state.connections.get(sourceId);
    if (!connState) return null;
    const adapter = sourceAdapterRegistry.get(connState.connection.databaseType);
    if (!adapter) return null;
    const source: Source = {
      id: sourceId,
      name: connState.connection.label ?? sourceId,
      type: connState.connection.databaseType,
      configEncrypted: '',
      capabilities: [...adapter.capabilities],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return { adapter, source };
  }

  if (scope.kind === 'document') {
    // RAG document source — look up the type from rag_sources
    if (!state.ragRuntime || !state.db) return null;
    let ragSourceType: string | undefined;
    try {
      const row = state.db.raw
        .prepare<[string], { type: string }>('SELECT type FROM rag_sources WHERE id = ? LIMIT 1')
        .get(sourceId);
      ragSourceType = row?.type;
    } catch {
      // Defensive: rag_sources may not exist.
      return null;
    }
    if (!ragSourceType) return null;
    const adapter = sourceAdapterRegistry.get(ragSourceType);
    if (!adapter) return null;
    const displayName = resolveSourceDisplayName(sourceId, state);
    const source: Source = {
      id: sourceId,
      name: displayName,
      type: ragSourceType,
      configEncrypted: '',
      capabilities: [...adapter.capabilities],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return { adapter, source };
  }

  return null;
}

/**
 * Build a decrypted adapter config for a source.
 * For DB sources: synthesizes a DatabaseAdapterConfig from the ConnectionState.
 * For RAG document sources: decrypts from rag_sources.config_encrypted.
 */
function resolveAdapterConfig(
  sourceId: string,
  scope: ScopeSelection,
  state: AppState,
): unknown | null {
  if (scope.kind === 'relational') {
    const connState = state.connections.get(sourceId);
    if (!connState) return null;
    return {
      connectionString: connState.connection.connectionString,
      ssl: connState.connection.sslConfig,
      ssh: connState.connection.sshConfig,
    };
  }

  if (scope.kind === 'document') {
    if (!state.ragRuntime || !state.db) return null;
    try {
      const row = state.db.raw
        .prepare<
          [string],
          { config_encrypted: string }
        >('SELECT config_encrypted FROM rag_sources WHERE id = ? LIMIT 1')
        .get(sourceId);
      if (!row) return null;
      const decrypted = state.ragRuntime.decryptConfig(row.config_encrypted);
      return JSON.parse(decrypted) as unknown;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Phase 4: Register MCP tools by iterating `profile.sources`/`profile.scopes`
 * and delegating to adapters.
 *
 * Strategy:
 *   - Relational sources: EXACT previous behavior — one call to
 *     `adapter.registerMcpTools(ctx)` per source, with namespace when
 *     multiple relational sources are present. kindCounts only counts
 *     relational sources for namespace computation.
 *   - Document sources: collected into a single array, then
 *     `registerMergedDocumentRagTools` is called ONCE for all of them.
 *     The 5 RAG tools (rag_search, rag_list_sources, …) are registered
 *     without any prefix. The optional `source` param on rag_search lets
 *     the LLM target a specific knowledge base.
 *
 * Backward compat invariant: single-DB profiles produce toolNamespace=''
 * → tool names are unchanged (e.g. `query`, not `prod_query`).
 */
export async function registerToolsViaAdapters(opts: RegisterAdaptersOptions): Promise<void> {
  const {
    mcpServer,
    profile,
    state,
    profileName,
    tenantId,
    profileConnections,
    effectiveSelectedTables,
    effectiveTableOptions,
    effectiveColumnMasking,
    effectiveDocumentScopes,
    scopeGuard,
    responseMode,
    wrapResponse,
    resolvedTokenLabel,
  } = opts;

  // Build the effective scopes map:
  //   - Start from profile.scopes (which carries relational scopes plus any
  //     legacy profile-level document scopes still hanging around).
  //   - For document-kind sources the linked Configuration is now the single
  //     source of truth (the Knowledge tab moved from MCP detail to the data
  //     Configuration). When a Configuration declares a document scope for a
  //     sourceId we OVERRIDE any pre-existing profile.scopes entry for that
  //     same id — otherwise stale legacy profile entries (e.g. an old
  //     `piiMaskingMode` setting written from the removed MCP-detail Knowledge
  //     tab) would silently win over the user's current data-profile config.
  //   - Relational scopes still come exclusively from profile.scopes — they
  //     are not part of `effectiveDocumentScopes` so the override is a no-op
  //     for relational ids.
  const profileScopes = profile.scopes ?? {};
  const mergedScopes: Record<string, ScopeSelection> = { ...profileScopes };
  for (const [sourceId, docScope] of Object.entries(effectiveDocumentScopes)) {
    mergedScopes[sourceId] = docScope;
  }

  const rawSources = profile.sources
    ? [
        ...profile.sources,
        // Add any config-only document sourceIds that the profile did not explicitly declare.
        ...Object.keys(effectiveDocumentScopes).filter((id) => !profile.sources!.includes(id)),
      ]
    : Object.keys(mergedScopes);

  // Resolve sourceIds against the live runtime. The migrator may have
  // synthesised placeholder ids (e.g. 'default') for legacy profiles whose
  // `connections` field was empty — those placeholders won't match
  // `state.connections` keys when the actual connection has a different name.
  // Mirror the legacy fallback: when a relational sourceId doesn't match any
  // live connection, fan the scope out to every available DB connection.
  // Document scopes are left as-is.
  const resolvedPairs: Array<{ sourceId: string; scope: ScopeSelection }> = [];
  for (const sourceId of rawSources) {
    const scope = mergedScopes[sourceId];
    if (!scope) continue;
    if (scope.kind === 'relational' && !state.connections.has(sourceId)) {
      const liveConnIds = [...state.connections.keys()];
      if (liveConnIds.length === 0) {
        state.logger?.warn(
          `Relational source "${sourceId}" has no matching live connection — skipping`,
          { component: `mcp/${profileName}` },
        );
        continue;
      }
      for (const realId of liveConnIds) {
        // Security: filter fan-out to only connections belonging to this tenant.
        // Tenant ownership lives in `rag_sources` (the unified-sources table); a
        // connection without a row there (or with a null tenant_id) is a
        // config-defined / legacy connection: treat it as the default tenant
        // so single-tenant fan-out keeps working, while a row owned by a *different*
        // tenant is still blocked. The rag_* schema only exists once the EE RAG
        // runtime has initialised it — a missing table means no tenant-scoped
        // sources exist at all, so it degrades to the same default.
        const connTenant = lookupSourceTenant(state, realId);
        if (connTenant !== tenantId) {
          state.logger?.warn(
            `Fan-out: connection "${realId}" (tenant="${connTenant}") does not match profile tenant "${tenantId}" — skipping`,
            { component: `mcp/${profileName}` },
          );
          continue;
        }
        resolvedPairs.push({ sourceId: realId, scope });
      }
    } else {
      resolvedPairs.push({ sourceId, scope });
    }
  }

  // Split resolved pairs into relational and document buckets.
  const relationalPairs = resolvedPairs.filter((p) => p.scope.kind === 'relational');
  const documentPairs = resolvedPairs.filter((p) => p.scope.kind === 'document');

  // Count active RELATIONAL sources only — document sources are no longer
  // namespaced (merged into a single tool set), so their count must not
  // influence the relational namespace computation.
  const relationalKindCount = relationalPairs.length;

  let anyRegistered = false;

  // Shared audit body used by both relational and document registrations.
  // Two typed wrappers below satisfy the different onAuditLog signatures:
  //   - registerCalcTool / registerDynamicTools: Omit<AuditLogEntry, 'id'|'timestamp'>
  //   - McpRegistrationContext.onAuditLog: full AuditLogEntry
  // Both map to the same addEntry call; only the declared parameter type differs.
  const addAuditEntry = (entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): void => {
    if (state.auditLog) {
      state.auditLog.addEntry({ ...entry, tokenLabel: resolvedTokenLabel, tenantId });
      state.auditLog.save().catch(() => {});
    }
  };
  /** onAuditLog for registerCalcTool / registerDynamicTools. */
  const onAuditLogPartial: (entry: Omit<AuditLogEntry, 'id' | 'timestamp'>) => void = addAuditEntry;
  /** onAuditLog for McpRegistrationContext (full AuditLogEntry including id/timestamp). */
  const onAuditLog: (entry: AuditLogEntry) => void = (entry) => addAuditEntry(entry);

  // Register calc once globally — it is not source-specific, so it must not
  // participate in per-source namespacing. Calling it here (before the loop)
  // guarantees exactly one registration even when multiple relational sources
  // are wired into the same profile.
  registerCalcTool(mcpServer, profileName, (s) => s, onAuditLogPartial);

  // ---------------------------------------------------------------------------
  // Relational sources — EXACT previous behavior, one call per source.
  // ---------------------------------------------------------------------------
  for (const { sourceId, scope } of relationalPairs) {
    const resolved = resolveAdapterForSource(sourceId, scope, state);
    if (!resolved) {
      state.logger?.warn(`No adapter found for relational source "${sourceId}" — skipping`, {
        component: `mcp/${profileName}`,
      });
      continue;
    }

    const { adapter, source } = resolved;

    // Compute toolNamespace: empty when only one relational source, prefixed otherwise.
    const toolNamespace = relationalKindCount >= 2 ? sanitizeToolNamespace(source.name) + '_' : '';

    // Build the adapter config.
    const config = resolveAdapterConfig(sourceId, scope, state);
    if (config === null) {
      state.logger?.warn(
        `Could not resolve config for relational source "${sourceId}" — skipping`,
        { component: `mcp/${profileName}` },
      );
      continue;
    }

    const connState = state.connections.get(sourceId);
    // Apply user-level table restrictions to the scope selection before passing in.
    // effectiveSelectedTables has already been narrowed by the user restrictions block above.
    const narrowedScope: ScopeSelection = {
      kind: 'relational',
      selectedTables: effectiveSelectedTables,
      tableOptions: effectiveTableOptions,
      columnMasking: effectiveColumnMasking,
    };
    const schema: import('@calame/core').SourceSchema = {
      kind: 'relational',
      tables: connState?.schema.tables ?? [],
      relations: profileConnections.flatMap((cs) => cs.schema.relations ?? []),
    };

    const connector = connState ? getConnector(connState.connection.databaseType) : undefined;
    const connectionString = connState?.connection.connectionString ?? '';
    const sslConfig = connState?.connection.sslConfig;

    // Distinct-values cache for relational sources (same pattern as legacy path).
    let distinctValuesByTable: Record<string, Record<string, unknown[]>> | undefined;
    if (connState && connector) {
      const relScope = narrowedScope as Extract<ScopeSelection, { kind: 'relational' }>;
      const distinctCacheKey = distinctValuesCacheKey(
        profileName,
        connectionString,
        relScope.selectedTables,
        relScope.columnMasking,
      );
      let cached = distinctValuesCache.get(distinctCacheKey);
      if (!cached) {
        cached = await computeDistinctValues({
          tables: connState.schema.tables,
          selectedTables: relScope.selectedTables,
          columnMasking: relScope.columnMasking,
          executeQuery: async (sql: string, params: unknown[]) => {
            const result = await connector.query(connectionString, sql, {
              timeoutMs: getQueryTimeoutMs(),
              ssl: sslConfig,
              params,
            });
            return {
              rows: result.rows as Record<string, unknown>[],
              fields: Object.keys(result.rows[0] ?? {}).map((name) => ({ name })),
            };
          },
          databaseType: connState.connection.databaseType,
          perQueryTimeoutMs: 2000,
        });
        distinctValuesCache.set(distinctCacheKey, cached);
      }
      distinctValuesByTable = cached;
    }

    const ctx: McpRegistrationContext = {
      server: mcpServer,
      source,
      config,
      schema,
      selection: narrowedScope,
      profileName,
      toolNamespace,
      responseMode,
      onAuditLog,
      scopeGuard,
      executeQuery: connector
        ? async (sql: string, params?: ReadonlyArray<unknown>) => {
            const result = await connector.query(connectionString, sql, {
              timeoutMs: getQueryTimeoutMs(),
              ssl: sslConfig,
              params: params ? [...params] : [],
            });
            return {
              rows: result.rows as Record<string, unknown>[],
              fields: Object.keys(result.rows[0] ?? {}).map((name) => ({ name })),
            };
          }
        : undefined,
    };

    // Inject wrapResponse / maxOffset / distinctValuesByTable for the DB adapter.
    (
      ctx as McpRegistrationContext & {
        wrapResponse?: (json: string) => string;
        maxOffset?: number;
        distinctValuesByTable?: Record<string, Record<string, unknown[]>>;
      }
    ).wrapResponse = wrapResponse;
    (
      ctx as McpRegistrationContext & {
        wrapResponse?: (json: string) => string;
        maxOffset?: number;
        distinctValuesByTable?: Record<string, Record<string, unknown[]>>;
      }
    ).maxOffset = 10000;
    if (distinctValuesByTable) {
      (
        ctx as McpRegistrationContext & {
          wrapResponse?: (json: string) => string;
          maxOffset?: number;
          distinctValuesByTable?: Record<string, Record<string, unknown[]>>;
        }
      ).distinctValuesByTable = distinctValuesByTable;
    }

    try {
      adapter.registerMcpTools?.(ctx);
      anyRegistered = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      state.logger?.warn(`registerMcpTools failed for relational source "${sourceId}": ${msg}`, {
        component: `mcp/${profileName}`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Document sources — one call to registerMergedDocumentRagTools for ALL.
  // ---------------------------------------------------------------------------
  if (documentPairs.length > 0) {
    const ragRuntime = state.ragRuntime;
    if (!ragRuntime) {
      state.logger?.warn(
        `Document sources present but RAG runtime is not initialized — skipping document tool registration`,
        { component: `mcp/${profileName}` },
      );
    } else {
      // Collect all document sources into the MergedSourceEntry array.
      type MergedSourceEntry = import('@calame-ee/rag-core').MergedSourceEntry;
      const mergedSources: MergedSourceEntry[] = [];

      for (const { sourceId, scope } of documentPairs) {
        // Cross-tenant isolation guard: verify that the RAG source actually
        // belongs to the tenant resolved from the MCP URL before handing it
        // to registerMergedDocumentRagTools. A mis-attributed source ID (e.g.
        // a config that references a source owned by a different tenant) is
        // silently excluded here — it can never leak data because it never
        // reaches the RAG runtime. In normal operation every source passes.
        if (state.db) {
          let sourceTenantId: string | undefined;
          try {
            const row = state.db.raw
              .prepare<
                [string],
                { tenant_id: string }
              >('SELECT tenant_id FROM rag_sources WHERE id = ?')
              .get(sourceId);
            sourceTenantId = row?.tenant_id;
          } catch {
            // Defensive: if rag_sources doesn't exist yet (no migration run),
            // fall through and let resolveAdapterForSource handle it.
          }
          if (sourceTenantId !== undefined && sourceTenantId !== tenantId) {
            state.logger?.warn(
              `Document source "${sourceId}" belongs to tenant "${sourceTenantId}" but request is for tenant "${tenantId}" — excluding from tool registration`,
              { component: `mcp/${profileName}` },
            );
            continue;
          }
        }

        const resolved = resolveAdapterForSource(sourceId, scope, state);
        if (!resolved) {
          state.logger?.warn(`No adapter found for document source "${sourceId}" — skipping`, {
            component: `mcp/${profileName}`,
          });
          continue;
        }

        const config = resolveAdapterConfig(sourceId, scope, state);
        if (config === null) {
          state.logger?.warn(
            `Could not resolve config for document source "${sourceId}" — skipping`,
            { component: `mcp/${profileName}` },
          );
          continue;
        }

        mergedSources.push({
          source: resolved.source,
          selection: scope as Extract<ScopeSelection, { kind: 'document' }>,
          config,
        });
      }

      if (mergedSources.length > 0) {
        try {
          ragRuntime.ragCore.registerMergedDocumentRagTools({
            server: mcpServer,
            deps: ragRuntime.documentAdapterDeps,
            tenantId,
            sources: mergedSources,
            profileName,
            responseMode,
            onAuditLog,
          });
          anyRegistered = true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          state.logger?.warn(`registerMergedDocumentRagTools failed: ${msg}`, {
            component: `mcp/${profileName}`,
          });
        }
      }
    }
  }

  // If no adapter registered anything (e.g. all sources had no matched adapter),
  // fall back to registering an empty relational tool set on the first available
  // connection so the MCP server always has a tools/list handler (avoids -32601).
  if (!anyRegistered && profileConnections.length > 0) {
    const fallbackConn = profileConnections[0];
    const connector = getConnector(fallbackConn.connection.databaseType);
    const connectionString = fallbackConn.connection.connectionString;
    const sslConfig = fallbackConn.connection.sslConfig;

    registerDynamicTools({
      server: mcpServer,
      tables: [],
      relations: [],
      selectedTables: {},
      tableOptions: effectiveTableOptions,
      columnMasking: effectiveColumnMasking,
      executeQuery: async (sql: string, params: unknown[]) => {
        const result = await connector.query(connectionString, sql, {
          timeoutMs: getQueryTimeoutMs(),
          ssl: sslConfig,
          params,
        });
        return {
          rows: result.rows as Record<string, unknown>[],
          fields: Object.keys(result.rows[0] ?? {}).map((name) => ({ name })),
        };
      },
      onAuditLog: onAuditLogPartial,
      profileName,
      databaseType: fallbackConn.connection.databaseType,
      responseMode,
      wrapResponse,
      maxOffset: 10000,
      scopeGuard,
    });
  }
}
