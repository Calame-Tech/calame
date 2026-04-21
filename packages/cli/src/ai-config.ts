import type { Database, Statement } from 'better-sqlite3';
import type { CalameDatabase } from './database.js';

export interface AiConfig {
  provider: 'anthropic' | 'openrouter' | 'custom';
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/** Row shape returned by better-sqlite3 for ai_config queries. */
interface AiConfigRow {
  key: string;
  provider: string;
  api_key: string;
  model: string | null;
  base_url: string | null;
}

export class AiConfigManager {
  private db: Database;
  private stmtGet: Statement;
  private stmtUpsert: Statement;

  constructor(database: CalameDatabase) {
    this.db = database.raw;

    this.stmtGet = this.db.prepare(`SELECT * FROM ai_config WHERE key = 'main'`);
    this.stmtUpsert = this.db.prepare(
      `INSERT OR REPLACE INTO ai_config (key, provider, api_key, model, base_url)
       VALUES ('main', ?, ?, ?, ?)`,
    );
  }

  /** No-op — kept for backward compatibility. */
  async load(): Promise<void> {}

  /** No-op — kept for backward compatibility. */
  async save(): Promise<void> {}

  getConfig(): AiConfig | null {
    const row = this.stmtGet.get() as AiConfigRow | undefined;
    if (!row) return null;
    return {
      provider: row.provider as AiConfig['provider'],
      apiKey: row.api_key,
      model: row.model ?? undefined,
      baseUrl: row.base_url ?? undefined,
    };
  }

  async setConfig(config: AiConfig): Promise<void> {
    this.stmtUpsert.run(config.provider, config.apiKey, config.model ?? null, config.baseUrl ?? null);
  }

  isConfigured(): boolean {
    const config = this.getConfig();
    if (!config) return false;
    if (config.provider === 'custom') {
      return !!config.baseUrl;
    }
    return !!config.apiKey;
  }

  /** Return config with API key masked for safe display. */
  getMaskedConfig(): (AiConfig & { configured: boolean }) | null {
    const config = this.getConfig();
    if (!config) return null;
    const masked = { ...config, configured: this.isConfigured() };
    if (masked.apiKey) {
      const key = masked.apiKey;
      if (key.length > 8) {
        masked.apiKey = key.substring(0, 6) + '***' + key.substring(key.length - 4);
      } else {
        masked.apiKey = '***';
      }
    }
    return masked;
  }
}
