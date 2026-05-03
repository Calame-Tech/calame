// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

export { OidcConfigManager } from './config-manager.js';
export { OidcProvider } from './provider.js';
export type { OidcProviderConfig } from './provider.js';
export { registerOidcAuthRoutes } from './routes/auth.js';
export type { OidcAuthRouteOptions } from './routes/auth.js';
export { registerOidcSettingsRoute } from './routes/settings.js';
export type {
  DatabaseLike,
  OidcAppContext,
  OidcConfigManagerLike,
  OidcCreateUserInput,
  OidcEnvConfig,
  OidcLogger,
  OidcMaskedConfig,
  OidcServeProfile,
  OidcSessionDeps,
  OidcSettingsConfig,
  OidcUser,
  OidcUserManager,
  OidcUserProfileAccess,
} from './types.js';
