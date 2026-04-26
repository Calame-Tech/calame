import type { Database, Statement } from 'better-sqlite3';
import type { CalameDatabase } from './database.js';

export type AiProvider = 'anthropic' | 'openrouter' | 'custom';

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export interface AiSetting extends AiConfig {
  name: string;
  label: string;
}

export type MaskedAiSetting = AiSetting & { configured: boolean };

interface AiSettingRow {
  name: string;
  label: string;
  provider: string;
  api_key: string;
  model: string | null;
  base_url: string | null;
}

const VALID_PROVIDERS: ReadonlySet<AiProvider> = new Set(['anthropic', 'openrouter', 'custom']);

function rowToSetting(row: AiSettingRow): AiSetting {
  return {
    name: row.name,
    label: row.label,
    provider: row.provider as AiProvider,
    apiKey: row.api_key,
    model: row.model ?? undefined,
    baseUrl: row.base_url ?? undefined,
  };
}

function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length > 8) return key.substring(0, 6) + '***' + key.substring(key.length - 4);
  return '***';
}

function isSettingConfigured(s: AiSetting): boolean {
  if (s.provider === 'custom') return !!s.baseUrl;
  return !!s.apiKey;
}

function maskSetting(s: AiSetting): MaskedAiSetting {
  return { ...s, apiKey: maskApiKey(s.apiKey), configured: isSettingConfigured(s) };
}

export class AiSettingsManager {
  private db: Database;
  private stmtList: Statement;
  private stmtGet: Statement;
  private stmtInsert: Statement;
  private stmtUpdate: Statement;
  private stmtDelete: Statement;

  constructor(database: CalameDatabase) {
    this.db = database.raw;
    this.stmtList = this.db.prepare(`SELECT * FROM ai_settings ORDER BY created_at ASC, name ASC`);
    this.stmtGet = this.db.prepare(`SELECT * FROM ai_settings WHERE name = ?`);
    this.stmtInsert = this.db.prepare(
      `INSERT INTO ai_settings (name, label, provider, api_key, model, base_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmtUpdate = this.db.prepare(
      `UPDATE ai_settings SET label = ?, provider = ?, api_key = ?, model = ?, base_url = ?
       WHERE name = ?`,
    );
    this.stmtDelete = this.db.prepare(`DELETE FROM ai_settings WHERE name = ?`);
  }

  /** No-op — kept for backward compatibility. */
  async load(): Promise<void> {}
  /** No-op — kept for backward compatibility. */
  async save(): Promise<void> {}

  listSettings(): AiSetting[] {
    return (this.stmtList.all() as AiSettingRow[]).map(rowToSetting);
  }

  getSetting(name: string): AiSetting | null {
    const row = this.stmtGet.get(name) as AiSettingRow | undefined;
    return row ? rowToSetting(row) : null;
  }

  listMaskedSettings(): MaskedAiSetting[] {
    return this.listSettings().map(maskSetting);
  }

  getMaskedSetting(name: string): MaskedAiSetting | null {
    const s = this.getSetting(name);
    return s ? maskSetting(s) : null;
  }

  createSetting(setting: AiSetting): void {
    if (!VALID_PROVIDERS.has(setting.provider)) throw new Error('Invalid provider.');
    if (!setting.name) throw new Error('Setting name is required.');
    if (!setting.label) throw new Error('Setting label is required.');
    if (this.getSetting(setting.name)) throw new Error(`Setting "${setting.name}" already exists.`);
    this.stmtInsert.run(
      setting.name,
      setting.label,
      setting.provider,
      setting.apiKey,
      setting.model ?? null,
      setting.baseUrl ?? null,
    );
  }

  updateSetting(name: string, partial: Partial<Omit<AiSetting, 'name'>>): void {
    const current = this.getSetting(name);
    if (!current) throw new Error(`Setting "${name}" does not exist.`);
    const next: AiSetting = {
      ...current,
      ...partial,
      name: current.name,
    };
    if (!VALID_PROVIDERS.has(next.provider)) throw new Error('Invalid provider.');
    this.stmtUpdate.run(
      next.label,
      next.provider,
      next.apiKey,
      next.model ?? null,
      next.baseUrl ?? null,
      name,
    );
  }

  deleteSetting(name: string): void {
    this.stmtDelete.run(name);
  }

  isConfigured(): boolean {
    return this.listSettings().some(isSettingConfigured);
  }

  // ---------- Backward-compat shims ----------

  /** Returns the first setting as a legacy AiConfig (used by callers that don't yet know about multi-settings). */
  getConfig(): AiConfig | null {
    const first = this.listSettings()[0];
    if (!first) return null;
    const { provider, apiKey, model, baseUrl } = first;
    return { provider, apiKey, model, baseUrl };
  }

  /** Legacy single-config setter — upserts a setting named 'default'. */
  async setConfig(config: AiConfig): Promise<void> {
    const existing = this.getSetting('default');
    if (existing) {
      this.updateSetting('default', config);
    } else {
      this.createSetting({ name: 'default', label: 'Default', ...config });
    }
  }

  /** Returns the legacy single-config view (first setting, masked). */
  getMaskedConfig(): (AiConfig & { configured: boolean }) | null {
    const first = this.listMaskedSettings()[0];
    if (!first) return null;
    const { provider, apiKey, model, baseUrl, configured } = first;
    return { provider, apiKey, model, baseUrl, configured };
  }
}

/** @deprecated Use AiSettingsManager directly. Kept as an alias for transitional code. */
export const AiConfigManager = AiSettingsManager;
export type AiConfigManagerType = AiSettingsManager;
