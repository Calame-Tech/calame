export type DatabaseType = 'postgresql' | 'mysql' | 'sqlite';

// SSL Config
export interface SslConfig {
  enabled: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

// SSH Tunnel Config
export interface SshTunnelConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  privateKey?: string;
  password?: string;
  dbHost: string;
  dbPort: number;
}

export interface DatabaseSchema {
  tables: TableInfo[];
  relations: Relation[];
}

export interface TableInfo {
  name: string;
  schema: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
}

export interface Relation {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface TableToolOptions {
  enabledTools: ('describe' | 'aggregate' | 'query' | 'write')[];
  maxLimit: number;
  filterableColumns: string[];
  groupableColumns: string[];
  columnMasking?: Record<string, ColumnMasking>;
}

// PII & Masking types
export type PiiCategory =
  | 'email'
  | 'phone'
  | 'name'
  | 'address'
  | 'credit_card'
  | 'password'
  | 'ip_address'
  | 'ssn'
  | 'encrypted';
export type MaskingMode = 'none' | 'exclude' | 'hash' | 'truncate' | 'replace' | 'aggregate_only';

export interface PiiDetection {
  category: PiiCategory;
  confidence: 'high' | 'medium' | 'low' | 'manual';
  matchedBy: 'column_name' | 'data_sample' | 'both' | 'manual';
}

export interface ColumnMasking {
  piiDetected?: PiiDetection;
  maskingMode: MaskingMode;
  truncateOptions?: { showFirst?: number; showLast?: number };
  replaceValue?: string;
}

export interface GlobalMaskingRule {
  piiCategory: PiiCategory;
  defaultMode: MaskingMode;
  truncateOptions?: { showFirst?: number; showLast?: number };
  replaceValue?: string;
}

export interface Config {
  serverName: string;
  transport: 'stdio' | 'streamable-http';
  clientTarget: 'claude-desktop' | 'cursor' | 'vscode';
  outputDir: string;
  tableOptions?: Record<string, TableToolOptions>;
}

export interface NamedConnection {
  name: string;
  label: string;
  databaseType: DatabaseType;
  connectionString: string;
  sslConfig?: SslConfig;
  sshConfig?: SshTunnelConfig;
}

export interface Configuration {
  name: string;
  label: string;
  /** Source ids associated with this configuration (Phase 5+). */
  sources?: string[];
  /** Per-source access scopes (Phase 5+). Discriminated by `kind`. */
  scopes?: Record<string, ScopeSelection>;
}

export interface ConfigurationsFile {
  configurations: Record<string, Omit<Configuration, 'name'>>;
}

export type AuthMode = 'open' | 'token' | 'calame' | 'sso' | 'oauth' | 'external';

export interface ExternalAuthConfig {
  validationUrl: string;
  headerName?: string;
  headerTemplate?: string;
  emailField?: string;
  nameField?: string;
  autoCreateUsers?: boolean; // default true
}

export interface OAuthConfig {
  provider: 'github' | 'google' | 'gitlab' | 'custom';
  clientId: string;
  clientSecret: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
}

/** A single row-scoping rule for data isolation. */
export interface DataScopeRule {
  tableName: string;
  column: string;
  identityField: 'email' | 'externalId' | 'custom';
  customKey?: string;
}

export interface Profile {
  name: string;
  label: string;
  configurations?: string[]; // References to Configuration names
  /** Names of AI settings (from ai_settings table) usable by clients of this MCP. First = default. */
  aiSettingNames?: string[];
  authMode?: AuthMode;
  oauthConfig?: OAuthConfig;
  externalAuthConfig?: ExternalAuthConfig;
  responseMode?: 'friendly' | 'raw';
  /** Row-level data scoping rules. */
  dataScopeRules?: DataScopeRule[];
  /** Tables explicitly shared (no scoping) when dataScopeRules is non-empty. */
  sharedTables?: string[];
  /** Source ids active in this profile (Phase 2+). */
  sources?: string[];
  /** Per-source access scopes (Phase 2+). Discriminated by `kind`. */
  scopes?: Record<string, ScopeSelection>;
}

export interface ProfilesFile {
  connection: {
    type: 'postgresql';
    envVar: string;
  };
  connections?: Record<string, Omit<NamedConnection, 'name'>>;
  profiles: Record<string, Omit<Profile, 'name'>>;
}

// Token management
export interface TokenEntry {
  id: string;
  tokenHash: string; // masked for display
  profileName: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

// User management
export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled' | 'invited';
export type AccessMode = 'mcp' | 'chat' | 'both';

export interface UserProfileAccess {
  profileName: string;
  allowedTables: string[] | null;
  allowedTools: string[] | null;
  accessMode: AccessMode;
}

export interface UserEntry {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  profiles: UserProfileAccess[];
  createdAt: string;
  lastActiveAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  onboardingCode: string | null;
  onboardingExpiresAt: string | null;
  rateLimitRpm?: number;
  /** Arbitrary key-value attributes for data scoping (e.g. {"client_id": "CLT-00042"}). */
  customAttributes?: Record<string, string> | null;
}

// Audit log
export interface AuditLogEntry {
  id: string;
  timestamp: string;
  profileName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: 'success' | 'error';
  resultSummary?: string;
  resultData?: string; // raw JSON string returned by the tool (for expandable display)
  durationMs: number;
}

// Pending write queries
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
  approvedBy?: string;
  approvedAt?: string;
  executionResult?: string;
  executionError?: string;
}

// Metrics types
export interface MetricsSummary {
  requestsByHour: Array<{ hour: string; profile: string; count: number }>;
  topTools: Array<{ toolName: string; count: number }>;
  topTokens: Array<{ tokenLabel: string; count: number }>;
  errorRate: Array<{ result: string; count: number }>;
  avgResponseTime: Array<{ profileName: string; avgMs: number; count: number }>;
}

export interface PoolStats {
  connectionName: string;
  stats: { active: number; idle: number; waiting: number; total: number };
}

// RAG / Sources access scoping — mirrors @calame/core ScopeSelection.
// Keep the arms in sync with `packages/core/src/sources/types.ts:ScopeSelection`
// so that values flowing from @calame-ee/rag-core/web components type-check
// without `unknown` casts. New arms added on the core side must be reflected
// here even if the web does not render them — the components on this side
// preserve them inertly via the override pattern.
export type ScopeSelection =
  | {
      kind: 'relational';
      selectedTables: Record<string, string[]>;
      tableOptions?: Record<string, TableToolOptions>;
      columnMasking?: Record<string, Record<string, ColumnMasking>>;
    }
  | {
      kind: 'document';
      mode: 'allowAll' | 'allowList';
      allowedFolders: readonly string[];
      allowedDocuments: readonly string[];
      piiMaskingMode?: 'inherit' | 'off';
      directFetchDisabled?: boolean;
    }
  | {
      kind: 'api';
      /**
       * Allowlist of operation ids the LLM may invoke via this source.
       * Mirrors `packages/core/src/sources/types.ts:ScopeSelection`'s `api` arm.
       * The web layer doesn't render API scopes today — `RagAccessSelector`
       * preserves them inertly through its scope-merge pattern.
       */
      allowedOperations: readonly string[];
    };

// Serve status
export interface ServeStatus {
  active: boolean;
  port: number;
  profiles: string[];
  profileStatuses?: Record<string, { active: boolean; endpoint: string }>;
  startedAt?: string;
  totalRequests: number;
}
