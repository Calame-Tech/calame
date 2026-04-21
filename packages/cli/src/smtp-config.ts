import type { Database, Statement } from 'better-sqlite3';
import type { CalameDatabase } from './database.js';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  configured: boolean;
}

/** Row shape returned by better-sqlite3 for smtp_config queries. */
interface SmtpConfigRow {
  key: string;
  value: string;
}

/** Stored JSON shape inside smtp_config.value. */
interface SmtpConfigData {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export class SmtpConfigManager {
  private db: Database;
  private stmtGet: Statement;
  private stmtUpsert: Statement;

  constructor(database: CalameDatabase) {
    this.db = database.raw;

    // Create the table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS smtp_config (
        key TEXT PRIMARY KEY DEFAULT 'main',
        value TEXT NOT NULL
      )
    `);

    this.stmtGet = this.db.prepare(`SELECT * FROM smtp_config WHERE key = 'main'`);
    this.stmtUpsert = this.db.prepare(
      `INSERT OR REPLACE INTO smtp_config (key, value) VALUES ('main', ?)`,
    );
  }

  getConfig(): SmtpConfig | null {
    const row = this.stmtGet.get() as SmtpConfigRow | undefined;
    if (!row) return null;

    let data: SmtpConfigData;
    try {
      data = JSON.parse(row.value) as SmtpConfigData;
    } catch {
      return null;
    }

    return {
      host: data.host ?? '',
      port: data.port ?? 587,
      user: data.user ?? '',
      pass: data.pass ?? '',
      from: data.from ?? '',
      configured: !!data.host,
    };
  }

  /** Return config with password masked for safe display. */
  getMaskedConfig(): (Omit<SmtpConfig, 'pass'> & { pass: string }) | null {
    const config = this.getConfig();
    if (!config) return null;

    let maskedPass = config.pass;
    if (maskedPass && maskedPass.length > 4) {
      maskedPass = maskedPass.substring(0, 2) + '***' + maskedPass.substring(maskedPass.length - 2);
    } else if (maskedPass) {
      maskedPass = '***';
    }

    return { ...config, pass: maskedPass };
  }

  setConfig(config: Omit<SmtpConfig, 'configured'>): void {
    // If the password contains '***', it's the masked value from GET — keep the existing pass
    let finalPass = config.pass;
    if (finalPass.includes('***')) {
      const existing = this.getConfig();
      finalPass = existing?.pass ?? '';
    }

    const data: SmtpConfigData = {
      host: config.host,
      port: config.port,
      user: config.user,
      pass: finalPass,
      from: config.from,
    };

    this.stmtUpsert.run(JSON.stringify(data));
  }

  isConfigured(): boolean {
    const config = this.getConfig();
    return !!config?.host;
  }
}
