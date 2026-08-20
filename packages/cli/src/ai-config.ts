import type { Database, Statement } from 'better-sqlite3';
import type { CalameDatabase } from './database.js';
import { DEFAULT_TENANT_ID } from './tenancy.js';
import {
  LOCAL_EMBEDDING_MODEL_ID,
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_DEFAULT_LABEL,
} from './rag/local-embedding-meta.js';

export type AiProvider = 'anthropic' | 'openrouter' | 'custom' | 'local';

export type AiCapability = 'chat' | 'embeddings' | 'rerank';

const VALID_CAPABILITIES: ReadonlySet<AiCapability> = new Set(['chat', 'embeddings', 'rerank']);

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export interface AiSetting extends AiConfig {
  name: string;
  label: string;
  /** What this setting can do. undefined = legacy — assume ['chat']. */
  capabilities?: AiCapability[];
  /** Embedding-specific model name. Required when 'embeddings' is in capabilities. */
  embeddingModel?: string;
  /** Discovered at save time by probing the embeddings endpoint. Required for RAG sources. */
  embeddingDimensions?: number;
  /**
   * Reranker model name (e.g. 'rerank-multilingual-v3.0'). Required when
   * 'rerank' is in capabilities. Unlike embeddings, rerankers don't have a
   * fixed output dimension so nothing else needs to be cached.
   */
  rerankModel?: string;
}

export type MaskedAiSetting = AiSetting & { configured: boolean };

/**
 * Returns true if the setting supports the given capability.
 * For backward compatibility, a setting with no capabilities field is assumed
 * to support 'chat' only.
 */
export function settingSupports(setting: AiSetting, capability: AiCapability): boolean {
  if (setting.capabilities === undefined) {
    return capability === 'chat';
  }
  return setting.capabilities.includes(capability);
}

interface AiSettingRow {
  name: string;
  label: string;
  provider: string;
  api_key: string;
  model: string | null;
  base_url: string | null;
  capabilities: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  rerank_model: string | null;
}

const VALID_PROVIDERS: ReadonlySet<AiProvider> = new Set([
  'anthropic',
  'openrouter',
  'custom',
  'local',
]);

function parseCapabilities(raw: string | null): AiCapability[] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const valid = parsed.filter(
      (item): item is AiCapability =>
        typeof item === 'string' && VALID_CAPABILITIES.has(item as AiCapability),
    );
    return valid.length > 0 ? valid : undefined;
  } catch {
    return undefined;
  }
}

function rowToSetting(row: AiSettingRow): AiSetting {
  return {
    name: row.name,
    label: row.label,
    provider: row.provider as AiProvider,
    apiKey: row.api_key,
    model: row.model ?? undefined,
    baseUrl: row.base_url ?? undefined,
    capabilities: parseCapabilities(row.capabilities),
    embeddingModel: row.embedding_model ?? undefined,
    embeddingDimensions: row.embedding_dimensions ?? undefined,
    rerankModel: row.rerank_model ?? undefined,
  };
}

function validateCapabilities(
  provider: AiProvider,
  capabilities: AiCapability[] | undefined,
  embeddingModel: string | undefined,
  rerankModel: string | undefined,
): void {
  if (capabilities === undefined) return;
  for (const cap of capabilities) {
    if (!VALID_CAPABILITIES.has(cap)) {
      throw new Error(`Unknown capability "${cap}". Valid values: chat, embeddings, rerank.`);
    }
  }
  if (capabilities.includes('embeddings') && !embeddingModel) {
    throw new Error('embeddingModel is required when capabilities includes "embeddings".');
  }
  if (capabilities.includes('rerank') && !rerankModel) {
    throw new Error('rerankModel is required when capabilities includes "rerank".');
  }
  // The local model is embeddings-only — it's not an LLM (no chat) and has
  // no reranking head. Enforced here rather than left implicit so a bad
  // request fails clearly instead of silently registering a local setting
  // that later fails in confusing ways when something tries to chat with it.
  if (provider === 'local' && (capabilities.length !== 1 || capabilities[0] !== 'embeddings')) {
    throw new Error(
      `The "local" provider only supports the "embeddings" capability, got [${capabilities.join(', ')}].`,
    );
  }
}

function serializeCapabilities(capabilities: AiCapability[] | undefined): string | null {
  if (capabilities === undefined) return null;
  return JSON.stringify(capabilities);
}

function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length > 8) return key.substring(0, 6) + '***' + key.substring(key.length - 4);
  return '***';
}

function isSettingConfigured(s: AiSetting): boolean {
  // Local runs on-device with no API key or base URL — it's always
  // "configured" from the DB's point of view. Whether the model files are
  // actually staged on disk is a separate, runtime-only concern (surfaced as
  // `localModelAvailable` in the API response — see routes/ai-settings.ts),
  // deliberately not checked here so this function stays filesystem-free.
  if (s.provider === 'local') return true;
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
    // Phase B multi-tenancy: every read binds `tenant_id`. Callers that
    // do not pass a tenant land on the literal default — that preserves
    // the Phase A behaviour for boot-time consumers (the host wires the
    // manager at boot, before any request is available) while letting
    // request handlers thread the resolved tenant through explicitly.
    this.stmtList = this.db.prepare(
      `SELECT * FROM ai_settings WHERE tenant_id = ? ORDER BY created_at ASC, name ASC`,
    );
    this.stmtGet = this.db.prepare(`SELECT * FROM ai_settings WHERE name = ? AND tenant_id = ?`);
    this.stmtInsert = this.db.prepare(
      // The INSERT carries `tenant_id` explicitly. Callers pass the
      // request-resolved tenant in; legacy call sites that don't yet
      // surface a request fall back to DEFAULT_TENANT_ID.
      `INSERT INTO ai_settings (name, label, provider, api_key, model, base_url, capabilities,
                                embedding_model, embedding_dimensions, rerank_model, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtUpdate = this.db.prepare(
      `UPDATE ai_settings SET label = ?, provider = ?, api_key = ?, model = ?, base_url = ?,
       capabilities = ?, embedding_model = ?, embedding_dimensions = ?, rerank_model = ?
       WHERE name = ? AND tenant_id = ?`,
    );
    this.stmtDelete = this.db.prepare(`DELETE FROM ai_settings WHERE name = ? AND tenant_id = ?`);
  }

  /** No-op — kept for backward compatibility. */
  async load(): Promise<void> {}
  /** No-op — kept for backward compatibility. */
  async save(): Promise<void> {}

  /**
   * List every AI setting visible to the supplied tenant. Defaults to
   * the literal `'default'` so background consumers (boot-time wiring,
   * RAG pipeline construction) keep seeing the historic row set.
   */
  listSettings(tenantId: string = DEFAULT_TENANT_ID): AiSetting[] {
    return (this.stmtList.all(tenantId) as AiSettingRow[]).map(rowToSetting);
  }

  getSetting(name: string, tenantId: string = DEFAULT_TENANT_ID): AiSetting | null {
    const row = this.stmtGet.get(name, tenantId) as AiSettingRow | undefined;
    return row ? rowToSetting(row) : null;
  }

  listMaskedSettings(tenantId: string = DEFAULT_TENANT_ID): MaskedAiSetting[] {
    return this.listSettings(tenantId).map(maskSetting);
  }

  getMaskedSetting(name: string, tenantId: string = DEFAULT_TENANT_ID): MaskedAiSetting | null {
    const s = this.getSetting(name, tenantId);
    return s ? maskSetting(s) : null;
  }

  createSetting(setting: AiSetting, tenantId: string = DEFAULT_TENANT_ID): void {
    if (!VALID_PROVIDERS.has(setting.provider)) throw new Error('Invalid provider.');
    if (!setting.name) throw new Error('Setting name is required.');
    if (!setting.label) throw new Error('Setting label is required.');
    if (this.getSetting(setting.name, tenantId)) {
      throw new Error(`Setting "${setting.name}" already exists.`);
    }
    validateCapabilities(
      setting.provider,
      setting.capabilities,
      setting.embeddingModel,
      setting.rerankModel,
    );
    this.stmtInsert.run(
      setting.name,
      setting.label,
      setting.provider,
      setting.apiKey,
      setting.model ?? null,
      setting.baseUrl ?? null,
      serializeCapabilities(setting.capabilities),
      setting.embeddingModel ?? null,
      setting.embeddingDimensions ?? null,
      setting.rerankModel ?? null,
      tenantId,
    );
  }

  updateSetting(
    name: string,
    partial: Partial<Omit<AiSetting, 'name'>>,
    tenantId: string = DEFAULT_TENANT_ID,
  ): void {
    const current = this.getSetting(name, tenantId);
    if (!current) throw new Error(`Setting "${name}" does not exist.`);
    const next: AiSetting = {
      ...current,
      ...partial,
      name: current.name,
    };
    if (!VALID_PROVIDERS.has(next.provider)) throw new Error('Invalid provider.');
    validateCapabilities(next.provider, next.capabilities, next.embeddingModel, next.rerankModel);
    this.stmtUpdate.run(
      next.label,
      next.provider,
      next.apiKey,
      next.model ?? null,
      next.baseUrl ?? null,
      serializeCapabilities(next.capabilities),
      next.embeddingModel ?? null,
      next.embeddingDimensions ?? null,
      next.rerankModel ?? null,
      name,
      tenantId,
    );
  }

  deleteSetting(name: string, tenantId: string = DEFAULT_TENANT_ID): void {
    this.stmtDelete.run(name, tenantId);
  }

  isConfigured(tenantId: string = DEFAULT_TENANT_ID): boolean {
    return this.listSettings(tenantId).some(isSettingConfigured);
  }

  // ---------- Backward-compat shims ----------

  /** Returns the first setting as a legacy AiConfig (used by callers that don't yet know about multi-settings). */
  getConfig(tenantId: string = DEFAULT_TENANT_ID): AiConfig | null {
    const first = this.listSettings(tenantId)[0];
    if (!first) return null;
    const { provider, apiKey, model, baseUrl } = first;
    return { provider, apiKey, model, baseUrl };
  }

  /** Legacy single-config setter — upserts a setting named 'default'. */
  async setConfig(config: AiConfig, tenantId: string = DEFAULT_TENANT_ID): Promise<void> {
    const existing = this.getSetting('default', tenantId);
    if (existing) {
      this.updateSetting('default', config, tenantId);
    } else {
      this.createSetting({ name: 'default', label: 'Default', ...config }, tenantId);
    }
  }

  /** Returns the legacy single-config view (first setting, masked). */
  getMaskedConfig(
    tenantId: string = DEFAULT_TENANT_ID,
  ): (AiConfig & { configured: boolean }) | null {
    const first = this.listMaskedSettings(tenantId)[0];
    if (!first) return null;
    const { provider, apiKey, model, baseUrl, configured } = first;
    return { provider, apiKey, model, baseUrl, configured };
  }
}

/** @deprecated Use AiSettingsManager directly. Kept as an alias for transitional code. */
export const AiConfigManager = AiSettingsManager;
export type AiConfigManagerType = AiSettingsManager;

// ---------------------------------------------------------------------------
// Built-in local embedding setting — seeds the bundled EmbeddingGemma-300M
// provider so RAG works with zero configuration. See migration v17 in
// migration.ts (runs once per DB, on upgrade/fresh-install) and
// ensureBuiltInSettings below (runs on every boot, unconditionally, so a
// user who deletes the row via direct SQL access outside the app gets it
// back).
// ---------------------------------------------------------------------------

/** Preferred name for the built-in local setting — see seedBuiltInLocalSetting for the fallback. */
export const BUILT_IN_LOCAL_SETTING_NAME = 'local';
/** Used instead when a pre-existing row is already named 'local' with a different provider. */
export const BUILT_IN_LOCAL_SETTING_FALLBACK_NAME = 'calame-local';

/**
 * Idempotently INSERT the built-in local embedding setting if it (or a
 * same-named conflicting row) isn't already present for `tenantId`. Shared by
 * migration v17 and {@link ensureBuiltInSettings} so both stay in lockstep —
 * there is exactly one place this row's shape is defined.
 *
 * Never overwrites an existing row: if a row named 'local' already exists
 * with a DIFFERENT provider (a user could plausibly have named their own
 * custom setting 'local' before this feature existed), the built-in setting
 * is seeded under {@link BUILT_IN_LOCAL_SETTING_FALLBACK_NAME} instead. Every
 * consumer must therefore resolve the built-in row by `provider === 'local'`
 * (see {@link findBuiltInLocalSetting}), never by assuming the literal name
 * 'local'.
 *
 * Single-tenant only by construction — `ai_settings`'s primary key is `name`
 * alone (even after the v12 tenant_id column, whose index is non-unique), so
 * only one row of a given name can exist process-wide regardless of tenant.
 * Seeding for every tenant would collide. Acceptable today: the desktop
 * product this feature ships for is single-tenant. TODO: revisit once/if the
 * PK is promoted to `(tenant_id, name)`.
 */
function seedBuiltInLocalSetting(
  raw: Database,
  tenantId: string,
  log?: { warn: (msg: string) => void },
): void {
  const existing = raw
    .prepare(`SELECT provider FROM ai_settings WHERE name = ? AND tenant_id = ?`)
    .get(BUILT_IN_LOCAL_SETTING_NAME, tenantId) as { provider: string } | undefined;

  const conflicting = existing !== undefined && existing.provider !== 'local';
  const name = conflicting ? BUILT_IN_LOCAL_SETTING_FALLBACK_NAME : BUILT_IN_LOCAL_SETTING_NAME;
  if (conflicting) {
    log?.warn(
      `A pre-existing "ai_settings" row named "${BUILT_IN_LOCAL_SETTING_NAME}" ` +
        `(provider="${existing.provider}") already exists — seeding the built-in local embedding ` +
        `setting under "${name}" instead. Your existing setting was not modified.`,
    );
  }

  raw
    .prepare(
      `INSERT OR IGNORE INTO ai_settings
       (name, label, provider, api_key, model, base_url, capabilities,
        embedding_model, embedding_dimensions, rerank_model, tenant_id)
       VALUES (?, ?, 'local', '', NULL, NULL, '["embeddings"]', ?, ?, NULL, ?)`,
    )
    .run(
      name,
      LOCAL_EMBEDDING_DEFAULT_LABEL,
      LOCAL_EMBEDDING_MODEL_ID,
      LOCAL_EMBEDDING_DIMENSIONS,
      tenantId,
    );
}

/**
 * Ensure the built-in local embedding setting exists for the default tenant.
 * Two call sites share this one idempotent function:
 *  1. Migration v17 (migration.ts) — schema-version-gated, runs once per DB.
 *  2. Every boot, unconditionally (index.ts, after `new CalameDatabase(...)`
 *     — which already ran migrations) — recovers a user who deleted the row
 *     via direct SQL access outside the app; v17 alone can't catch this
 *     since its schema-version guard means it never runs a second time.
 * Cheap (one indexed SELECT + one INSERT OR IGNORE) — safe to call on every boot.
 */
export function ensureBuiltInSettings(
  db: CalameDatabase,
  log?: { warn: (msg: string) => void },
): void {
  seedBuiltInLocalSetting(db.raw, DEFAULT_TENANT_ID, log);
}

/**
 * Resolve the built-in local setting by PROVIDER, never by its literal name —
 * see {@link seedBuiltInLocalSetting}'s fallback-name note for why the name
 * alone isn't a safe assumption.
 */
export function findBuiltInLocalSetting(
  mgr: AiSettingsManager,
  tenantId: string = DEFAULT_TENANT_ID,
): AiSetting | null {
  return mgr.listSettings(tenantId).find((s) => s.provider === 'local') ?? null;
}
