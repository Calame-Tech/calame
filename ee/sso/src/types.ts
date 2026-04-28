// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Database } from 'better-sqlite3';
import type { Response } from 'express';

/** Minimal database wrapper accepted by OidcConfigManager. */
export interface DatabaseLike {
  raw: Database;
}

/** OIDC env-var fallback config (read from process.env by the host app). */
export interface OidcEnvConfig {
  oidcEnabled?: boolean;
  oidcIssuerUrl?: string | null;
  oidcClientId?: string | null;
  oidcClientSecret?: string | null;
  oidcRedirectUri?: string | null;
  oidcScopes: string;
  oidcGroupClaim: string;
  oidcGroupMap?: string | null;
  oidcAutoCreateUsers: boolean;
}

export interface OidcUserProfileAccess {
  profileName: string;
  allowedTables: unknown[] | null;
  allowedTools: unknown[] | null;
  accessMode: 'both' | 'read' | 'write' | string;
}

export interface OidcUser {
  id: string;
  oidcSubject?: string | null;
  customAttributes?: Record<string, string> | null;
  profiles: Array<{ profileName: string }>;
  role?: string;
  onboardingCode?: string | null;
}

export interface OidcCreateUserInput {
  name: string;
  email: string;
  role: 'admin' | 'user' | string;
  profiles: OidcUserProfileAccess[];
  customAttributes?: Record<string, string> | null;
}

/** Subset of UserManager that the OIDC routes call. The host app's UserManager
 *  satisfies this interface structurally. */
export interface OidcUserManager {
  getUserByOidcSubject(subject: string): OidcUser | null | undefined;
  getUserByEmail(email: string): OidcUser | null | undefined;
  getUserById(id: string): OidcUser | null | undefined;
  setOidcSubject(userId: string, subject: string): void;
  setCustomAttributes(userId: string, attrs: Record<string, string>): void;
  addProfileAccess(userId: string, access: OidcUserProfileAccess): void;
  removeProfileAccess(userId: string, profileName: string): void;
  consumeOnboardingCode(code: string): void;
  createUser(input: OidcCreateUserInput): OidcUser & { onboardingCode: string | null };
  save(): Promise<void> | void;
}

export interface OidcServeProfile {
  authMode?: string;
}

export interface OidcLogger {
  error(msg: string, meta?: object): void;
}

/** Persisted OIDC settings shape (as stored in oidc_config table). */
export interface OidcSettingsConfig {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  groupClaim: string;
  groupToProfile: Record<string, string>;
  autoCreateUsers: boolean;
  /** Map SSO token claims to user customAttributes for data scoping.
   *  Key = claim name in the OIDC token, Value = attribute key in customAttributes.
   *  e.g. { "numero_client": "client_id" } copies token.numero_client → user.customAttributes.client_id */
  claimsToAttributes?: Record<string, string>;
}

/** Same shape as OidcSettingsConfig but with the clientSecret masked for safe display. */
export type OidcMaskedConfig = Omit<OidcSettingsConfig, 'clientSecret'> & { clientSecret: string };

/** Forward declaration — the concrete class is defined in ./config-manager.ts. */
export interface OidcConfigManagerLike {
  getConfig(): OidcSettingsConfig | null;
  getMaskedConfig(): OidcMaskedConfig | null;
  setConfig(config: OidcSettingsConfig): void;
  isConfigured(): boolean;
}

/** Application context required by the OIDC routes — supplied by the host. */
export interface OidcAppContext {
  oidcConfigManager?: OidcConfigManagerLike | null;
  userManager?: OidcUserManager | null;
  config?: OidcEnvConfig | undefined;
  serveProfiles: Record<string, OidcServeProfile>;
  logger?: OidcLogger | undefined;
  db?: DatabaseLike | null;
}

/** Session, cookie and password helpers injected by the host. Kept generic so
 *  ee/sso has no runtime dependency on the host's auth implementation. */
export interface OidcSessionDeps {
  createSession(userId: string): string;
  setSessionCookie(res: Response, sessionId: string): void;
  setUserSessionCookie(res: Response, sessionId: string): void;
  validateSession(sessionId: string): { userId?: string | null } | null | undefined;
  parseCookies(header: string | undefined): Record<string, string | undefined>;
  verifyPassword(password: string, hash: string): boolean;
  /** Cookie name carrying the admin session id (e.g. 'calame_session'). */
  adminSessionCookieName: string;
  /** Returns the bcrypt-style password hash stored for the user, or null. */
  getUserPasswordHash(userId: string): string | null;
}
