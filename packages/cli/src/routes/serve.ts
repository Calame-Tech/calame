import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getConnector } from '@calame/connectors';
import type { AppState, ConnectionState } from '../state.js';
import type {
  TableToolOptions,
  ColumnMasking,
  UserIdentity,
  ScopeSelection,
  McpRegistrationContext,
  Source,
  SourceAdapter,
  AuditLogEntry,
} from '@calame/core';
import {
  registerDynamicTools,
  resolveUserScope,
  createScopeGuard,
  computeDistinctValues,
  upgradeProfileShape,
  sourceAdapterRegistry,
} from '@calame/core';
import { readConfigurationsFile } from './configurations.js';
import { INTERNAL_CHAT_SECRET } from '../chat-engine.js';

// Distinct-values cache. Keyed by `profile|connection|selectedTables-hash|masking-hash`.
// Built lazily on first MCP request per (profile, config) tuple; reused across
// requests so we don't run ~50 SELECT DISTINCT queries on every tools/list call.
// Flushed when the user reconfigures (the cache key encodes the relevant inputs).
const distinctValuesCache = new Map<string, Record<string, Record<string, unknown[]>>>();

function distinctValuesCacheKey(
  profileName: string,
  connectionString: string,
  selectedTables: Record<string, string[]>,
  columnMasking: Record<string, Record<string, ColumnMasking>> | undefined,
): string {
  // Stable JSON: sort keys at the top level.
  const stTable = Object.keys(selectedTables).sort()
    .map((k) => `${k}:${[...selectedTables[k]].sort().join(',')}`)
    .join(';');
  const cmTable = columnMasking
    ? Object.keys(columnMasking).sort()
        .map((k) => `${k}:${JSON.stringify(columnMasking[k])}`)
        .join(';')
    : '';
  return `${profileName}|${connectionString}|${stTable}|${cmTable}`;
}

/** Masking mode restrictiveness order (lower index = less restrictive). */
const MASKING_ORDER: readonly string[] = [
  'none',
  'aggregate_only',
  'replace',
  'truncate',
  'hash',
  'exclude',
];

/**
 * Merge multiple configurations into a single effective configuration.
 * Union permissive strategy: all tools enabled by any config are enabled,
 * max limits are taken, columns are unioned, least restrictive masking wins.
 *
 * Phase 2 decision: mergeConfigurations remains legacy-only (operates on
 * `connections`/`selectedTables`/`tableOptions`/`columnMasking`). The inputs
 * returned by `readConfigurationsFile` already carry both legacy and new shapes
 * (via `upgradeConfigurationShape`), so the legacy reads here are still valid.
 * Phase 3 will replace this function with a new-shape merge that iterates
 * `scopes` per source kind via the adapter registry.
 */
export function mergeConfigurations(
  configs: Array<{
    connections: string[];
    selectedTables: Record<string, string[]>;
    tableOptions?: Record<string, TableToolOptions>;
    columnMasking?: Record<string, Record<string, ColumnMasking>>;
  }>,
): {
  connections: string[];
  selectedTables: Record<string, string[]>;
  tableOptions: Record<string, TableToolOptions>;
  columnMasking: Record<string, Record<string, ColumnMasking>>;
} {
  const connectionsSet = new Set<string>();
  const selectedTables: Record<string, string[]> = {};
  const tableOptions: Record<string, TableToolOptions> = {};
  const columnMasking: Record<string, Record<string, ColumnMasking>> = {};

  for (const config of configs) {
    for (const c of config.connections) connectionsSet.add(c);

    // Union of tables and columns
    for (const [table, cols] of Object.entries(config.selectedTables)) {
      if (!selectedTables[table]) {
        selectedTables[table] = [...cols];
      } else {
        const existing = new Set(selectedTables[table]);
        for (const col of cols) existing.add(col);
        selectedTables[table] = [...existing];
      }
    }

    // Union permissive for tableOptions
    for (const [table, rawOpts] of Object.entries(config.tableOptions ?? {})) {
      const opts = rawOpts as Partial<TableToolOptions>;
      if (!tableOptions[table]) {
        tableOptions[table] = {
          enabledTools: opts.enabledTools ?? ['describe', 'aggregate', 'query'],
          maxLimit: opts.maxLimit ?? 200,
          filterableColumns: opts.filterableColumns ?? [],
          groupableColumns: opts.groupableColumns ?? [],
        };
      } else {
        const existing = tableOptions[table];
        // Union of enabledTools
        const toolsSet = new Set([...existing.enabledTools, ...(opts.enabledTools ?? [])]);
        existing.enabledTools = [...toolsSet] as TableToolOptions['enabledTools'];
        // Max of maxLimit
        existing.maxLimit = Math.max(existing.maxLimit, opts.maxLimit ?? 200);
        // Union of filterableColumns
        const filterSet = new Set([...(existing.filterableColumns ?? []), ...(opts.filterableColumns ?? [])]);
        existing.filterableColumns = [...filterSet];
        // Union of groupableColumns
        const groupSet = new Set([...(existing.groupableColumns ?? []), ...(opts.groupableColumns ?? [])]);
        existing.groupableColumns = [...groupSet];
      }
    }

    // Least restrictive masking wins
    for (const [table, colMasking] of Object.entries(config.columnMasking ?? {})) {
      if (!columnMasking[table]) {
        columnMasking[table] = { ...colMasking };
      } else {
        for (const [col, masking] of Object.entries(colMasking)) {
          if (!columnMasking[table][col]) {
            columnMasking[table][col] = masking;
          } else {
            // Keep the least restrictive masking mode
            const currentIdx = MASKING_ORDER.indexOf(columnMasking[table][col].maskingMode);
            const newIdx = MASKING_ORDER.indexOf(masking.maskingMode);
            if (newIdx < currentIdx) {
              columnMasking[table][col] = masking;
            }
          }
        }
      }
    }
  }

  return {
    connections: [...connectionsSet],
    selectedTables,
    tableOptions,
    columnMasking,
  };
}

export function registerServeRoute(app: Express, state: AppState): void {

  // MCP Streamable HTTP endpoint per profile
  app.post('/mcp/:profileName', async (req: Request, res: Response) => {
    const profileName = req.params.profileName as string;

    try {
      // --- Resolve the profile early to determine auth mode ---
      // NOTE: We read the profile before the full active-profile check so that open/oauth
      // mode profiles can return meaningful errors rather than a generic 503.
      const earlyProfile = state.serveProfiles[profileName];
      const authMode = earlyProfile?.authMode ?? 'token';

      // Variables populated by whichever auth branch runs
      let userAllowedTables: string[] | null = null;
      let userAllowedTools: string[] | null = null;
      /** Identifier used for rate-limit tracking (user ID or token ID). */
      let rateLimitId: string | undefined;
      /** Per-user rate limit (rpm). Falls back to global config when undefined. */
      let rateLimitRpm: number | undefined;
      /** Resolved user identity for data scoping. Null for admin/legacy/open auth. */
      let userIdentity: UserIdentity | null = null;
      /** Label of the legacy token used for this request, if any. */
      let resolvedTokenLabel: string | undefined;

      if (authMode === 'open') {
        // No authentication required — proceed immediately.
      } else if (authMode === 'external') {
        // Accept bearer tokens and validate against an external API.
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
          res.status(401).json({ success: false, message: 'Bearer token required for external authentication.' });
          return;
        }
        const externalToken = authHeader.slice(7);

        if (earlyProfile?.externalAuthConfig) {
          const { validateExternalToken } = await import('../external-auth.js');
          const result = await validateExternalToken(externalToken, earlyProfile.externalAuthConfig);
          if (!result.valid) {
            res.status(401).json({ success: false, message: 'External token validation failed.' });
            return;
          }
          // Build userIdentity from external auth response for data scoping
          const extEmail = result.email ?? '';
          userIdentity = {
            email: extEmail,
            userId: extEmail || 'external',
            externalId: undefined,
            customAttributes: undefined,
          };
          // If UserManager exists, try to find or auto-create user for per-user restrictions
          const userManager = state.userManager;
          if (userManager && extEmail) {
            const existingUser = userManager.getUserByEmail(extEmail);
            if (existingUser) {
              const profileAccess = userManager.getUserProfileAccess(existingUser, profileName);
              if (profileAccess) {
                userAllowedTables = profileAccess.allowedTables;
                userAllowedTools = profileAccess.allowedTools;
              }
              userIdentity = {
                email: existingUser.email,
                userId: existingUser.id,
                externalId: existingUser.oidcSubject ?? undefined,
                customAttributes: existingUser.customAttributes ?? undefined,
              };
              rateLimitId = existingUser.id;
            }
          }
        } else {
          res.status(500).json({ success: false, message: 'External auth not configured for this profile.' });
          return;
        }
      } else if (authMode === 'oauth') {
        // OAuth mode: require a Bearer token (issued after the OAuth callback flow).
        // If no token is present, redirect the client to the OAuth login page.
        let bearerToken: string | undefined;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          bearerToken = authHeader.slice(7);
        } else if (typeof req.query.token === 'string') {
          bearerToken = req.query.token;
        }

        if (!bearerToken) {
          // Not a JSON client — redirect to OAuth login page for browser flows.
          const acceptHeader = req.headers.accept ?? '';
          if (acceptHeader.includes('text/html')) {
            res.redirect(`/mcp/${encodeURIComponent(profileName)}/oauth/login`);
          } else {
            res.status(401).json({
              success: false,
              message: 'Authentication required.',
              loginUrl: `/mcp/${encodeURIComponent(profileName)}/oauth/login`,
            });
          }
          return;
        }

        // Verify the Bearer token using the standard user/token auth path.
        const oauthAuthResult = await verifyBearerToken(
          bearerToken,
          profileName,
          state,
          req,
        );
        if (oauthAuthResult.error) {
          res.status(oauthAuthResult.status).json({ success: false, message: oauthAuthResult.error });
          return;
        }
        userAllowedTables = oauthAuthResult.allowedTables;
        userAllowedTools = oauthAuthResult.allowedTools;
        rateLimitId = oauthAuthResult.rateLimitId;
        rateLimitRpm = oauthAuthResult.rateLimitRpm;
        userIdentity = oauthAuthResult.userIdentity ?? null;
        resolvedTokenLabel = oauthAuthResult.tokenLabel;
      } else {
        // 'token', 'calame', 'sso' — all require a Bearer token.
        // For 'calame' and 'sso' modes, session cookies are handled at the UI layer;
        // the MCP protocol itself always uses Bearer tokens issued after login.
        let bearerToken: string | undefined;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          bearerToken = authHeader.slice(7);
        } else if (typeof req.query.token === 'string') {
          bearerToken = req.query.token;
        }

        if (!bearerToken) {
          res.status(401).json({ success: false, message: 'Missing token. Use Authorization header (Bearer <token>) or ?token=<token> query param.' });
          return;
        }

        const tokenAuthResult = await verifyBearerToken(
          bearerToken,
          profileName,
          state,
          req,
        );
        if (tokenAuthResult.error) {
          res.status(tokenAuthResult.status).json({ success: false, message: tokenAuthResult.error });
          return;
        }
        userAllowedTables = tokenAuthResult.allowedTables;
        userAllowedTools = tokenAuthResult.allowedTools;
        rateLimitId = tokenAuthResult.rateLimitId;
        rateLimitRpm = tokenAuthResult.rateLimitRpm;
        userIdentity = tokenAuthResult.userIdentity ?? null;
        resolvedTokenLabel = tokenAuthResult.tokenLabel;
      }

      // --- Rate limit enforcement ---
      if (rateLimitId && state.rateLimiter) {
        const effectiveRpm = rateLimitRpm ?? state.config?.rateLimitRpm ?? 0;
        const rl = state.rateLimiter.check(rateLimitId, effectiveRpm);
        if (!rl.allowed) {
          const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
          res.setHeader('Retry-After', String(retryAfterSec));
          res.status(429).json({
            success: false,
            message: 'Rate limit exceeded.',
            retryAfterMs: rl.retryAfterMs,
          });
          return;
        }
      }

      // --- Check that this specific profile is active ---
      if (!state.activeProfileNames.has(profileName)) {
        res.status(503).json({ success: false, message: `Profile "${profileName}" is not active.` });
        return;
      }

      // Upgrade the profile to the new shape (sources + scopes) at the serve entry point.
      // upgradeProfileShape is idempotent and preserves the legacy fields so that the
      // tool-registration block below (which still reads .selectedTables etc.) keeps working
      // unchanged until Phase 3 replaces it with adapter.registerMcpTools iteration.
      const rawProfile = state.serveProfiles[profileName];
      if (!rawProfile) {
        res.status(404).json({ success: false, message: `Profile "${profileName}" is not being served.` });
        return;
      }
      const profile = upgradeProfileShape(rawProfile);

      // --- Resolve configurations if present ---
      let effectiveConnections: string[];
      let effectiveSelectedTables: Record<string, string[]>;
      let effectiveTableOptions: Record<string, TableToolOptions> | undefined;
      let effectiveColumnMasking: Record<string, Record<string, ColumnMasking>> | undefined;

      if (profile.configurations && profile.configurations.length > 0) {
        // New path: resolve configurations and merge them
        if (!state.db) {
          res.status(500).json({ error: 'Database not initialised.' });
          return;
        }
        const configsFile = readConfigurationsFile(state.db);
        const resolvedConfigs = profile.configurations
          .map((configName) => configsFile.configurations[configName])
          .filter(Boolean) as Array<{
          connections: string[];
          selectedTables: Record<string, string[]>;
          tableOptions?: Record<string, TableToolOptions>;
          columnMasking?: Record<string, Record<string, ColumnMasking>>;
        }>;

        if (resolvedConfigs.length === 0) {
          res.status(500).json({ error: 'No valid configurations found for this profile.' });
          return;
        }

        const merged = mergeConfigurations(resolvedConfigs);
        effectiveConnections = merged.connections;
        effectiveSelectedTables = merged.selectedTables;
        effectiveTableOptions = merged.tableOptions;
        effectiveColumnMasking = merged.columnMasking;
      } else {
        // Legacy path: use inline profile fields (shallow copy to avoid mutating shared state)
        effectiveConnections = profile.connections?.length
          ? [...profile.connections]
          : [...state.connections.keys()];
        effectiveSelectedTables = { ...profile.selectedTables };
        effectiveTableOptions = profile.tableOptions ? { ...profile.tableOptions } as Record<string, TableToolOptions> : undefined;
        effectiveColumnMasking = profile.columnMasking ? { ...profile.columnMasking } as Record<string, Record<string, ColumnMasking>> : undefined;
      }

      // --- Apply user-level restrictions (narrow the profile scope) ---
      if (userAllowedTables) {
        const allowed = new Set(userAllowedTables);
        for (const tableName of Object.keys(effectiveSelectedTables)) {
          if (!allowed.has(tableName)) {
            delete effectiveSelectedTables[tableName];
          }
        }
      }
      if (userAllowedTools && effectiveTableOptions) {
        const allowed = new Set(userAllowedTools);
        for (const [, opts] of Object.entries(effectiveTableOptions)) {
          opts.enabledTools = opts.enabledTools.filter((t) => allowed.has(t)) as TableToolOptions['enabledTools'];
        }
      }

      // --- Resolve data scoping (row-level isolation) ---
      const scopeRules = profile.dataScopeRules;
      let scopeGuard;
      if (scopeRules && scopeRules.length > 0) {
        if (!userIdentity) {
          // Scoping requires individual authentication — reject if no identity
          res.status(403).json({
            error: 'This profile requires individual authentication for data scoping. '
              + 'Open or unauthenticated access is not compatible with dataScopeRules.',
          });
          return;
        }
        const scopeFilters = resolveUserScope(scopeRules, userIdentity);
        scopeGuard = createScopeGuard(scopeFilters, profile.sharedTables);

        // Audit log: scope resolution
        const scopeInfo = scopeGuard.getScopeInfo();
        state.logger?.info('Data scoping active', {
          component: `mcp/${profileName}`,
          userId: userIdentity.userId,
          email: userIdentity.email,
          filters: scopeInfo.filters.map((f: { tableName: string; column: string; value: string }) => `${f.tableName}.${f.column}=${f.value}`).join(', '),
        });
      } else {
        // No scoping: admin, legacy token, or no scope rules on profile
        scopeGuard = createScopeGuard([]);
      }

      // --- Resolve connections for this profile ---
      const profileConnections: ConnectionState[] = [];
      for (const cn of effectiveConnections) {
        const cs = state.getConnection(cn);
        if (cs) profileConnections.push(cs);
      }

      // Phase 3c: allow profiles that have only document sources (no DB connections).
      // A profile is valid if it has at least one connection OR at least one document-kind scope.
      const hasDocumentSources =
        profile.scopes !== undefined &&
        Object.values(profile.scopes).some((s) => s.kind === 'document');

      if (profileConnections.length === 0 && !hasDocumentSources) {
        res.status(500).json({ error: 'No database connection available for this profile.' });
        return;
      }

      // --- Create a stateless MCP server per request ---
      const mcpServer = new McpServer(
        { name: `calame-${profileName}`, version: '2.0.0' },
      );

      // Determines whether tool descriptions use raw DB names or human-readable labels.
      const responseMode = profile.responseMode ?? 'friendly';

      /**
       * Pass-through. Data shape is already adapted upstream (column names
       * are replaced by labels when responseMode is 'friendly'); we no
       * longer inject presentation instructions into the tool return,
       * because:
       *   1. They are trivially overridden by any explicit user request
       *      for structured output (cf. tests with Claude browser).
       *   2. They burn ~50 tokens on every tool call, multiplying with
       *      tool-loop length.
       *   3. Tool-call returns are an injection-prone surface — directives
       *      belong in the system prompt, not in payloads.
       * For Calame's internal chat, the equivalent guidance is already in
       * the system prompt (see chat-engine.ts FRIENDLY_ADDENDUM). External
       * MCP clients receive friendly-shaped data without the meta-text.
       */
      const wrapResponse = (jsonData: string): string => jsonData;
      void responseMode; // kept on the closure for future per-mode logic

      // --- Register MCP tools (Phase 3c: adapter-driven, iterates profile.sources) ---
      //
      // Strategy:
      //   1. Prefer the new shape (profile.sources + profile.scopes populated by upgradeProfileShape).
      //   2. Fall back to the legacy path (effectiveConnections + effectiveSelectedTables) when
      //      profile.scopes is empty — this covers profiles that haven't been through the migrator
      //      yet (e.g. created via YAML or old API). Backward compat invariant: a single-DB profile
      //      must emit identical tool names as before this refactor.
      //
      // The legacy path is kept verbatim so that existing tests keep passing unchanged. The new
      // adapter path is only taken when `profile.scopes` has been populated by upgradeProfileShape.

      // Determine which path to take.
      const hasNewShape =
        profile.scopes !== undefined &&
        profile.scopes !== null &&
        typeof profile.scopes === 'object' &&
        Object.keys(profile.scopes).length > 0;

      if (hasNewShape) {
        // --- New path: adapter-driven registration ---
        await registerToolsViaAdapters({
          mcpServer,
          profile,
          state,
          profileName,
          profileConnections,
          effectiveSelectedTables,
          effectiveTableOptions,
          effectiveColumnMasking,
          scopeGuard,
          responseMode,
          wrapResponse,
          resolvedTokenLabel,
        });
      } else {
        // --- Legacy path: direct registerDynamicTools iteration (unchanged) ---
        // Group tables by connection
        const tablesByConnection = new Map<
          ConnectionState,
          { tables: import('@calame/core').TableInfo[]; selectedTables: Record<string, string[]> }
        >();
        for (const [tableName, columns] of Object.entries(effectiveSelectedTables)) {
          let matchedConnState: ConnectionState | undefined;
          let tableInfo: import('@calame/core').TableInfo | undefined;
          for (const cs of profileConnections) {
            const found = cs.schema.tables.find((t) => t.name === tableName);
            if (found) {
              matchedConnState = cs;
              tableInfo = found;
              break;
            }
          }
          if (!matchedConnState || !tableInfo) {
            state.logger?.warn(
              `Table "${tableName}" not found in any connection schema — skipping`,
              { component: `mcp/${profileName}` },
            );
            continue;
          }
          let group = tablesByConnection.get(matchedConnState);
          if (!group) {
            group = { tables: [], selectedTables: {} };
            tablesByConnection.set(matchedConnState, group);
          }
          group.tables.push(tableInfo);
          group.selectedTables[tableName] = columns;
        }

        // Register tools per connection.
        // If no table matched any connection (empty profile, stale schema, or all tables restricted),
        // we still need to call registerDynamicTools at least once so that the MCP server registers
        // the tools/list handler. Without it, the server responds with -32601 (MethodNotFound) to
        // any tools/list request from the client, which breaks the chat flow and external MCP clients.
        if (tablesByConnection.size === 0) {
          // Pick any available connection just to satisfy the MCP protocol requirement.
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
            onAuditLog: (entry) => {
              if (state.auditLog) {
                state.auditLog.addEntry({ ...entry, tokenLabel: resolvedTokenLabel });
                state.auditLog.save().catch(() => {});
              }
            },
            profileName,
            databaseType: fallbackConn.connection.databaseType,
            responseMode,
            wrapResponse,
            maxOffset: 10000,
            scopeGuard,
          });
        } else {
          for (const [connState, group] of tablesByConnection) {
            const connector = getConnector(connState.connection.databaseType);
            const connectionString = connState.connection.connectionString;
            const sslConfig = connState.connection.sslConfig;
            const databaseType = connState.connection.databaseType;

            // Lazily compute (and cache) the distinct values used to render
            // categorical columns as `enum:a|b|c` in the tool catalogue.
            const distinctCacheKey = distinctValuesCacheKey(
              profileName,
              connectionString,
              group.selectedTables,
              effectiveColumnMasking,
            );
            let distinctValuesByTable = distinctValuesCache.get(distinctCacheKey);
            if (!distinctValuesByTable) {
              distinctValuesByTable = await computeDistinctValues({
                tables: group.tables,
                selectedTables: group.selectedTables,
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
                databaseType,
                perQueryTimeoutMs: 2000,
              });
              distinctValuesCache.set(distinctCacheKey, distinctValuesByTable);
            }

            registerDynamicTools({
              server: mcpServer,
              tables: group.tables,
              relations: profileConnections.flatMap((cs) => cs.schema.relations ?? []),
              selectedTables: group.selectedTables,
              tableOptions: effectiveTableOptions,
              columnMasking: effectiveColumnMasking,
              distinctValuesByTable,
              executeQuery: async (sql: string, params: unknown[]) => {
                // Route query through the correct connector with timeout
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
              onAuditLog: (entry) => {
                if (state.auditLog) {
                  state.auditLog.addEntry({ ...entry, tokenLabel: resolvedTokenLabel });
                  state.auditLog.save().catch(() => {});
                }
              },
              profileName,
              databaseType,
              responseMode,
              wrapResponse,
              maxOffset: 10000,
              scopeGuard,
            });
          }
        }
      }

      // Create a stateless transport (no session management)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      // Connect server to transport, handle the request, then clean up
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      await mcpServer.close();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: `mcp/${profileName}`, error: message });
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    }
  });

  // Handle GET for SSE streams on MCP endpoint
  app.get('/mcp/:profileName', async (req: Request, res: Response) => {
    // Stateless mode doesn't support GET SSE streams
    res.status(405).json({ error: 'Method not allowed. Use POST for MCP requests in stateless mode.' });
  });

  // Handle DELETE for session termination (not used in stateless mode)
  app.delete('/mcp/:profileName', async (req: Request, res: Response) => {
    res.status(405).json({ error: 'Method not allowed. Stateless mode does not use sessions.' });
  });
}

/** Result returned by verifyBearerToken. */
interface BearerAuthResult {
  profileName?: string;
  allowedTables: string[] | null;
  allowedTools: string[] | null;
  rateLimitId?: string;
  rateLimitRpm?: number;
  error?: string;
  status: number;
  /** Resolved user identity for data scoping. Null for legacy tokens or admin. */
  userIdentity?: UserIdentity | null;
  /** Human-readable label of the legacy token used, if any. */
  tokenLabel?: string;
}

/**
 * Verify a Bearer token against both the user manager and the legacy token manager.
 * Returns a structured result so callers can handle errors uniformly.
 */
async function verifyBearerToken(
  bearerToken: string,
  profileName: string,
  state: AppState,
  req: Request,
): Promise<BearerAuthResult> {
  const tokenManager = state.tokenManager;
  if (!tokenManager) {
    return { error: 'Token manager not initialized.', status: 500, allowedTables: null, allowedTools: null };
  }

  let authenticatedProfileName: string | undefined;
  let userAllowedTables: string[] | null = null;
  let userAllowedTools: string[] | null = null;
  let rateLimitId: string | undefined;
  let rateLimitRpm: number | undefined;
  let userIdentity: UserIdentity | null = null;

  const userManager = state.userManager;
  if (userManager) {
    const user = userManager.verifyToken(bearerToken);
    if (user) {
      if (user.status !== 'active') {
        return {
          error: 'Your access has been disabled. Contact your administrator.',
          status: 403,
          allowedTables: null,
          allowedTools: null,
        };
      }
      if (user.role === 'admin') {
        authenticatedProfileName = profileName;
        // Admin: no scoping (userIdentity stays null)
      } else {
        const profileAccess = userManager.getUserProfileAccess(user, profileName);
        if (!profileAccess) {
          return {
            error: `Your account is not authorized for profile "${profileName}".`,
            status: 403,
            allowedTables: null,
            allowedTools: null,
          };
        }
        if (profileAccess.accessMode === 'chat') {
          const internalSecret = req.headers['x-calame-internal'];
          if (internalSecret !== INTERNAL_CHAT_SECRET) {
            return {
              error: 'Your account only has chat access, not MCP access.',
              status: 403,
              allowedTables: null,
              allowedTools: null,
            };
          }
        }
        authenticatedProfileName = profileAccess.profileName;
        userAllowedTables = profileAccess.allowedTables;
        userAllowedTools = profileAccess.allowedTools;

        // Build user identity for data scoping
        userIdentity = {
          email: user.email,
          userId: user.id,
          externalId: user.oidcSubject ?? undefined,
          customAttributes: user.customAttributes ?? undefined,
        };
      }
      rateLimitId = user.id;
      const dbRow = state.db?.raw
        .prepare('SELECT rate_limit_rpm FROM users WHERE id = ?')
        .get(user.id) as { rate_limit_rpm: number | null } | undefined;
      if (dbRow?.rate_limit_rpm != null) {
        rateLimitRpm = dbRow.rate_limit_rpm;
      }
      await userManager.save();
    }
  }

  // Fall back to legacy token auth if user auth didn't match
  if (!authenticatedProfileName) {
    const tokenEntry = tokenManager.verifyToken(bearerToken);
    if (!tokenEntry) {
      return { error: 'Invalid token.', status: 401, allowedTables: null, allowedTools: null };
    }
    if (tokenEntry.profileName !== profileName) {
      return {
        error: `Token is not authorized for profile "${profileName}".`,
        status: 403,
        allowedTables: null,
        allowedTools: null,
      };
    }
    authenticatedProfileName = tokenEntry.profileName;
    rateLimitId = tokenEntry.id;
    await tokenManager.save();
    return {
      profileName: authenticatedProfileName,
      allowedTables: userAllowedTables,
      allowedTools: userAllowedTools,
      rateLimitId,
      rateLimitRpm,
      userIdentity,
      tokenLabel: tokenEntry.label,
      status: 200,
    };
  }

  return {
    profileName: authenticatedProfileName,
    allowedTables: userAllowedTables,
    allowedTools: userAllowedTools,
    rateLimitId,
    rateLimitRpm,
    userIdentity,
    status: 200,
  };
}

/** Read the global query timeout from environment (default 10000ms). */
function getQueryTimeoutMs(): number {
  return parseInt(process.env.CALAME_QUERY_TIMEOUT_MS ?? '10000', 10) || 10000;
}

// ---------------------------------------------------------------------------
// Phase 3c — adapter-driven tool registration
// ---------------------------------------------------------------------------

/** Options passed down to the adapter-driven registration helper. */
interface RegisterAdaptersOptions {
  mcpServer: McpServer;
  profile: import('@calame/core').ServeProfile;
  state: AppState;
  profileName: string;
  profileConnections: ConnectionState[];
  effectiveSelectedTables: Record<string, string[]>;
  effectiveTableOptions: Record<string, TableToolOptions> | undefined;
  effectiveColumnMasking: Record<string, Record<string, ColumnMasking>> | undefined;
  scopeGuard: import('@calame/core').ScopeGuard;
  responseMode: 'friendly' | 'raw';
  wrapResponse: (json: string) => string;
  resolvedTokenLabel: string | undefined;
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
        .prepare<[string], { config_encrypted: string }>(
          'SELECT config_encrypted FROM rag_sources WHERE id = ? LIMIT 1',
        )
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
 * Phase 3c: Register MCP tools by iterating `profile.sources`/`profile.scopes`
 * and delegating to `SourceAdapter.registerMcpTools` for each source.
 *
 * Backward compat invariant: single-DB profiles (one relational source, one kind)
 * produce toolNamespace='' → tool names are unchanged (e.g. `query`, not `prod_query`).
 *
 * Multi-source profiles produce `<sanitizedName>_` prefix per source when more
 * than one source of the same `kind` is active in the profile.
 */
async function registerToolsViaAdapters(opts: RegisterAdaptersOptions): Promise<void> {
  const {
    mcpServer,
    profile,
    state,
    profileName,
    profileConnections,
    effectiveSelectedTables,
    effectiveTableOptions,
    effectiveColumnMasking,
    scopeGuard,
    responseMode,
    wrapResponse,
    resolvedTokenLabel,
  } = opts;

  const scopes = profile.scopes ?? {};
  const sources = profile.sources ?? Object.keys(scopes);

  // Count active sources per kind to determine when namespacing is needed.
  const kindCounts = new Map<string, number>();
  for (const sourceId of sources) {
    const scope = scopes[sourceId];
    if (!scope) continue;
    kindCounts.set(scope.kind, (kindCounts.get(scope.kind) ?? 0) + 1);
  }

  let anyRegistered = false;

  for (const sourceId of sources) {
    const scope = scopes[sourceId];
    if (!scope) continue;

    const resolved = resolveAdapterForSource(sourceId, scope, state);
    if (!resolved) {
      state.logger?.warn(
        `No adapter found for source "${sourceId}" (kind=${scope.kind}) — skipping`,
        { component: `mcp/${profileName}` },
      );
      continue;
    }

    const { adapter, source } = resolved;

    // Compute toolNamespace: empty when only one source of this kind, prefixed otherwise.
    const kindCount = kindCounts.get(scope.kind) ?? 1;
    const toolNamespace =
      kindCount >= 2
        ? sanitizeToolNamespace(source.name) + '_'
        : '';

    // Build the adapter config.
    const config = resolveAdapterConfig(sourceId, scope, state);
    if (config === null) {
      state.logger?.warn(
        `Could not resolve config for source "${sourceId}" — skipping`,
        { component: `mcp/${profileName}` },
      );
      continue;
    }

    // Build a SourceSchema for the adapter. For relational sources we synthesize
    // it from the in-memory ConnectionState schema (already introspected). For
    // document sources the adapter introspects lazily; we pass an empty schema
    // here because registerMcpTools doesn't need the full schema — the RAG tools
    // query the storage layer at runtime.
    let schema: import('@calame/core').SourceSchema;
    if (scope.kind === 'relational') {
      const connState = state.connections.get(sourceId);
      // Apply user-level table restrictions to the scope selection before passing in.
      // effectiveSelectedTables has already been narrowed by the user restrictions block above.
      const narrowedScope: ScopeSelection = {
        kind: 'relational',
        selectedTables: effectiveSelectedTables,
        tableOptions: effectiveTableOptions,
        columnMasking: effectiveColumnMasking,
      };
      schema = {
        kind: 'relational',
        tables: connState?.schema.tables ?? [],
        relations: profileConnections.flatMap((cs) => cs.schema.relations ?? []),
      };
      // Override scope with the narrowed one.
      (resolved as { adapter: SourceAdapter; source: Source; narrowedScope?: ScopeSelection }).narrowedScope =
        narrowedScope;
    } else {
      schema = { kind: 'document', folders: [], documents: [] };
    }

    // Retrieve the (potentially narrowed) scope.
    const effectiveScope: ScopeSelection =
      (resolved as { adapter: SourceAdapter; source: Source; narrowedScope?: ScopeSelection })
        .narrowedScope ?? scope;

    // Build McpRegistrationContext.
    // For relational sources: build a live executeQuery closure over the connection.
    // For document sources: searchIndex is provided via the RAG runtime's search wrapper.
    const connState = scope.kind === 'relational' ? state.connections.get(sourceId) : undefined;
    const connector = connState ? getConnector(connState.connection.databaseType) : undefined;
    const connectionString = connState?.connection.connectionString ?? '';
    const sslConfig = connState?.connection.sslConfig;

    // Distinct-values cache for relational sources (same pattern as legacy path).
    let distinctValuesByTable: Record<string, Record<string, unknown[]>> | undefined;
    if (scope.kind === 'relational' && connState && connector) {
      const relScope = effectiveScope as Extract<ScopeSelection, { kind: 'relational' }>;
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
      selection: effectiveScope,
      profileName,
      toolNamespace,
      responseMode,
      onAuditLog: (entry: AuditLogEntry) => {
        if (state.auditLog) {
          state.auditLog.addEntry({ ...entry, tokenLabel: resolvedTokenLabel });
          state.auditLog.save().catch(() => {});
        }
      },
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

    // Document adapters (kind === 'document') read their search index from the
    // closure-bound deps that rag-runtime.ts injected at adapter construction time
    // (see packages/cli/src/rag-runtime.ts where buildDocumentSourceAdapter is
    // called). The McpRegistrationContext.searchIndex field is intentionally not
    // populated here — it would be dead since the adapter never reads it.

    // Inject wrapResponse for relational adapters (the DB adapter delegates to
    // registerDynamicTools which accepts wrapResponse).
    if (scope.kind === 'relational') {
      (ctx as McpRegistrationContext & {
        wrapResponse?: (json: string) => string;
        maxOffset?: number;
        distinctValuesByTable?: Record<string, Record<string, unknown[]>>;
      }).wrapResponse = wrapResponse;
      (ctx as McpRegistrationContext & {
        wrapResponse?: (json: string) => string;
        maxOffset?: number;
        distinctValuesByTable?: Record<string, Record<string, unknown[]>>;
      }).maxOffset = 10000;
      if (distinctValuesByTable) {
        (ctx as McpRegistrationContext & {
          wrapResponse?: (json: string) => string;
          maxOffset?: number;
          distinctValuesByTable?: Record<string, Record<string, unknown[]>>;
        }).distinctValuesByTable = distinctValuesByTable;
      }
    }

    try {
      adapter.registerMcpTools?.(ctx);
      anyRegistered = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      state.logger?.warn(
        `registerMcpTools failed for source "${sourceId}": ${msg}`,
        { component: `mcp/${profileName}` },
      );
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
      onAuditLog: (entry) => {
        if (state.auditLog) {
          state.auditLog.addEntry({ ...entry, tokenLabel: resolvedTokenLabel });
          state.auditLog.save().catch(() => {});
        }
      },
      profileName,
      databaseType: fallbackConn.connection.databaseType,
      responseMode,
      wrapResponse,
      maxOffset: 10000,
      scopeGuard,
    });
  }
}
