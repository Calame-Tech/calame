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
} from '@calame/core';
import {
  registerDynamicTools,
  registerCalcTool,
  resolveUserScope,
  createScopeGuard,
  computeDistinctValues,
  upgradeProfileShape,
  getProfileSelectedTables,
  getProfileTableOptions,
  getProfileColumnMasking,
  getProfileRelationalSources,
} from '@calame/core';
import { readConfigurationsFile } from './configurations.js';
import type { ServeConfiguration } from '@calame/core';
import { buildMcpPath } from '../utils/mcp-url.js';
import {
  resolveMcpRoute,
  loadServeProfileForTenant,
  isServeProfileActive,
  distinctValuesCache,
  distinctValuesCacheKey,
  getQueryTimeoutMs,
} from './serve/routing.js';
import { mergeConfigurations } from './serve/tool-merger.js';
import { verifyBearerToken } from './serve/bearer-auth.js';
import { registerToolsViaAdapters } from './serve/registration.js';

// Re-exports preserving the public API of this module. Other route files and
// tests import these symbols from './serve.js'; they now live in the serve/*
// submodules but stay re-exported here so existing imports keep working.
export {
  resolveMcpRoute,
  loadServeProfileForTenant,
  isServeProfileActive,
} from './serve/routing.js';
export { mergeConfigurations } from './serve/tool-merger.js';

export function registerServeRoute(app: Express, state: AppState): void {

  // MCP Streamable HTTP endpoint per profile.
  //
  // Two URL formats are accepted:
  //   - `/mcp/<profileName>`              — legacy, implicitly tenant='default'
  //   - `/mcp/<tenantId>/<profileName>`   — tenant-qualified (new)
  //
  // The wildcard pattern `/:firstSeg/:secondSeg?` matches both. Disambiguation
  // is handled by `resolveMcpRoute` — see its docstring for the policy.
  app.post('/mcp/:firstSeg/:secondSeg?', async (req: Request, res: Response) => {
    const firstSeg = req.params.firstSeg as string;
    const secondSeg = req.params.secondSeg as string | undefined;

    const route = resolveMcpRoute(firstSeg, secondSeg);
    if ('error' in route) {
      res.status(400).json({ success: false, message: 'Invalid tenant id format.' });
      return;
    }
    const { tenantId, profileName } = route;

    try {
      // --- Resolve the profile early to determine auth mode ---
      // NOTE: We read the profile before the full active-profile check so that open/oauth
      // mode profiles can return meaningful errors rather than a generic 503.
      const earlyProfile = loadServeProfileForTenant(state, tenantId, profileName);
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
          // The OAuth login URL is tenant-qualified when the request URL was.
          const loginUrl = `${buildMcpPath(profileName, tenantId)}/oauth/login`;
          const acceptHeader = req.headers.accept ?? '';
          if (acceptHeader.includes('text/html')) {
            res.redirect(loginUrl);
          } else {
            res.status(401).json({
              success: false,
              message: 'Authentication required.',
              loginUrl,
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
          tenantId,
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
          tenantId,
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
      // Active = either present in `state.activeProfileNames` (default tenant
      // fast path) or simply exists in the DB for the requested tenant
      // (non-default — see `isServeProfileActive` for the rationale).
      if (!isServeProfileActive(state, tenantId, profileName)) {
        res.status(503).json({ success: false, message: `Profile "${profileName}" is not active.` });
        return;
      }

      // Upgrade the profile to the new shape (sources + scopes) at the serve entry point.
      // upgradeProfileShape is idempotent and preserves the legacy fields so that the
      // tool-registration block below (which still reads .selectedTables etc.) keeps working
      // unchanged until Phase 3 replaces it with adapter.registerMcpTools iteration.
      const rawProfile = loadServeProfileForTenant(state, tenantId, profileName);
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
      // Document scopes merged from configurations (empty when using legacy path — profile.scopes is used directly).
      let effectiveDocumentScopes: Record<string, Extract<ScopeSelection, { kind: 'document' }>> = {};

      if (profile.configurations && profile.configurations.length > 0) {
        // New path: resolve configurations and merge them
        if (!state.db) {
          res.status(500).json({ error: 'Database not initialised.' });
          return;
        }
        // Multi-tenancy: the tenant is now carried in the URL — the legacy
        // `/mcp/<profile>` form resolves to `tenantId='default'` so existing
        // clients keep behaving as in Phase A/B; the tenant-qualified form
        // `/mcp/<tenant>/<profile>` looks up configurations under that tenant.
        const configsFile = readConfigurationsFile(state.db, tenantId);
        // Cast to ServeConfiguration[] — readConfigurationsFile always passes rows through
        // upgradeConfigurationShape which returns ServeConfiguration. The filter(Boolean) is
        // retained to silently skip deleted configurations that are still referenced by the profile.
        const resolvedConfigs = profile.configurations
          .map((configName) => configsFile.configurations[configName])
          .filter(Boolean) as ServeConfiguration[];

        if (resolvedConfigs.length === 0) {
          res.status(500).json({ error: 'No valid configurations found for this profile.' });
          return;
        }

        const merged = mergeConfigurations(resolvedConfigs);
        effectiveConnections = merged.connections;
        effectiveSelectedTables = merged.selectedTables;
        effectiveTableOptions = merged.tableOptions;
        effectiveColumnMasking = merged.columnMasking;
        // Capture merged document scopes from configurations.
        effectiveDocumentScopes = merged.documentScopes;
      } else {
        // Read via accessors so legacy profiles (`selectedTables` at the root)
        // and unified profiles (`scopes[].selectedTables`) merge into the same
        // effective payload. Shallow-clone the result so downstream mutations
        // don't leak back into the live profile.
        //
        // Connection resolution mirrors the historic legacy behaviour: prefer
        // the profile's relational sources when at least one matches a live
        // connection, otherwise fan out to every available DB connection
        // (covers the case where the migrator synthesised a placeholder id
        // like 'default' that doesn't match the actual connection name).
        const relationalSources = getProfileRelationalSources(profile);
        const matchedSources = relationalSources.filter((id) => state.connections.has(id));
        effectiveConnections = matchedSources.length
          ? [...matchedSources]
          : [...state.connections.keys()];
        effectiveSelectedTables = { ...getProfileSelectedTables(profile) };
        const aggTableOpts = getProfileTableOptions(profile);
        effectiveTableOptions = aggTableOpts ? { ...aggTableOpts } : undefined;
        const aggColumnMasking = getProfileColumnMasking(profile);
        effectiveColumnMasking = aggColumnMasking ? { ...aggColumnMasking } : undefined;
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
      // Also check effectiveDocumentScopes so that a profile that declares RAG only via
      // Data Configurations (no direct profile.scopes document entries) is still accepted.
      const hasDocumentSources =
        (profile.scopes !== undefined &&
          Object.values(profile.scopes).some((s) => s.kind === 'document')) ||
        Object.keys(effectiveDocumentScopes).length > 0;

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
      // Take the adapter path when:
      //   (a) profile.scopes is populated (normal new-shape profile), OR
      //   (b) configurations contributed document scopes even though profile.scopes is empty
      //       (profile uses Data Configurations for RAG only, no direct scopes declared).
      const hasNewShape =
        (profile.scopes !== undefined &&
          profile.scopes !== null &&
          typeof profile.scopes === 'object' &&
          Object.keys(profile.scopes).length > 0) ||
        Object.keys(effectiveDocumentScopes).length > 0;

      if (hasNewShape) {
        // --- New path: adapter-driven registration ---
        await registerToolsViaAdapters({
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
        });
      } else {
        // --- Legacy path: direct registerDynamicTools iteration (unchanged) ---

        // Register calc once globally — same rationale as in registerToolsViaAdapters.
        registerCalcTool(mcpServer, profileName, (s) => s, (entry) => {
          if (state.auditLog) {
            state.auditLog.addEntry({ ...entry, tokenLabel: resolvedTokenLabel, tenantId });
            state.auditLog.save().catch(() => {});
          }
        });

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
                state.auditLog.addEntry({ ...entry, tokenLabel: resolvedTokenLabel, tenantId });
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
                  state.auditLog.addEntry({ ...entry, tokenLabel: resolvedTokenLabel, tenantId });
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

  // Handle GET for SSE streams on MCP endpoint (both URL formats).
  // OAuth helper paths (e.g. `/mcp/<profile>/oauth/login`) live in
  // profile-oauth.ts and are registered first in app.ts, so they match ahead
  // of this catch-all. We reject any remaining GET because stateless mode
  // doesn't support SSE streams.
  app.get('/mcp/:firstSeg/:secondSeg?', async (_req: Request, res: Response) => {
    res.status(405).json({ error: 'Method not allowed. Use POST for MCP requests in stateless mode.' });
  });

  // Handle DELETE for session termination (not used in stateless mode).
  app.delete('/mcp/:firstSeg/:secondSeg?', async (_req: Request, res: Response) => {
    res.status(405).json({ error: 'Method not allowed. Stateless mode does not use sessions.' });
  });
}
