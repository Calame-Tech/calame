export interface NamedConnection {
  name: string;
  label: string;
  databaseType: 'postgresql' | 'mysql' | 'sqlite';
  connectionString: string;
  sslConfig?: {
    enabled: boolean;
    /** PEM certificate string for the CA. */
    ca?: string;
    /** Client certificate PEM. */
    cert?: string;
    /** Client private key PEM. */
    key?: string;
    /** Whether to reject unauthorized certificates (default: true). */
    rejectUnauthorized?: boolean;
  };
  sshConfig?: {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    privateKey?: string;
    password?: string;
    dbHost: string;
    dbPort: number;
  };
}

export interface ServeConfiguration {
  name: string;
  label: string;

  /**
   * Multi-tenancy (Phase A) — see migration v12 in `packages/cli/src/migration.ts`.
   * Always `'default'` today; the host writes the column on every INSERT but no
   * route filters by it yet. Optional in the type so in-memory test fixtures
   * (which don't go through the migrator) keep compiling. Once Phase B lands
   * and route-level scoping is enabled, this will become required.
   */
  tenantId?: string;

  /**
   * Source ids active in this configuration. Phase 2+ canonical replacement for
   * the legacy `connections` array. When both are present, `sources` wins; the
   * migrator reconciles older shapes on read.
   */
  sources?: string[];

  /**
   * Per-source allowlist. Phase 2+ canonical replacement for the legacy
   * `selectedTables`/`tableOptions`/`columnMasking` triple. Discriminated by `kind`.
   */
  scopes?: Record<string, import('../sources/index.js').ScopeSelection>;

  /**
   * @deprecated since Phase 2. Use `sources` instead. The migrator
   * (`upgradeConfigurationShape`) folds this into `sources` on read and deletes
   * this field (Phase 5). Present only on pre-migration v10 rows; absent on all
   * rows written after Phase 5. Use `getConfigurationRelationalSources()` instead
   * of reading this directly.
   */
  connections?: string[];

  /**
   * @deprecated since Phase 2. Use `scopes[sourceId].selectedTables` instead.
   * The migrator (`upgradeConfigurationShape`) folds this into `scopes` on read
   * and deletes this field (Phase 5). Present only on pre-migration v10 rows;
   * absent on all rows written after Phase 5. Use `getConfigurationSelectedTables()`
   * instead of reading this directly.
   */
  selectedTables?: Record<string, string[]>;

  /**
   * @deprecated since Phase 2. Use `scopes[sourceId].tableOptions` instead.
   * Will be removed in Phase 5.
   */
  tableOptions?: Record<string, import('../introspect/types.js').TableToolOptions>;

  /**
   * @deprecated since Phase 2. Use `scopes[sourceId].columnMasking` instead.
   * Will be removed in Phase 5.
   */
  columnMasking?: Record<string, Record<string, import('../pii/types.js').ColumnMasking>>;
}

// ---------------------------------------------------------------------------
// Data Scoping — row-level isolation per user
// ---------------------------------------------------------------------------

/** A single row-scoping rule. Links a table column to a user identity field. */
export interface DataScopeRule {
  /** The database table this rule applies to. */
  tableName: string;
  /** The column in the table to filter on (e.g. "client_email", "numero_client"). */
  column: string;
  /** Which user identity field to match against. */
  identityField: 'email' | 'externalId' | 'custom';
  /** When identityField is 'custom', the key in the user's customAttributes map. */
  customKey?: string;
}

/** User identity resolved at request time from the authenticated user. */
export interface UserIdentity {
  email: string;
  userId: string;
  externalId?: string;
  customAttributes?: Record<string, string>;
}

/** Concrete filter ready to inject into WHERE clauses. Produced by resolveUserScope(). */
export interface ResolvedScopeFilter {
  tableName: string;
  column: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Profile & configuration
// ---------------------------------------------------------------------------

export interface ServeProfile {
  name: string;
  label: string;
  /**
   * Multi-tenancy (Phase A) — see migration v12 in `packages/cli/src/migration.ts`.
   * Always `'default'` today; the host writes the column on every INSERT but no
   * route filters by it yet. Optional in the type so in-memory test fixtures
   * (which don't go through the migrator) keep compiling. Once Phase B lands
   * and route-level scoping is enabled, this will become required.
   */
  tenantId?: string;
  /**
   * Controls how MCP tool responses are formatted.
   * - 'friendly' (default): column names are replaced with human-readable labels,
   *   SQL types are translated to simple terms, technical details are hidden.
   * - 'raw': original technical names and types are exposed as-is.
   */
  responseMode?: 'friendly' | 'raw';
  configurations?: string[]; // References to ServeConfiguration names
  /** Names of AI settings (from ai_settings table) usable by clients of this MCP. First = default. */
  aiSettingNames?: string[];

  /**
   * Source ids active in this profile. Phase 2+ canonical replacement for
   * `connections`. When both are present, `sources` wins; the migrator
   * (`upgradeProfileShape`) reconciles older shapes on read.
   * New writes should populate `sources` only. Will be the sole field in Phase 5.
   */
  sources?: string[];

  /**
   * Per-source allowlist. Phase 2+ canonical replacement for the legacy
   * `selectedTables`/`tableOptions`/`columnMasking` triple at the profile root.
   * Discriminated by `kind`.
   */
  scopes?: Record<string, import('../sources/index.js').ScopeSelection>;

  // Phase 5 — legacy fields (`connections`, `selectedTables`, `tableOptions`,
  // `columnMasking`) were dropped from `ServeProfile`. Profiles authored in
  // the legacy shape are read via `upgradeProfileShape` (which folds them into
  // `sources` / `scopes` and drops the root fields). Code that still needs to
  // accept the legacy shape on input should use `ProfileScopeShape` from
  // `@calame/core/sources/accessors` (carries the legacy fields as optional
  // reads).
  token?: string; // auth token for this profile
  /** Authentication mode for this MCP server endpoint */
  authMode?: 'open' | 'token' | 'calame' | 'sso' | 'oauth' | 'external';
  /** OAuth config — only used when authMode is 'oauth' */
  oauthConfig?: {
    provider: 'github' | 'google' | 'gitlab' | 'custom';
    clientId: string;
    clientSecret: string;
    /** For custom/gitlab self-hosted: override authorization endpoint */
    authorizationUrl?: string;
    /** For custom/gitlab self-hosted: override token endpoint */
    tokenUrl?: string;
    /** For custom/gitlab self-hosted: override userinfo endpoint */
    userinfoUrl?: string;
  };
  /** Row-level data scoping rules. Tables listed here are filtered by user identity.
   *  When at least one rule exists, the profile enters strict mode:
   *  - Tables with a rule → scoped (filtered by user identity)
   *  - Tables in sharedTables → shared (all rows visible)
   *  - Tables in neither → blocked (0 results, fail-closed)
   */
  dataScopeRules?: DataScopeRule[];
  /** Tables explicitly shared (no scoping). Only relevant when dataScopeRules is non-empty. */
  sharedTables?: string[];
  /** External token validation config — only used when authMode is 'external' */
  externalAuthConfig?: {
    /** URL to call to validate the token. Calame sends the token as Bearer header. */
    validationUrl: string;
    /** Optional: custom header name instead of Authorization (e.g., "X-API-Key") */
    headerName?: string;
    /** Optional: header value template. Use {token} as placeholder. Default: "Bearer {token}" */
    headerTemplate?: string;
    /** JSON path to extract email from validation response (default: "email") */
    emailField?: string;
    /** JSON path to extract display name from validation response (default: "name") */
    nameField?: string;
    /** Whether to auto-create Calame users on first external login (default: true) */
    autoCreateUsers?: boolean;
  };
}

export interface ServeConfig {
  port: number;
  connections: Record<string, NamedConnection>;
  // Keep old fields for backward compat:
  databaseType: 'postgresql' | 'mysql' | 'sqlite';
  connectionString: string;
  profiles: Record<string, ServeProfile>;
  enableAuditLog?: boolean;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  profileName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: 'success' | 'error';
  resultSummary?: string; // e.g. "42 rows returned"
  resultData?: string; // raw JSON string returned by the tool (for expandable display)
  durationMs: number;
}

/**
 * Slice 1 (MCP write-approval) — discriminated payload describing what an
 * approved write actually does. Kept separate from the legacy flat fields on
 * `PendingWriteQuery` below (`sql`, `params`, `tableName`, `operation`,
 * `connectionName`, `databaseType`) for backward compatibility: too much
 * existing code/UI reads those directly to fold them away in this slice.
 *
 * - `kind: 'sql'` mirrors the flat fields 1:1 — the write executor's existing
 *   pg/mysql/sqlite path is untouched and keeps reading the flat fields.
 * - `kind: 'mcp-tool'` stores a *reference* (`sourceId`), never upstream
 *   config/credentials: the write executor re-resolves `Source.configEncrypted`
 *   at approval time, exactly like `connectionName` resolution for SQL writes
 *   (write-queue v15) — a vanished/disabled source fails the approval cleanly
 *   without executing. See docs/mcp-proxy-adapter-spec.md §6.
 */
export type PendingWriteAction =
  | {
      kind: 'sql';
      sql: string;
      params: unknown[];
      tableName: string;
      operation: 'insert' | 'update' | 'delete';
      connectionName?: string;
      databaseType?: string;
    }
  | { kind: 'mcp-tool'; sourceId: string; toolName: string; args: Record<string, unknown> };

export interface PendingWriteQuery {
  id: string;
  timestamp: string;
  profileName: string;
  sql: string;
  params: unknown[];
  tableName: string;
  operation: 'insert' | 'update' | 'delete';
  description: string;
  status: 'pending' | 'approved' | 'rejected';
  /** Tenant that owns this entry — admin routes must scope on it. */
  tenantId?: string;
  /** Named connection the write targets; approval resolves and executes against it. */
  connectionName?: string;
  /** Dialect of the target connection (postgresql | mysql | sqlite). */
  databaseType?: string;
  approvedBy?: string;
  approvedAt?: string;
  executionResult?: string;
  executionError?: string;
  /**
   * Slice 1 — discriminated action payload. Absent, or `{kind:'sql',...}`
   * synthesized at read time from the flat fields above, for legacy/SQL
   * entries; `{kind:'mcp-tool',...}` for a proxied upstream MCP tool call
   * awaiting approval. The host-side `WriteQueue` (packages/cli) always
   * populates this on read — optional here only so in-memory test fixtures
   * that predate Slice 1 keep compiling.
   */
  action?: PendingWriteAction;
  /**
   * `true` when the row's persisted `action_json` (or `params`) could not be
   * parsed. The entry stays LISTABLE — one corrupt row must not 500 the whole
   * Pending view — with a `kind: 'sql'` action synthesized from the flat
   * columns and a `[corrupt action]` marker on `description`, but it is NOT
   * executable: the approval route refuses it outright so an empty/partial
   * payload can never reach an executor. Rejecting it stays possible; that is
   * the admin's way out.
   */
  actionCorrupt?: boolean;
}
