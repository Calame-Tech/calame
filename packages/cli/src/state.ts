import type { DatabaseSchema, PiiDetection, ServeProfile, NamedConnection } from '@calame/core';
import type { DatabaseType } from '@calame/connectors';
import type { CalameDatabase } from './database.js';
import type { TokenManager } from './token.js';
import type { UserManager } from './user.js';
import type { AuditLog } from './audit.js';
import type { WriteQueue } from './write-queue.js';
import type { AiSettingsManager } from './ai-config.js';
import type { SmtpConfigManager } from './smtp-config.js';
import type { OidcConfigManager } from '@calame-ee/sso';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import type { EmailService } from './email.js';
import type { SecretsProvider } from './secrets.js';
import type { LlmRouter } from './llm-router.js';
import type { RagRuntime } from './rag-runtime.js';
import { TokenRateLimiter } from './rate-limiter.js';

export interface ConnectionState {
  connection: NamedConnection;
  schema: DatabaseSchema;
  piiDetections: Record<string, Record<string, PiiDetection>> | null;
}

export class AppState {
  private _db: CalameDatabase | null = null;
  private _connections: Map<string, ConnectionState> = new Map();
  private _tokenManager: TokenManager | null = null;
  private _userManager: UserManager | null = null;
  private _auditLog: AuditLog | null = null;
  private _writeQueue: WriteQueue | null = null;
  private _aiSettingsManager: AiSettingsManager | null = null;
  private _smtpConfigManager: SmtpConfigManager | null = null;
  private _oidcConfigManager: OidcConfigManager | null = null;
  private _rateLimiter: TokenRateLimiter | null = null;
  private _activeProfileNames: Set<string> = new Set();
  private _serveProfiles: Record<string, ServeProfile> = {};
  private _config: AppConfig | undefined = undefined;
  private _logger: Logger | undefined = undefined;
  private _shutdownRequested = false;
  private _startedAt: number = Date.now();
  /** Active SSH tunnels, keyed by connection name. */
  _tunnels: Map<string, { close: () => Promise<void> }> = new Map();
  private _emailService: EmailService | null = null;
  private _secretsProvider: SecretsProvider | null = null;
  private _llmRouter: LlmRouter | null = null;
  private _ragRuntime: RagRuntime | undefined = undefined;

  // --- Multi-connection API ---

  get connections(): Map<string, ConnectionState> {
    return this._connections;
  }

  getConnection(name: string): ConnectionState | undefined {
    return this._connections.get(name);
  }

  addConnection(name: string, connState: ConnectionState): void {
    this._connections.set(name, connState);
  }

  removeConnection(name: string): void {
    this._connections.delete(name);
  }

  /** Get the first (default) connection, if any */
  private get _firstConnection(): ConnectionState | null {
    if (this._connections.size === 0) return null;
    return this._connections.values().next().value ?? null;
  }

  // --- Backward-compat getters/setters (delegate to first connection) ---

  get cachedSchema(): DatabaseSchema | null {
    return this._firstConnection?.schema ?? null;
  }

  set cachedSchema(value: DatabaseSchema | null) {
    if (value === null) return;
    if (this._connections.size === 0) {
      this._connections.set('default', {
        connection: { name: 'default', label: 'Default', databaseType: 'postgresql', connectionString: '' },
        schema: value,
        piiDetections: null,
      });
    } else {
      const first = this._firstConnection;
      if (first) first.schema = value;
    }
  }

  get cachedConnectionString(): string | null {
    return this._firstConnection?.connection.connectionString ?? null;
  }

  set cachedConnectionString(value: string | null) {
    if (value === null) return;
    // If no connections exist, create a default one
    if (this._connections.size === 0) {
      this._connections.set('default', {
        connection: {
          name: 'default',
          label: 'Default',
          databaseType: 'postgresql',
          connectionString: value,
        },
        schema: { tables: [], relations: [] },
        piiDetections: null,
      });
    } else {
      const first = this._firstConnection;
      if (first) first.connection.connectionString = value;
    }
  }

  get cachedDatabaseType(): DatabaseType | null {
    return this._firstConnection?.connection.databaseType ?? null;
  }

  set cachedDatabaseType(value: DatabaseType | null) {
    if (value === null) return;
    if (this._connections.size === 0) {
      this._connections.set('default', {
        connection: {
          name: 'default',
          label: 'Default',
          databaseType: value,
          connectionString: '',
        },
        schema: { tables: [], relations: [] },
        piiDetections: null,
      });
    } else {
      const first = this._firstConnection;
      if (first) first.connection.databaseType = value;
    }
  }

  get cachedPiiDetections(): Record<string, Record<string, PiiDetection>> | null {
    return this._firstConnection?.piiDetections ?? null;
  }

  set cachedPiiDetections(value: Record<string, Record<string, PiiDetection>> | null) {
    if (this._connections.size === 0 && value) {
      this._connections.set('default', {
        connection: { name: 'default', label: 'Default', databaseType: 'postgresql', connectionString: '' },
        schema: { tables: [], relations: [] },
        piiDetections: value,
      });
    } else {
      const first = this._firstConnection;
      if (first) first.piiDetections = value;
    }
  }

  // --- Internal SQLite database ---

  get db(): CalameDatabase | null {
    return this._db;
  }

  set db(value: CalameDatabase | null) {
    this._db = value;
  }

  // --- Non-connection state (unchanged) ---

  get tokenManager(): TokenManager | null {
    return this._tokenManager;
  }

  set tokenManager(value: TokenManager | null) {
    this._tokenManager = value;
  }

  get userManager(): UserManager | null {
    return this._userManager;
  }

  set userManager(value: UserManager | null) {
    this._userManager = value;
  }

  get auditLog(): AuditLog | null {
    return this._auditLog;
  }

  set auditLog(value: AuditLog | null) {
    this._auditLog = value;
  }

  get writeQueue(): WriteQueue | null {
    return this._writeQueue;
  }

  set writeQueue(value: WriteQueue | null) {
    this._writeQueue = value;
  }

  get aiSettingsManager(): AiSettingsManager | null {
    return this._aiSettingsManager;
  }

  set aiSettingsManager(value: AiSettingsManager | null) {
    this._aiSettingsManager = value;
  }

  /** @deprecated Use aiSettingsManager. Kept for transitional callers. */
  get aiConfigManager(): AiSettingsManager | null {
    return this._aiSettingsManager;
  }

  /** @deprecated Use aiSettingsManager. Kept for transitional callers. */
  set aiConfigManager(value: AiSettingsManager | null) {
    this._aiSettingsManager = value;
  }

  get smtpConfigManager(): SmtpConfigManager | null {
    return this._smtpConfigManager;
  }

  set smtpConfigManager(value: SmtpConfigManager | null) {
    this._smtpConfigManager = value;
  }

  get oidcConfigManager(): OidcConfigManager | null {
    return this._oidcConfigManager;
  }

  set oidcConfigManager(value: OidcConfigManager | null) {
    this._oidcConfigManager = value;
  }

  get rateLimiter(): TokenRateLimiter | null {
    return this._rateLimiter;
  }

  set rateLimiter(value: TokenRateLimiter | null) {
    this._rateLimiter = value;
  }

  /** Derived from activeProfileNames — true when at least one profile is active. */
  get serveMode(): boolean {
    return this._activeProfileNames.size > 0;
  }

  get activeProfileNames(): Set<string> {
    return this._activeProfileNames;
  }

  set activeProfileNames(value: Set<string>) {
    this._activeProfileNames = value;
  }

  get serveProfiles(): Record<string, ServeProfile> {
    return this._serveProfiles;
  }

  set serveProfiles(value: Record<string, ServeProfile>) {
    this._serveProfiles = value;
  }

  get config(): AppConfig | undefined {
    return this._config;
  }

  set config(value: AppConfig | undefined) {
    this._config = value;
  }

  get logger(): Logger | undefined {
    return this._logger;
  }

  set logger(value: Logger | undefined) {
    this._logger = value;
  }

  get shutdownRequested(): boolean {
    return this._shutdownRequested;
  }

  set shutdownRequested(value: boolean) {
    this._shutdownRequested = value;
  }

  get startedAt(): number {
    return this._startedAt;
  }

  // --- SSH Tunnels ---

  get tunnels(): Map<string, { close: () => Promise<void> }> {
    return this._tunnels;
  }

  async closeTunnel(name: string): Promise<void> {
    const tunnel = this._tunnels.get(name);
    if (tunnel) {
      await tunnel.close();
      this._tunnels.delete(name);
    }
  }

  async closeAllTunnels(): Promise<void> {
    const names = [...this._tunnels.keys()];
    for (const name of names) {
      await this.closeTunnel(name);
    }
  }

  // --- Email service ---

  get emailService(): EmailService | null {
    return this._emailService;
  }

  set emailService(value: EmailService | null) {
    this._emailService = value;
  }

  // --- External secrets provider ---

  get secretsProvider(): SecretsProvider | null {
    return this._secretsProvider;
  }

  set secretsProvider(value: SecretsProvider | null) {
    this._secretsProvider = value;
  }

  // --- LLM Router / Classifier ---

  get llmRouter(): LlmRouter | null {
    return this._llmRouter;
  }

  set llmRouter(value: LlmRouter | null) {
    this._llmRouter = value;
  }

  // --- RAG runtime (optional, lazy-loaded from @calame-ee/rag-core) ---

  get ragRuntime(): RagRuntime | undefined {
    return this._ragRuntime;
  }

  set ragRuntime(value: RagRuntime | undefined) {
    this._ragRuntime = value;
  }
}
