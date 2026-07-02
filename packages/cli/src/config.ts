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

export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const config: AppConfig = {
    port: overrides?.port ?? envInt('CALAME_PORT', 4567),
    basePath: envString('CALAME_BASE_PATH', '/') ?? '/',
    adminPassword: envString('CALAME_ADMIN_PASSWORD'),
    secretKey: envString('CALAME_SECRET_KEY'),
    dataDir: envString('CALAME_DATA_DIR', process.cwd()) ?? process.cwd(),
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
