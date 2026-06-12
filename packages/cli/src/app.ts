import express from 'express';
import cors from 'cors';
import { AppState } from './state.js';
import {
  createAdminSessionMiddleware,
  getAdminPassword,
  createSession,
  setSessionCookie,
  setUserSessionCookie,
  validateSession,
} from './session.js';
import { parseCookies } from './utils/cookies.js';
import { verifyPassword } from './crypto.js';
import { TokenManager } from './token.js';
import { UserManager } from './user.js';
import { AuditLog } from './audit.js';
import { CalameDatabase } from './database.js';
import { AiSettingsManager } from './ai-config.js';
import { SmtpConfigManager } from './smtp-config.js';
import type { OidcSessionDeps } from '@calame-ee/sso';
import { EmailService, isSmtpConfigured } from './email.js';
import { loadYamlConfig } from './yaml-config.js';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { registerAuthRoute } from './routes/auth.js';
import { registerConnectRoute } from './routes/connect.js';
import { registerSchemaRoute } from './routes/schema.js';
import { registerQueryRoute } from './routes/query.js';
import { registerChatRoute } from './routes/chat.js';
import { registerChatStreamRoute } from './routes/chat-stream.js';
import { registerProfilesRoute } from './routes/profiles.js';
import { registerPiiRoute } from './routes/pii.js';
import { registerTokensRoute } from './routes/tokens.js';
import { registerAuditRoute } from './routes/audit.js';
import { registerServeRoute } from './routes/serve.js';
import { registerServeStatusRoute } from './routes/serve-status.js';
import { WriteQueue } from './write-queue.js';
import { registerWriteQueueRoute } from './routes/write-queue.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerProfileOAuthRoutes } from './routes/profile-oauth.js';
import { OAUTH_PROVIDERS } from './oauth-providers.js';
import { registerProfilePreviewRoute } from './routes/profile-preview.js';
import { registerConnectionsRoute } from './routes/connections.js';
import { registerConfigurationsRoute } from './routes/configurations.js';
import { registerUsersRoute } from './routes/users.js';
import { registerOnboardingRoute } from './routes/onboarding.js';
import { registerChatProfileRoute } from './routes/chat-profile.js';
import { registerChatAuthRoute } from './routes/chat-auth.js';
import { registerAiSettingsRoute } from './routes/ai-settings.js';
import { registerSmtpSettingsRoute } from './routes/smtp-settings.js';
import { registerHealthRoute } from './routes/health.js';
import { registerBrandingRoutes } from './routes/branding.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerProfileScopesRoute } from './routes/profile-scopes.js';
import { registerTenantsRoutes } from './routes/tenants.js';
import { legacyPathDeprecationMiddleware } from './routes/source-aliases.js';
import { TokenRateLimiter } from './rate-limiter.js';
import { createSecretsProvider } from './secrets.js';
import { LlmRouter } from './llm-router.js';
import { getTenantId } from './tenancy.js';

export function createApp(
  stateOrOptions?: AppState | { state?: AppState; config?: AppConfig; logger?: Logger },
): express.Express {
  const app = express();

  let appState: AppState;
  let config: AppConfig | undefined;
  let logger: Logger | undefined;

  if (stateOrOptions instanceof AppState) {
    appState = stateOrOptions;
    config = appState.config;
    logger = appState.logger;
  } else {
    appState = stateOrOptions?.state ?? new AppState();
    config = stateOrOptions?.config;
    logger = stateOrOptions?.logger;
  }

  if (config) appState.config = config;
  if (logger) appState.logger = logger;

  const log = logger ?? { info: console.log, warn: console.warn, error: console.error };
  const dataDir = config?.dataDir ?? process.cwd();

  // Trust proxy (for correct req.ip behind reverse proxy)
  if (config?.trustProxy) {
    app.set('trust proxy', true);
  }

  // Initialize db first — TokenManager and other managers depend on it.
  // Migrations are applied automatically in CalameDatabase constructor.
  if (!appState.db) {
    appState.db = new CalameDatabase(dataDir);
  }

  // Initialize managers at startup (not lazily on MCP serve)
  if (!appState.tokenManager) {
    appState.tokenManager = new TokenManager(appState.db);
  }
  if (!appState.userManager) {
    appState.userManager = new UserManager(appState.db!);
  }
  if (!appState.auditLog) {
    const al = new AuditLog(appState.db);
    appState.auditLog = al;
  }
  if (!appState.writeQueue) {
    appState.writeQueue = new WriteQueue(appState.db);
  }
  if (!appState.aiSettingsManager) {
    appState.aiSettingsManager = new AiSettingsManager(appState.db);
  }
  if (!appState.smtpConfigManager) {
    appState.smtpConfigManager = new SmtpConfigManager(appState.db);
  }
  // OidcConfigManager is instantiated only when the EE SSO runtime is loaded.
  // When @calame-ee/sso is absent, oidcConfigManager stays undefined and OIDC
  // routes are not registered (see below).
  if (!appState.oidcConfigManager && appState.ssoRuntime) {
    appState.oidcConfigManager = new appState.ssoRuntime.OidcConfigManager(appState.db);
  }
  if (!appState.rateLimiter) {
    appState.rateLimiter = new TokenRateLimiter();
  }

  // Initialize EmailService — priority: SmtpConfigManager (DB) > env vars
  if (!appState.emailService) {
    const smtpDbConfig = appState.smtpConfigManager.getConfig();
    if (smtpDbConfig?.host) {
      appState.emailService = EmailService.fromSmtpConfig(smtpDbConfig);
      log.info('Email service initialized from database SMTP config');
    } else if (config && isSmtpConfigured(config)) {
      appState.emailService = new EmailService(config);
      log.info('Email service initialized from environment SMTP config');
    }
  }

  // Initialize external secrets provider
  if (config?.secretsProvider && config.secretsProvider !== 'none') {
    try {
      appState.secretsProvider = createSecretsProvider({
        provider: config.secretsProvider as 'vault' | 'aws',
        vaultAddr: config.secretsVaultAddr ?? undefined,
        vaultToken: config.secretsVaultToken ?? undefined,
        awsRegion: config.secretsAwsRegion ?? undefined,
      });
      log.info(`Secrets provider initialized: ${config.secretsProvider}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to initialize secrets provider: ${msg}`);
    }
  }

  // Initialize LLM Router / classifier pipeline
  if (config?.llmRouterEnabled && config?.llmClassifierProvider && config?.llmClassifierModel) {
    appState.llmRouter = new LlmRouter({
      classifierProvider: config.llmClassifierProvider,
      classifierModel: config.llmClassifierModel,
      classifierApiKey: config.llmClassifierApiKey ?? '',
      classifierEndpoint: config.llmClassifierEndpoint ?? undefined,
      injectionThreshold: config.llmRouterInjectionThreshold,
    });
    log.info(
      `LLM Router initialized: provider=${config.llmClassifierProvider} model=${config.llmClassifierModel}`,
    );
  }

  // Load YAML config-as-code if a config file is specified
  if (config?.configFile) {
    loadYamlConfig(config.configFile, appState, config, log as Logger).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to load YAML config: ${msg}`);
    });
  }

  // Deprecation warning for CALAME_ADMIN_PASSWORD
  if (getAdminPassword()) {
    log.warn(
      'CALAME_ADMIN_PASSWORD is deprecated. Admin auth now uses accounts stored in calame-users.json. Please remove this env var.',
    );
  }

  // CORS configuration
  const corsOptions: cors.CorsOptions = { credentials: true };
  if (config?.corsOrigins === '*') {
    corsOptions.origin = true;
  } else if (config?.corsOrigins) {
    const origins = config.corsOrigins.split(',').map((o) => o.trim());
    corsOptions.origin = origins.length === 1 ? origins[0] : origins;
  } else {
    corsOptions.origin = true;
  }
  app.use(cors(corsOptions));
  // Branding accepts inline data-URL images (logo/favicon up to ~1.5 MB), so it
  // needs a larger body limit than the 100 KB default. Mount it before the global
  // json parser — body-parser sets req._body once parsed, so the global parser
  // below skips already-parsed branding requests while keeping the tight default
  // for every other route.
  app.use('/api/branding', express.json({ limit: '2mb' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Deprecation middleware for legacy path prefixes (Phase 2: logger-only).
  // Adds Sunset header and logs once per unique path.
  // TODO(Phase 3): flip to actual URL rewriting once canonical /api/sources/* handlers exist.
  app.use(legacyPathDeprecationMiddleware());

  // Health check — public, no auth
  registerHealthRoute(app, appState);

  // Branding — GET is public (logo loads pre-login); POST enforces admin in-handler.
  registerBrandingRoutes(app, appState);

  // Auth routes (login/logout/status/setup) — must be before auth middleware
  registerAuthRoute(app, appState);

  // OAuth routes must be registered early (before SPA fallback)
  registerOAuthRoutes(app, appState);

  // OIDC auth routes — registered iff ssoRuntime is loaded (i.e. @calame-ee/sso is installed).
  // Each handler calls buildOidcProvider() at request time and returns 503 when not configured,
  // so routes are safe to expose unconditionally once the EE package is present — no restart
  // needed after OIDC is enabled via the settings UI.
  const ssoDeps: OidcSessionDeps = {
    createSession,
    setSessionCookie,
    setUserSessionCookie,
    validateSession,
    parseCookies,
    verifyPassword,
    adminSessionCookieName: 'calame_session',
    getUserPasswordHash: (userId: string) => {
      const row = appState.db?.raw
        .prepare('SELECT password_hash FROM users WHERE id = ?')
        .get(userId) as { password_hash: string | null } | undefined;
      return row?.password_hash ?? null;
    },
  };
  if (appState.ssoRuntime) {
    appState.ssoRuntime.registerOidcAuthRoutes(app, appState, ssoDeps);
  }

  // Per-profile OAuth routes — registered before admin session middleware (callbacks are public).
  registerProfileOAuthRoutes(app, appState);

  // Onboarding route — public (token-based auth, not session)
  registerOnboardingRoute(app, appState);

  // Public chat-profile info route — must be before admin session middleware
  registerChatProfileRoute(app, appState);

  // Public token-based chat auth — must be before admin session middleware
  registerChatAuthRoute(app, appState);

  // Chat stream route — has its own dual-auth (admin cookie OR user Bearer token)
  // Must be registered before the admin session middleware
  registerChatStreamRoute(app, appState);

  // Admin session middleware — protects all /api/* routes below
  app.use('/api', createAdminSessionMiddleware(appState.userManager!));

  registerConnectRoute(app, appState);
  registerConnectionsRoute(app, appState);
  registerConfigurationsRoute(app, appState);
  registerSchemaRoute(app, appState);
  registerQueryRoute(app, appState);
  registerChatRoute(app, appState);
  registerProfilesRoute(app, appState);
  registerProfileScopesRoute(app, appState);
  registerPiiRoute(app, appState);
  registerTokensRoute(app, appState);
  registerAuditRoute(app, appState);
  registerServeRoute(app, appState);
  registerServeStatusRoute(app, appState);
  registerWriteQueueRoute(app, appState);
  registerUsersRoute(app, appState);
  registerAiSettingsRoute(app, appState);
  registerSmtpSettingsRoute(app, appState);
  if (appState.ssoRuntime) {
    appState.ssoRuntime.registerOidcSettingsRoute(app, appState, ssoDeps);
  }
  registerMetricsRoute(app, appState);
  registerProfilePreviewRoute(app, appState);
  registerTenantsRoutes(app, appState);

  // Optional RAG routes — only registered when the EE rag-core package is
  // installed AND `initRagRuntime` has been called against this state. The
  // helper lazy-imports `@calame-ee/rag-core` and stashes the module on
  // `state.ragRuntime.ragCore` so we can register routes synchronously here.
  if (appState.ragRuntime && appState.db) {
    const rt = appState.ragRuntime;
    const db = appState.db;
    const ragDeps = {
      db: db.raw,
      pipeline: rt.pipeline,
      vectorStore: rt.vectorStore,
      resolveEmbeddingClient: rt.resolveEmbeddingClient,
      resolveEmbeddingSetting: rt.resolveEmbeddingSetting,
      resolveConnector: rt.resolveConnector,
      encryptConfig: rt.encryptConfig,
      decryptConfig: rt.decryptConfig,
      syncQueue: rt.syncQueue,
      pollScheduler: rt.pollScheduler,
      watchManager: rt.watchManager,
      // Phase A multi-tenancy bridge — `ee/rag-core` MUST NOT import from
      // `packages/cli`, so we wire the resolver here. Phase B will swap the
      // helper to read from `req.auth` without touching this site.
      getTenantId,
      // Forward the cap config so the usage route can include the
      // progress / threshold rollup in its response. The pipeline already
      // received the same config at construction time inside rag-runtime.
      capConfig: rt.capConfig,
      onAudit: (entry: { type: string; payload: unknown; timestamp: string }) => {
        log.info(`[rag-audit] ${entry.type} ${JSON.stringify(entry.payload)}`);
      },
    };
    rt.ragCore.registerRagSourcesRoutes(app, ragDeps);
    rt.ragCore.registerRagContentRoutes(app, ragDeps);
    rt.ragCore.registerRagUploadRoutes(app, ragDeps);
    rt.ragCore.registerRagIndexRoutes(app, ragDeps);
    rt.ragCore.registerRagSearchRoutes(app, ragDeps);
    rt.ragCore.registerRagUsageRoutes(app, ragDeps);
    log.info('RAG routes registered on /api/rag/*');
  }

  // GET /api/oauth-providers — list available OAuth provider options for the UI
  app.get('/api/oauth-providers', (_req, res) => {
    const providers = [
      ...Object.entries(OAUTH_PROVIDERS).map(([id, cfg]) => ({ id, name: cfg.name })),
      { id: 'custom', name: 'Custom OAuth' },
    ];
    res.json({ success: true, providers });
  });

  return app;
}
