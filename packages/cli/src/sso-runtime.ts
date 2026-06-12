// SSO runtime bootstrap. Lazy-loads `@calame-ee/sso` so the CLI works when the
// EE package is absent (apache-only install). Mirrors the pattern established
// by `rag-runtime.ts`. Idempotent — safe to call multiple times.

import type { CalameDatabase } from './database.js';

/**
 * Public shape of the SSO runtime stored on `AppState.ssoRuntime`. All fields
 * are optional from the host's perspective — when the EE package is missing the
 * entire runtime is `undefined` and OIDC routes are not registered.
 *
 * Typed against the live module exports to preserve TypeScript safety without a
 * static value-import of `@calame-ee/sso`.
 */
export interface SsoRuntime {
  OidcConfigManager: typeof import('@calame-ee/sso').OidcConfigManager;
  OidcProvider: typeof import('@calame-ee/sso').OidcProvider;
  registerOidcAuthRoutes: typeof import('@calame-ee/sso').registerOidcAuthRoutes;
  registerOidcSettingsRoute: typeof import('@calame-ee/sso').registerOidcSettingsRoute;
}

/**
 * Initialize the SSO runtime on the given app state. Idempotent — subsequent
 * calls are no-ops if `state.ssoRuntime` is already set.
 *
 * Returns `undefined`. Side-effects only — sets `state.ssoRuntime` on success
 * or `state.ssoDisabledReason` on failure.
 *
 * @param state   object holding mutable `ssoRuntime?` and `ssoDisabledReason?` slots
 * @param _db     the host's SQLite database wrapper (reserved for future use)
 * @param logger  optional logger for status messages
 */
export async function initSsoRuntime(
  state: { ssoRuntime?: SsoRuntime; ssoDisabledReason?: string | null },
  _db: CalameDatabase,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  if (state.ssoRuntime) return;

  const log = logger ?? { info: console.log, warn: console.warn };

  try {
    const sso = await import('@calame-ee/sso');
    state.ssoRuntime = {
      OidcConfigManager: sso.OidcConfigManager,
      OidcProvider: sso.OidcProvider,
      registerOidcAuthRoutes: sso.registerOidcAuthRoutes,
      registerOidcSettingsRoute: sso.registerOidcSettingsRoute,
    };
    log.info('SSO runtime loaded (@calame-ee/sso).');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`SSO features disabled (@calame-ee/sso not available): ${msg}`);
    state.ssoDisabledReason = 'EE package @calame-ee/sso not installed';
  }
}
