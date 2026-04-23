import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getConnector } from '@calame/connectors';
import type { AppState, ConnectionState } from '../state.js';
import type { TableToolOptions, ColumnMasking, UserIdentity } from '@calame/core';
import {
  registerDynamicTools,
  resolveUserScope,
  createScopeGuard,
} from '@calame/core';
import { readConfigurationsFile } from './configurations.js';
import { INTERNAL_CHAT_SECRET } from '../chat-engine.js';

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

      const profile = state.serveProfiles[profileName];
      if (!profile) {
        res.status(404).json({ success: false, message: `Profile "${profileName}" is not being served.` });
        return;
      }

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
      if (profileConnections.length === 0) {
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
       * Wrap response JSON with LLM presentation instructions in friendly mode.
       * In raw mode, returns the JSON string unchanged.
       */
      const wrapResponse = (jsonData: string): string => {
        if (responseMode !== 'friendly') return jsonData;
        return (
          '[INSTRUCTIONS POUR LE MODELE]\n' +
          'Presente ces donnees en langage naturel et fluide. Ne mentionne JAMAIS de noms de colonnes, ' +
          'de champs, de tables, ou de structure technique. Ne presente JAMAIS les donnees sous forme ' +
          '"champ: valeur". Decris les informations comme si tu racontais quelque chose a quelqu\'un, ' +
          'de maniere naturelle et humaine.\n\n' +
          '[DONNEES]\n' +
          jsonData
        );
      };

      // --- Register tools via core registerDynamicTools (grouped by connection) ---
      // Group tables by connection
      const tablesByConnection = new Map<ConnectionState, { tables: import('@calame/core').TableInfo[]; selectedTables: Record<string, string[]> }>();
      for (const [tableName, columns] of Object.entries(effectiveSelectedTables)) {
        let matchedConnState: ConnectionState | undefined;
        let tableInfo: import('@calame/core').TableInfo | undefined;
        for (const cs of profileConnections) {
          const found = cs.schema.tables.find(t => t.name === tableName);
          if (found) { matchedConnState = cs; tableInfo = found; break; }
        }
        if (!matchedConnState || !tableInfo) {
          state.logger?.warn(`Table "${tableName}" not found in any connection schema — skipping`, { component: `mcp/${profileName}` });
          continue;
        }
        let group = tablesByConnection.get(matchedConnState);
        if (!group) { group = { tables: [], selectedTables: {} }; tablesByConnection.set(matchedConnState, group); }
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
            const result = await connector.query(connectionString, sql, { timeoutMs: getQueryTimeoutMs(), ssl: sslConfig, params });
            return { rows: result.rows as Record<string, unknown>[], fields: Object.keys(result.rows[0] ?? {}).map(name => ({ name })) };
          },
          onAuditLog: (entry) => {
            if (state.auditLog) {
              state.auditLog.addEntry(entry);
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

          registerDynamicTools({
            server: mcpServer,
            tables: group.tables,
            relations: profileConnections.flatMap(cs => cs.schema.relations ?? []),
            selectedTables: group.selectedTables,
            tableOptions: effectiveTableOptions,
            columnMasking: effectiveColumnMasking,
            executeQuery: async (sql: string, params: unknown[]) => {
              // Route query through the correct connector with timeout
              const result = await connector.query(connectionString, sql, { timeoutMs: getQueryTimeoutMs(), ssl: sslConfig, params });
              return { rows: result.rows as Record<string, unknown>[], fields: Object.keys(result.rows[0] ?? {}).map(name => ({ name })) };
            },
            onAuditLog: (entry) => {
              if (state.auditLog) {
                state.auditLog.addEntry(entry);
                state.auditLog.save().catch(() => {});
              }
            },
            profileName,
            databaseType: connState.connection.databaseType,
            responseMode,
            wrapResponse,
            maxOffset: 10000,
            scopeGuard,
          });
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
