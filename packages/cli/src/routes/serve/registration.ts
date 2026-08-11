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
import { createOnWriteRequest } from './write-wiring.js';
import { lookupLiveRagSource } from '../../rag-source-lookup.js';

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
 * Resolve the SourceAdapter + synthesized Source + decrypted config for a
 * RELATIONAL source. Returns null when the connection is not live or has no
 * registered adapter.
 */
function resolveRelationalSource(
  sourceId: string,
  state: AppState,
): { adapter: SourceAdapter; source: Source; config: unknown } | null {
  const connState = state.connections.get(sourceId);
  if (!connState) return null;
  const adapter = sourceAdapterRegistry.get(connState.connection.databaseType);
  if (!adapter) return null;
  const now = new Date().toISOString();
  return {
    adapter,
    source: {
      id: sourceId,
      name: connState.connection.label ?? sourceId,
      type: connState.connection.databaseType,
      configEncrypted: '',
      capabilities: [...adapter.capabilities],
      createdAt: now,
      updatedAt: now,
    },
    config: {
      connectionString: connState.connection.connectionString,
      ssl: connState.connection.sslConfig,
      ssh: connState.connection.sshConfig,
    },
  };
}

/**
 * Resolve the SourceAdapter + synthesized Source + decrypted config for a
 * NON-relational source (`kind: 'document'` and `kind: 'mcp'` alike).
 *
 * Both kinds share one storage path — `rag_sources`, the only unified-sources
 * table in the codebase (see `source-lookup.ts`) — so they share one resolver
 * here too. Merging them is what makes the tenant + soft-delete filters
 * impossible to forget for a new kind: everything non-relational goes through
 * `lookupLiveRagSource`, which binds `tenant_id = ?` and `deleted_at IS NULL`.
 *
 * Failure is reported as a human-readable `reason` so the calling loop can
 * warn precisely (a cross-tenant reference is not the same event as a missing
 * adapter) without re-querying the table.
 */
function resolveRagSourceForTenant(
  sourceId: string,
  state: AppState,
  tenantId: string,
):
  | { ok: true; adapter: SourceAdapter; source: Source; config: unknown }
  | { ok: false; reason: string } {
  if (!state.ragRuntime || !state.db) {
    return { ok: false, reason: 'cannot be resolved — the RAG runtime is not initialized' };
  }

  const lookup = lookupLiveRagSource(state.db, sourceId, tenantId);
  if (lookup.status === 'foreign') {
    return {
      ok: false,
      reason: `belongs to tenant "${lookup.tenantId}" but the request is for tenant "${tenantId}" — excluding from tool registration`,
    };
  }
  if (lookup.status === 'deleted') {
    return { ok: false, reason: 'has been deleted — excluding from tool registration' };
  }
  if (lookup.status === 'missing') {
    return { ok: false, reason: 'was not found in rag_sources' };
  }

  const live = lookup.source;
  const adapter = sourceAdapterRegistry.get(live.type);
  if (!adapter) {
    return { ok: false, reason: `has no registered adapter for type "${live.type}"` };
  }

  let config: unknown;
  try {
    config = JSON.parse(state.ragRuntime.decryptConfig(live.configEncrypted)) as unknown;
  } catch {
    return { ok: false, reason: 'has an unreadable configuration' };
  }

  const now = new Date().toISOString();
  return {
    ok: true,
    adapter,
    source: {
      id: sourceId,
      name: live.name,
      type: live.type,
      configEncrypted: '',
      capabilities: [...adapter.capabilities],
      createdAt: now,
      updatedAt: now,
    },
    config,
  };
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

  // Split resolved pairs into relational, document, and MCP-proxy buckets.
  const relationalPairs = resolvedPairs.filter((p) => p.scope.kind === 'relational');
  const documentPairs = resolvedPairs.filter((p) => p.scope.kind === 'document');
  const mcpPairs = resolvedPairs.filter((p) => p.scope.kind === 'mcp');

  // Count active RELATIONAL sources only — document sources are no longer
  // namespaced (merged into a single tool set), so their count must not
  // influence the relational namespace computation.
  const relationalKindCount = relationalPairs.length;
  // MCP proxy sources are namespaced per-source like relational ones (each
  // upstream server exposes its own distinctly-named tools, unlike document
  // sources which share one generic merged RAG tool set).
  const mcpKindCount = mcpPairs.length;

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
  // `scope` is intentionally unused here: the effective relational selection is
  // rebuilt below from `effectiveSelectedTables` (already narrowed by the
  // user-restriction block upstream), not from the raw profile scope.
  for (const { sourceId } of relationalPairs) {
    const resolved = resolveRelationalSource(sourceId, state);
    if (!resolved) {
      state.logger?.warn(`No adapter found for relational source "${sourceId}" — skipping`, {
        component: `mcp/${profileName}`,
      });
      continue;
    }

    const { adapter, source, config } = resolved;

    // Compute toolNamespace: empty when only one relational source, prefixed otherwise.
    const toolNamespace = relationalKindCount >= 2 ? sanitizeToolNamespace(source.name) + '_' : '';

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
      onWriteRequest: createOnWriteRequest(
        state,
        tenantId,
        connState
          ? {
              connectionName: connState.connection.name,
              databaseType: connState.connection.databaseType,
            }
          : undefined,
      ),
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
        // Cross-tenant isolation + soft-delete guard, applied inside
        // `resolveRagSourceForTenant`: a source owned by another tenant (e.g.
        // a config that references a foreign source id) or one that has been
        // soft-deleted is excluded here with a warn — it never reaches the RAG
        // runtime, so it can never leak data. In normal operation every source
        // passes.
        const resolved = resolveRagSourceForTenant(sourceId, state, tenantId);
        if (!resolved.ok) {
          state.logger?.warn(`Document source "${sourceId}" ${resolved.reason} — skipping`, {
            component: `mcp/${profileName}`,
          });
          continue;
        }

        mergedSources.push({
          source: resolved.source,
          selection: scope as Extract<ScopeSelection, { kind: 'document' }>,
          config: resolved.config,
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

  // ---------------------------------------------------------------------------
  // MCP proxy sources (Slice 0, read-only) — one call to registerMcpTools per
  // source, same per-source pattern as relational (each upstream MCP server
  // exposes its own distinctly-named tools, so — unlike document sources —
  // there is no shared/generic tool surface to merge into).
  //
  // Slice 0 snapshots the upstream tool list live via `adapter.introspect`
  // at registration time rather than from a persisted schema cache: there is
  // no schema-storage column for non-relational sources yet (that would be a
  // migration, out of scope for Slice 0 — see spec §8b "Schema staleness").
  // A failure to reach the upstream at this point (unreachable server,
  // timeout) skips the source gracefully rather than failing the whole MCP
  // session, mirroring the adapter-lookup/config-resolution failure handling
  // used for relational/document sources above.
  // ---------------------------------------------------------------------------
  for (const { sourceId, scope } of mcpPairs) {
    // Identical guard to the document loop above — same helper, so an MCP
    // source owned by another tenant (or soft-deleted) is excluded BEFORE its
    // credentials are ever decrypted or its upstream ever contacted.
    const resolved = resolveRagSourceForTenant(sourceId, state, tenantId);
    if (!resolved.ok) {
      state.logger?.warn(`MCP source "${sourceId}" ${resolved.reason} — skipping`, {
        component: `mcp/${profileName}`,
      });
      continue;
    }
    const { adapter, source, config } = resolved;

    const toolNamespace = mcpKindCount >= 2 ? sanitizeToolNamespace(source.name) + '_' : '';

    let schema: import('@calame/core').SourceSchema;
    try {
      const introspected = await adapter.introspect?.(config, sourceId);
      if (!introspected) {
        state.logger?.warn(
          `MCP source "${sourceId}" adapter does not support introspect — skipping`,
          {
            component: `mcp/${profileName}`,
          },
        );
        continue;
      }
      schema = introspected;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      state.logger?.warn(`Failed to introspect MCP source "${sourceId}": ${msg} — skipping`, {
        component: `mcp/${profileName}`,
      });
      continue;
    }

    const ctx: McpRegistrationContext = {
      server: mcpServer,
      source,
      config,
      schema,
      selection: scope,
      profileName,
      toolNamespace,
      responseMode,
      onAuditLog,
      // Slice 1 (MCP write-approval): wires the approval gate for write-
      // classified upstream tools (e.g. `add_memory`) — same
      // `createOnWriteRequest` helper the relational path uses. No
      // connectionName/databaseType here: those are SQL-specific compat
      // fields and an mcp-tool action carries its own `sourceId` reference
      // instead (see PendingWriteAction in @calame/core).
      onWriteRequest: createOnWriteRequest(state, tenantId),
    };

    try {
      adapter.registerMcpTools?.(ctx);
      anyRegistered = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      state.logger?.warn(`registerMcpTools failed for MCP source "${sourceId}": ${msg}`, {
        component: `mcp/${profileName}`,
      });
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
      onWriteRequest: createOnWriteRequest(state, tenantId, {
        connectionName: fallbackConn.connection.name,
        databaseType: fallbackConn.connection.databaseType,
      }),
    });
  }
}
