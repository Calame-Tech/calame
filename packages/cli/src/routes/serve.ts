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
  registerCalcTool,
  resolveUserScope,
  createScopeGuard,
  computeDistinctValues,
  upgradeProfileShape,
  sourceAdapterRegistry,
  getProfileSelectedTables,
  getProfileTableOptions,
  getProfileColumnMasking,
  getProfileRelationalSources,
  getConfigurationSelectedTables,
  getConfigurationTableOptions,
  getConfigurationColumnMasking,
  getConfigurationRelationalSources,
  getConfigurationDocumentScopes,
} from '@calame/core';
import { readConfigurationsFile } from './configurations.js';
import type { ServeConfiguration } from '@calame/core';
import type { ServeProfile } from '@calame/core';
import { INTERNAL_CHAT_SECRET } from '../chat-engine.js';
import { DEFAULT_TENANT_ID } from '../tenancy.js';
import { buildMcpPath } from '../utils/mcp-url.js';

/**
 * Tenant id alphabet — kept in sync with `TENANT_ID_RE` in tenancy.ts.
 * Letters, digits, underscore, hyphen; 1 to 64 chars.
 *
 * Defined locally because the MCP routes need to reject malformed tenant
 * segments with a 400 — `getTenantId` cannot do this because it falls back
 * silently to `'default'` for forward compatibility.
 */
const MCP_TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Resolve the (tenantId, profileName) pair for an MCP URL.
 *
 * Two URL formats are supported:
 *   - `/mcp/<profileName>`              — legacy, implicitly tenant='default'
 *   - `/mcp/<tenantId>/<profileName>`   — tenant-qualified
 *
 * Ambiguity policy: a single segment is ALWAYS interpreted as legacy
 * (tenant=default, profile=<seg>). An admin who wants to target a non-default
 * tenant MUST include the profile name as a second segment — there is no
 * heuristic that promotes a single segment to a tenant id, even when that
 * segment happens to match a known tenant.
 *
 * Returns `null` when the first segment looks like a tenant-qualified URL but
 * the tenant id fails the alphabet check — the route handler turns this into
 * a 400.
 */
export function resolveMcpRoute(
  firstSeg: string,
  secondSeg: string | undefined,
): { tenantId: string; profileName: string } | { error: 'invalid_tenant_id' } {
  if (secondSeg) {
    // Tenant-qualified form: validate the tenant alphabet.
    if (!MCP_TENANT_ID_RE.test(firstSeg)) {
      return { error: 'invalid_tenant_id' };
    }
    return { tenantId: firstSeg, profileName: secondSeg };
  }
  // Legacy form: always the default tenant.
  return { tenantId: DEFAULT_TENANT_ID, profileName: firstSeg };
}

/**
 * Load a single `ServeProfile` from the DB for the supplied tenant.
 * Returns `null` when no `profiles` row exists for that tenant, or when the
 * row exists but does not carry a profile with the requested name.
 *
 * For backward compat the AppState in-memory cache (`state.serveProfiles`)
 * is preferred for the default tenant — that path keeps the existing fast
 * path unchanged and ensures the legacy URL `/mcp/<profile>` continues to
 * behave exactly as before Phase B introduced multi-tenancy.
 */
export function loadServeProfileForTenant(
  state: AppState,
  tenantId: string,
  profileName: string,
): ServeProfile | null {
  // Fast path: default tenant uses the in-memory cache populated by
  // `serve/start` and `serve/refresh`. This preserves all current behaviour
  // (including the "active" check based on `state.activeProfileNames`).
  if (tenantId === DEFAULT_TENANT_ID) {
    return state.serveProfiles[profileName] ?? null;
  }

  // Non-default tenant: load fresh from the DB. The `profiles` row holds
  // every profile for that tenant in a single JSON blob.
  if (!state.db) return null;
  try {
    const row = state.db.raw
      .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
      .get(tenantId) as { data: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.data) as { profiles?: Record<string, unknown> };
    const raw = parsed.profiles?.[profileName];
    if (!raw || typeof raw !== 'object') return null;
    return upgradeProfileShape({ ...(raw as Record<string, unknown>), name: profileName });
  } catch {
    return null;
  }
}

/**
 * Returns `true` when the (tenantId, profileName) pair is currently active.
 *
 * For the default tenant we honour the in-memory `state.activeProfileNames`
 * set (the current single-tenant behaviour). For non-default tenants we
 * treat every profile that exists in the DB as implicitly active — there is
 * no per-tenant activation toggle today, and the alternative would be to
 * silently refuse every cross-tenant MCP request.
 */
export function isServeProfileActive(
  state: AppState,
  tenantId: string,
  profileName: string,
): boolean {
  if (tenantId === DEFAULT_TENANT_ID) {
    return state.activeProfileNames.has(profileName);
  }
  // Non-default tenants: existence in the DB implies active.
  return true;
}

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
 * Phase 5: now accepts `ServeConfiguration` objects directly (the type returned
 * by `readConfigurationsFile`). The legacy `connections`/`selectedTables`/
 * `tableOptions`/`columnMasking` root fields have been made optional as of Phase 5
 * (the migrator deletes them after folding their data into `sources`/`scopes`).
 * All field reads go through the Configuration accessors so that both the
 * pre-migration legacy shape and the new unified shape are handled identically.
 *
 * Phase 6 — document scopes: per-source `kind: 'document'` allowlists declared
 * in any of the Configurations are merged into `documentScopes`. The merge
 * follows the same "least restrictive" spirit as the relational side:
 *   - if **any** config sets `mode: 'allowAll'` for a sourceId, the result is
 *     `allowAll` with empty allowlists (least restrictive wins);
 *   - otherwise (every config is `allowList`) the merged allowedFolders and
 *     allowedDocuments are the unions of the individual config lists.
 */
/** Narrowed document scope type. */
type DocumentScope = Extract<ScopeSelection, { kind: 'document' }>;

export function mergeConfigurations(
  configs: ServeConfiguration[],
): {
  connections: string[];
  selectedTables: Record<string, string[]>;
  tableOptions: Record<string, TableToolOptions>;
  columnMasking: Record<string, Record<string, ColumnMasking>>;
  /**
   * Merged document (RAG) scopes from every configuration in the array.
   * Merge rule: "allowAll wins" — if any config has mode='allowAll' for a
   * given sourceId, the result is allowAll (empty allowlists). Otherwise the
   * allowedFolders and allowedDocuments lists are unioned across all configs.
   * Mirrors the relational strategy (union / least-restrictive).
   */
  documentScopes: Record<string, DocumentScope>;
} {
  const connectionsSet = new Set<string>();
  const selectedTables: Record<string, string[]> = {};
  const tableOptions: Record<string, TableToolOptions> = {};
  const columnMasking: Record<string, Record<string, ColumnMasking>> = {};
  const documentScopes: Record<string, DocumentScope> = {};

  for (const config of configs) {
    for (const c of getConfigurationRelationalSources(config)) connectionsSet.add(c);

    // Union of tables and columns (read via accessor — handles both unified and legacy shape)
    for (const [table, cols] of Object.entries(getConfigurationSelectedTables(config))) {
      if (!selectedTables[table]) {
        selectedTables[table] = [...cols];
      } else {
        const existing = new Set(selectedTables[table]);
        for (const col of cols) existing.add(col);
        selectedTables[table] = [...existing];
      }
    }

    // Union permissive for tableOptions
    for (const [table, rawOpts] of Object.entries(getConfigurationTableOptions(config) ?? {})) {
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
    for (const [table, colMasking] of Object.entries(getConfigurationColumnMasking(config) ?? {})) {
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

    // Merge document (RAG) scopes — "allowAll wins, else union of allowlists".
    //
    // piiMaskingMode merge policy: 'off' wins. Rationale — the toggle is an
    // explicit user opt-out for sources whose content collides with the PII
    // detector heuristics. When any linked configuration disables masking we
    // honour that intent; otherwise masking stays at the default. This
    // mirrors the "least-restrictive-on-access" merge for allowAll/allowList.
    for (const [sourceId, docScope] of Object.entries(getConfigurationDocumentScopes(config))) {
      const existing = documentScopes[sourceId];
      const piiMaskingMode: 'off' | undefined =
        existing?.piiMaskingMode === 'off' || docScope.piiMaskingMode === 'off' ? 'off' : undefined;
      // directFetchDisabled merge policy: true wins. If any configuration disables direct fetch
      // for the same source, it stays disabled in the merged scope.
      const directFetchDisabled: true | undefined =
        existing?.directFetchDisabled === true || docScope.directFetchDisabled === true
          ? true
          : undefined;
      if (!existing) {
        // First time we see this sourceId: copy as-is (mutable snapshot).
        documentScopes[sourceId] = {
          kind: 'document',
          mode: docScope.mode,
          allowedFolders: [...docScope.allowedFolders],
          allowedDocuments: [...docScope.allowedDocuments],
          ...(piiMaskingMode !== undefined ? { piiMaskingMode } : {}),
          ...(directFetchDisabled !== undefined ? { directFetchDisabled } : {}),
        };
      } else if (existing.mode === 'allowAll' || docScope.mode === 'allowAll') {
        // Either side is allowAll → promote to allowAll (least restrictive wins).
        documentScopes[sourceId] = {
          kind: 'document',
          mode: 'allowAll',
          allowedFolders: [],
          allowedDocuments: [],
          ...(piiMaskingMode !== undefined ? { piiMaskingMode } : {}),
          ...(directFetchDisabled !== undefined ? { directFetchDisabled } : {}),
        };
      } else {
        // Both are allowList → union of the two allowlists.
        const foldersSet = new Set([...existing.allowedFolders, ...docScope.allowedFolders]);
        const docsSet = new Set([...existing.allowedDocuments, ...docScope.allowedDocuments]);
        documentScopes[sourceId] = {
          kind: 'document',
          mode: 'allowList',
          allowedFolders: [...foldersSet],
          allowedDocuments: [...docsSet],
          ...(piiMaskingMode !== undefined ? { piiMaskingMode } : {}),
          ...(directFetchDisabled !== undefined ? { directFetchDisabled } : {}),
        };
      }
    }
  }

  return {
    connections: [...connectionsSet],
    selectedTables,
    tableOptions,
    columnMasking,
    documentScopes,
  };
}

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
 *
 * The `tenantId` parameter is the tenant resolved from the MCP URL. When set,
 * legacy tokens are required to match (tokens carry their owning tenant in the
 * `tokens.tenant_id` column). User-manager tokens are not yet tenant-tagged at
 * the row level (Phase B did not migrate `users.tenant_id` into the verify
 * path), so they pass through unchanged — this matches the existing semantics
 * where any active admin can hit any profile.
 */
async function verifyBearerToken(
  bearerToken: string,
  profileName: string,
  state: AppState,
  req: Request,
  tenantId: string = DEFAULT_TENANT_ID,
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
    // Cross-tenant token replay guard. The legacy `tokens` table carries
    // `tenant_id` since Phase A — when the row's tenant doesn't match the
    // URL's tenant we surface a 403 rather than authorising a request that
    // could otherwise serve another tenant's profile rows.
    //
    // Tokens issued before Phase A landed have `tenant_id = 'default'` (the
    // column default), so `/mcp/<profile>` requests with such tokens keep
    // working unchanged.
    const tokenTenant = tokenEntry.tenantId ?? DEFAULT_TENANT_ID;
    if (tokenTenant !== tenantId) {
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
async function registerToolsViaAdapters(opts: RegisterAdaptersOptions): Promise<void> {
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
      state.logger?.warn(
        `No adapter found for relational source "${sourceId}" — skipping`,
        { component: `mcp/${profileName}` },
      );
      continue;
    }

    const { adapter, source } = resolved;

    // Compute toolNamespace: empty when only one relational source, prefixed otherwise.
    const toolNamespace =
      relationalKindCount >= 2
        ? sanitizeToolNamespace(source.name) + '_'
        : '';

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

    try {
      adapter.registerMcpTools?.(ctx);
      anyRegistered = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      state.logger?.warn(
        `registerMcpTools failed for relational source "${sourceId}": ${msg}`,
        { component: `mcp/${profileName}` },
      );
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
              .prepare<[string], { tenant_id: string }>(
                'SELECT tenant_id FROM rag_sources WHERE id = ?',
              )
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
          state.logger?.warn(
            `No adapter found for document source "${sourceId}" — skipping`,
            { component: `mcp/${profileName}` },
          );
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
          state.logger?.warn(
            `registerMergedDocumentRagTools failed: ${msg}`,
            { component: `mcp/${profileName}` },
          );
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
