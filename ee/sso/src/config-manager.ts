// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Database, Statement } from 'better-sqlite3';
import type {
  DatabaseLike,
  OidcConfigManagerLike,
  OidcMaskedConfig,
  OidcSettingsConfig,
} from './types.js';

interface OidcConfigRow {
  key: string;
  value: string;
}

interface OidcConfigData {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  groupClaim: string;
  groupToProfile: Record<string, string>;
  autoCreateUsers: boolean;
  claimsToAttributes?: Record<string, string>;
}

export class OidcConfigManager implements OidcConfigManagerLike {
  private db: Database;
  private stmtGet: Statement;
  private stmtUpsert: Statement;

  constructor(database: DatabaseLike) {
    this.db = database.raw;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oidc_config (
        key TEXT PRIMARY KEY DEFAULT 'main',
        value TEXT NOT NULL
      )
    `);

    this.stmtGet = this.db.prepare(`SELECT * FROM oidc_config WHERE key = 'main'`);
    this.stmtUpsert = this.db.prepare(
      `INSERT OR REPLACE INTO oidc_config (key, value) VALUES ('main', ?)`,
    );
  }

  getConfig(): OidcSettingsConfig | null {
    const row = this.stmtGet.get() as OidcConfigRow | undefined;
    if (!row) return null;

    let data: OidcConfigData;
    try {
      data = JSON.parse(row.value) as OidcConfigData;
    } catch {
      return null;
    }

    return {
      enabled: data.enabled ?? false,
      issuerUrl: data.issuerUrl ?? '',
      clientId: data.clientId ?? '',
      clientSecret: data.clientSecret ?? '',
      redirectUri: data.redirectUri ?? '',
      scopes: data.scopes ?? 'openid profile email',
      groupClaim: data.groupClaim ?? 'groups',
      groupToProfile: data.groupToProfile ?? {},
      autoCreateUsers: data.autoCreateUsers ?? true,
      claimsToAttributes: data.claimsToAttributes ?? undefined,
    };
  }

  getMaskedConfig(): OidcMaskedConfig | null {
    const config = this.getConfig();
    if (!config) return null;

    let maskedSecret = config.clientSecret;
    if (maskedSecret && maskedSecret.length > 4) {
      maskedSecret =
        maskedSecret.substring(0, 2) + '***' + maskedSecret.substring(maskedSecret.length - 2);
    } else if (maskedSecret) {
      maskedSecret = '***';
    }

    return { ...config, clientSecret: maskedSecret };
  }

  setConfig(config: OidcSettingsConfig): void {
    let finalClientSecret = config.clientSecret;
    if (finalClientSecret.includes('***')) {
      const existing = this.getConfig();
      finalClientSecret = existing?.clientSecret ?? '';
    }

    const data: OidcConfigData = {
      enabled: config.enabled,
      issuerUrl: config.issuerUrl,
      clientId: config.clientId,
      clientSecret: finalClientSecret,
      redirectUri: config.redirectUri,
      scopes: config.scopes,
      groupClaim: config.groupClaim,
      groupToProfile: config.groupToProfile,
      autoCreateUsers: config.autoCreateUsers,
      claimsToAttributes: config.claimsToAttributes,
    };

    this.stmtUpsert.run(JSON.stringify(data));
  }

  isConfigured(): boolean {
    const config = this.getConfig();
    return !!(config?.enabled && config.issuerUrl && config.clientId);
  }
}
