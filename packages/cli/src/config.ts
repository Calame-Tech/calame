import os from 'os';
import path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

export interface AppConfig {
  port: number;
  basePath: string;
  adminPassword: string | null;
  secretKey: string | null;
  dataDir: string;
  trustProxy: boolean;
  corsOrigins: string;
  logLevel: LogLevel;
  logFormat: LogFormat;
  dbPoolSize: number;
  dbIdleTimeoutMs: number;
  queryTimeoutMs: number;
  auditRetentionDays: number;
  chatRetentionDays: number;
  llmProvider: string;
  llmEndpoint: string | null;
  llmModel: string | null;
  llmApiKey: string | null;
  tlsCert: string | null;
  tlsKey: string | null;
  /** Global rate limit (requests per minute) applied to every MCP token. 0 = unlimited. */
  rateLimitRpm: number;

  // YAML config-as-code
  /** Path to a YAML configuration file. Set via CALAME_CONFIG_FILE. */
  configFile: string | null;

  // SMTP for email invitations
  smtpHost: string | null; // CALAME_SMTP_HOST
  smtpPort: number; // CALAME_SMTP_PORT, default 587
  smtpUser: string | null; // CALAME_SMTP_USER
  smtpPass: string | null; // CALAME_SMTP_PASS
  smtpFrom: string | null; // CALAME_SMTP_FROM

  // OIDC / SSO
  /** Whether OIDC/SSO login is enabled. Set via CALAME_OIDC_ENABLED. */
  oidcEnabled: boolean;
  /** OIDC issuer URL (e.g. https://accounts.google.com). Set via CALAME_OIDC_ISSUER_URL. */
  oidcIssuerUrl: string | null;
  /** OIDC client ID. Set via CALAME_OIDC_CLIENT_ID. */
  oidcClientId: string | null;
  /** OIDC client secret (optional for public clients). Set via CALAME_OIDC_CLIENT_SECRET. */
  oidcClientSecret: string | null;
  /** Redirect URI registered with the IdP. Set via CALAME_OIDC_REDIRECT_URI. */
  oidcRedirectUri: string | null;
  /** Space-separated OIDC scopes. Set via CALAME_OIDC_SCOPES. Default: "openid profile email". */
  oidcScopes: string;
  /** JWT claim name that contains the user's groups. Set via CALAME_OIDC_GROUP_CLAIM. Default: "groups". */
  oidcGroupClaim: string;
  /** JSON mapping of IdP group names to Calame profile names. Set via CALAME_OIDC_GROUP_MAP. */
  oidcGroupMap: string | null;
  /** Whether to auto-create Calame users on first SSO login. Set via CALAME_OIDC_AUTO_CREATE_USERS. Default: true. */
  oidcAutoCreateUsers: boolean;

  // Secrets manager
  /** External secrets provider. Set via CALAME_SECRETS_PROVIDER. Values: 'none'|'vault'|'aws'. Default: 'none'. */
  secretsProvider: string;
  /** HashiCorp Vault address. Set via CALAME_SECRETS_VAULT_ADDR. */
  secretsVaultAddr: string | null;
  /** HashiCorp Vault token. Set via CALAME_SECRETS_VAULT_TOKEN. */
  secretsVaultToken: string | null;
  /** AWS region for Secrets Manager. Set via CALAME_SECRETS_AWS_REGION. */
  secretsAwsRegion: string | null;

  // LLM Router
  /** Whether the LLM classifier router is enabled. Set via CALAME_LLM_ROUTER_ENABLED. Default: false. */
  llmRouterEnabled: boolean;
  /** Classifier LLM provider. Set via CALAME_LLM_CLASSIFIER_PROVIDER. */
  llmClassifierProvider: string | null;
  /** Classifier LLM model name. Set via CALAME_LLM_CLASSIFIER_MODEL. */
  llmClassifierModel: string | null;
  /** API key for the classifier LLM. Set via CALAME_LLM_CLASSIFIER_API_KEY. */
  llmClassifierApiKey: string | null;
  /** Base URL for a custom/local classifier endpoint. Set via CALAME_LLM_CLASSIFIER_ENDPOINT. */
  llmClassifierEndpoint: string | null;
  /** Confidence threshold above which injection_attempt messages are blocked. Set via CALAME_LLM_ROUTER_INJECTION_THRESHOLD. Default: 0.8. */
  llmRouterInjectionThreshold: number;

  // Packaged desktop mode (Tauri sidecar)
  /**
   * Whether Calame is running as a packaged desktop app: a bundled single-file server
   * running outside the pnpm workspace, with no monorepo layout around it. Set via
   * CALAME_PACKAGED (truthy: "1" or "true"). Default: false.
   */
  packaged: boolean;
  /**
   * Absolute path to the built web UI (dist directory with index.html) to serve as static
   * assets. Set via CALAME_WEB_DIST. Falls back to a path relative to the server bundle when
   * unset, which only resolves correctly inside the monorepo layout.
   */
  webDistPath: string | null;

  // Claude Desktop integration
  /**
   * Override for the directory the "Connect to Claude Desktop" integration
   * reads/writes `claude_desktop_config.json` in. Set via
   * CALAME_CLAUDE_DESKTOP_CONFIG_DIR. When unset, the platform default is
   * used (see `routes/claude-desktop/paths.ts`). Exists primarily so tests
   * can point at a throwaway temp directory instead of the real per-user
   * Claude Desktop config.
   */
  claudeDesktopConfigDir: string | null;

  // "Expose for Copilot / ChatGPT" tunnel (cloudflared quick tunnel)
  /**
   * Absolute path to the `cloudflared` binary. Set via CALAME_CLOUDFLARED_PATH —
   * the Tauri desktop app sets this to the resource path it bundled
   * `cloudflared.exe` at (see `apps/desktop/src-tauri/src/server.rs`). When
   * unset, `tunnel/cloudflared-resolve.ts` falls back to a packaged-mode
   * sibling of the bundled server, then a dev-mode cache dir staged by
   * `scripts/prepare-desktop.mjs`.
   */
  cloudflaredPath: string | null;

  // Bundled local embedding model (default RAG embedding provider)
  /**
   * Absolute path to the directory containing the bundled local embedding
   * model. Set via CALAME_LOCAL_EMBEDDING_MODEL_DIR — the Tauri desktop app
   * sets this to the resource path it bundled the model at (see
   * `apps/desktop/src-tauri/src/server.rs`). When unset,
   * `rag/local-model-resolve.ts` falls back to a packaged-mode sibling of the
   * bundled server, then a dev-mode cache dir staged by
   * `scripts/fetch-embedding-model.mjs`.
   */
  localEmbeddingModelDir: string | null;
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function envString(key: string, fallback: string | null = null): string | null {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * Whether Calame is running in packaged desktop mode (CALAME_PACKAGED=1/true). Exposed as a
 * standalone function (in addition to AppConfig.packaged) because index.ts needs to know this
 * before loadConfig() runs — packaged mode changes how the project root / cwd is resolved,
 * which happens at module load time, ahead of configuration loading.
 */
export function isPackagedMode(): boolean {
  return envBool('CALAME_PACKAGED', false);
}

/**
 * Platform-appropriate per-user application data directory for Calame, used as the default
 * dataDir in packaged mode (no writable monorepo checkout to fall back to). Mirrors common
 * desktop app conventions:
 *  - Windows: %APPDATA%\Calame
 *  - macOS:   ~/Library/Application Support/Calame
 *  - Linux:   $XDG_DATA_HOME/calame or ~/.local/share/calame
 */
export function getPackagedDataDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Calame');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Calame');
  }
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome) {
    return path.join(xdgDataHome, 'calame');
  }
  return path.join(os.homedir(), '.local', 'share', 'calame');
}

export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const packaged = isPackagedMode();
  const defaultDataDir = packaged ? getPackagedDataDir() : process.cwd();

  const config: AppConfig = {
    port: overrides?.port ?? envInt('CALAME_PORT', 4567),
    basePath: envString('CALAME_BASE_PATH', '/') ?? '/',
    adminPassword: envString('CALAME_ADMIN_PASSWORD'),
    secretKey: envString('CALAME_SECRET_KEY'),
    dataDir: envString('CALAME_DATA_DIR', defaultDataDir) ?? defaultDataDir,
    trustProxy: envBool('CALAME_TRUST_PROXY', false),
    corsOrigins: envString('CALAME_CORS_ORIGINS', '*') ?? '*',
    logLevel: (envString('CALAME_LOG_LEVEL', 'info') as LogLevel) ?? 'info',
    logFormat: (envString('CALAME_LOG_FORMAT', 'text') as LogFormat) ?? 'text',
    dbPoolSize: envInt('CALAME_DB_POOL_SIZE', 10),
    dbIdleTimeoutMs: envInt('CALAME_DB_IDLE_TIMEOUT_MS', 30000),
    queryTimeoutMs: envInt('CALAME_QUERY_TIMEOUT_MS', 10000),
    auditRetentionDays: envInt('CALAME_AUDIT_RETENTION_DAYS', 90),
    chatRetentionDays: envInt('CALAME_CHAT_RETENTION_DAYS', 30),
    llmProvider: envString('CALAME_LLM_PROVIDER', 'anthropic') ?? 'anthropic',
    llmEndpoint: envString('CALAME_LLM_ENDPOINT'),
    llmModel: envString('CALAME_LLM_MODEL'),
    llmApiKey: envString('CALAME_LLM_API_KEY'),
    tlsCert: envString('CALAME_TLS_CERT'),
    tlsKey: envString('CALAME_TLS_KEY'),
    rateLimitRpm: envInt('CALAME_RATE_LIMIT_RPM', 0),
    configFile: envString('CALAME_CONFIG_FILE'),
    smtpHost: envString('CALAME_SMTP_HOST'),
    smtpPort: envInt('CALAME_SMTP_PORT', 587),
    smtpUser: envString('CALAME_SMTP_USER'),
    smtpPass: envString('CALAME_SMTP_PASS'),
    smtpFrom: envString('CALAME_SMTP_FROM'),
    oidcEnabled: envBool('CALAME_OIDC_ENABLED', false),
    oidcIssuerUrl: envString('CALAME_OIDC_ISSUER_URL'),
    oidcClientId: envString('CALAME_OIDC_CLIENT_ID'),
    oidcClientSecret: envString('CALAME_OIDC_CLIENT_SECRET'),
    oidcRedirectUri: envString('CALAME_OIDC_REDIRECT_URI'),
    oidcScopes: envString('CALAME_OIDC_SCOPES', 'openid profile email') ?? 'openid profile email',
    oidcGroupClaim: envString('CALAME_OIDC_GROUP_CLAIM', 'groups') ?? 'groups',
    oidcGroupMap: envString('CALAME_OIDC_GROUP_MAP'),
    oidcAutoCreateUsers: envBool('CALAME_OIDC_AUTO_CREATE_USERS', true),
    secretsProvider: envString('CALAME_SECRETS_PROVIDER', 'none') ?? 'none',
    secretsVaultAddr: envString('CALAME_SECRETS_VAULT_ADDR'),
    secretsVaultToken: envString('CALAME_SECRETS_VAULT_TOKEN'),
    secretsAwsRegion: envString('CALAME_SECRETS_AWS_REGION'),
    llmRouterEnabled: envBool('CALAME_LLM_ROUTER_ENABLED', false),
    llmClassifierProvider: envString('CALAME_LLM_CLASSIFIER_PROVIDER'),
    llmClassifierModel: envString('CALAME_LLM_CLASSIFIER_MODEL'),
    llmClassifierApiKey: envString('CALAME_LLM_CLASSIFIER_API_KEY'),
    llmClassifierEndpoint: envString('CALAME_LLM_CLASSIFIER_ENDPOINT'),
    llmRouterInjectionThreshold: (() => {
      const raw = process.env.CALAME_LLM_ROUTER_INJECTION_THRESHOLD;
      if (!raw) return 0.8;
      const parsed = parseFloat(raw);
      return isNaN(parsed) ? 0.8 : Math.min(1, Math.max(0, parsed));
    })(),
    packaged,
    webDistPath: envString('CALAME_WEB_DIST'),
    claudeDesktopConfigDir: envString('CALAME_CLAUDE_DESKTOP_CONFIG_DIR'),
    cloudflaredPath: envString('CALAME_CLOUDFLARED_PATH'),
    localEmbeddingModelDir: envString('CALAME_LOCAL_EMBEDDING_MODEL_DIR'),
  };

  // Validate logLevel
  if (!LOG_LEVELS.includes(config.logLevel)) {
    config.logLevel = 'info';
  }
  if (config.logFormat !== 'text' && config.logFormat !== 'json') {
    config.logFormat = 'text';
  }

  // Normalize basePath
  if (!config.basePath.startsWith('/')) {
    config.basePath = '/' + config.basePath;
  }
  if (config.basePath.length > 1 && config.basePath.endsWith('/')) {
    config.basePath = config.basePath.slice(0, -1);
  }

  return config;
}

export function validateConfig(config: AppConfig): void {
  if (config.tlsCert && !config.tlsKey) {
    throw new Error('CALAME_TLS_CERT is set but CALAME_TLS_KEY is missing.');
  }
  if (config.tlsKey && !config.tlsCert) {
    throw new Error('CALAME_TLS_KEY is set but CALAME_TLS_CERT is missing.');
  }
}
