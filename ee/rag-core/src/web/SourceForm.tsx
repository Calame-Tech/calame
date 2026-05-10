// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useMemo, useState } from 'react';
import type { RagSourceType } from '../types.js';
import type { RagSourcePublic } from '../routes/api-types.js';
import { apiPost, apiPatch, ApiError } from './api.js';

/**
 * Minimal projection of `AiSetting` needed by the embeddings dropdown. The
 * host (packages/web) owns the full type — we accept just the fields we need
 * to keep this package decoupled from the AI Settings module.
 */
export interface AiSettingOption {
  name: string;
  label: string;
  capabilities?: string[];
  embeddingModel?: string;
}

interface SourceFormProps {
  /** Pre-filled values when editing an existing source (API projection — decrypted). */
  initial?: Partial<RagSourcePublic>;
  onSave: (source: RagSourcePublic) => void;
  onCancel: () => void;
  aiSettings: AiSettingOption[];
}

interface SourceTypeMeta {
  value: RagSourceType;
  label: string;
  available: boolean;
}

/**
 * Allowed polling intervals exposed in the UI. Restricting the picker to a
 * fixed enum (rather than a free-form number input) trades flexibility for
 * an unambiguous UX:
 *   - users can't accidentally configure a 1-second poll that DDoSes the
 *     connector,
 *   - the dropdown communicates the available cadences at a glance.
 *
 * The backend Zod schema accepts any integer in [60, 86400], so a future
 * "Custom…" option can be added without a server change.
 */
interface PollingIntervalOption {
  value: number | null;
  label: string;
}

const POLLING_INTERVAL_OPTIONS: readonly PollingIntervalOption[] = [
  { value: null, label: 'Désactivé (sync manuelle uniquement)' },
  { value: 300, label: 'Toutes les 5 minutes' },
  { value: 900, label: 'Toutes les 15 minutes' },
  { value: 3600, label: 'Toutes les heures' },
  { value: 21600, label: 'Toutes les 6 heures' },
  { value: 86400, label: 'Tous les jours' },
];

const SOURCE_TYPES: readonly SourceTypeMeta[] = [
  { value: 'local', label: 'Local (dossier)', available: true },
  { value: 's3', label: 'S3 / R2 / MinIO', available: true },
  { value: 'http', label: 'HTTP / URL', available: true },
  { value: 'gdrive', label: 'Google Drive', available: false },
  { value: 'gsheets', label: 'Google Sheets', available: false },
  { value: 'sharepoint', label: 'SharePoint', available: false },
  { value: 'notion', label: 'Notion', available: false },
  { value: 'git', label: 'Git', available: false },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LocalConfig {
  rootPath: string;
}

interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

interface HttpConfig {
  urls?: string[];
  sitemapUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  allowedHosts?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

/** Split a multi-line textarea value into trimmed, non-empty lines. */
function parseLines(value: string): string[] {
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Same as parseLines, used for glob patterns. */
function parseGlobs(value: string): string[] {
  return parseLines(value);
}

/**
 * Extract the rootPath from the decrypted `config` object returned by the API.
 * Falls back to an empty string so the admin can re-enter the path when the
 * config object is null (decryption failure surfaced via `configError`).
 */
function extractRootPath(config: Record<string, unknown> | null | undefined): string {
  if (!config) return '';
  return typeof config.rootPath === 'string' ? config.rootPath : '';
}

function extractStr(config: Record<string, unknown> | null | undefined, key: string): string {
  if (!config) return '';
  return typeof config[key] === 'string' ? (config[key] as string) : '';
}

function extractBool(config: Record<string, unknown> | null | undefined, key: string): boolean {
  if (!config) return false;
  return config[key] === true;
}

function extractGlobsAsText(
  config: Record<string, unknown> | null | undefined,
  key: string,
): string {
  if (!config) return '';
  const value = config[key];
  if (!Array.isArray(value)) return '';
  return (value as unknown[]).filter((v) => typeof v === 'string').join('\n');
}

/** Validate that a string is a valid http(s) URL. */
function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sub-components (inline — small enough to keep in one file)
// ---------------------------------------------------------------------------

interface FieldLabelProps {
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}

function FieldLabel({ htmlFor, required, children }: FieldLabelProps) {
  return (
    <label htmlFor={htmlFor} className="text-sm text-gray-400">
      {children}
      {required && <span className="text-red-400 ml-0.5">*</span>}
    </label>
  );
}

interface HelperTextProps {
  children: React.ReactNode;
}

function HelperText({ children }: HelperTextProps) {
  return <p className="text-xs text-gray-600 mt-1">{children}</p>;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SourceForm({ initial, onSave, onCancel, aiSettings }: SourceFormProps) {
  const isEditing = Boolean(initial?.id);

  // ---- shared fields ----
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<RagSourceType>(initial?.type ?? 'local');
  const [embeddingSettingName, setEmbeddingSettingName] = useState(
    initial?.embeddingSettingName ?? '',
  );
  // Polling interval — null means "manual sync only". Pre-fill from the
  // existing source on edit so the dropdown shows the saved cadence rather
  // than defaulting back to "off".
  const [pollingIntervalSeconds, setPollingIntervalSeconds] = useState<number | null>(
    initial?.pollingIntervalSeconds ?? null,
  );

  // ---- local fields ----
  const [rootPath, setRootPath] = useState(extractRootPath(initial?.config));

  // ---- s3 fields ----
  const [s3Bucket, setS3Bucket] = useState(extractStr(initial?.config, 'bucket'));
  const [s3Region, setS3Region] = useState(extractStr(initial?.config, 'region'));
  const [s3AccessKeyId, setS3AccessKeyId] = useState(extractStr(initial?.config, 'accessKeyId'));
  // Never pre-fill the secret — show "(unchanged)" placeholder in edit mode.
  const [s3SecretAccessKey, setS3SecretAccessKey] = useState('');
  const [s3Prefix, setS3Prefix] = useState(extractStr(initial?.config, 'prefix'));
  const [s3Endpoint, setS3Endpoint] = useState(extractStr(initial?.config, 'endpoint'));
  const [s3ForcePathStyle, setS3ForcePathStyle] = useState(
    extractBool(initial?.config, 'forcePathStyle'),
  );
  const [s3IncludeGlobs, setS3IncludeGlobs] = useState(
    extractGlobsAsText(initial?.config, 'includeGlobs'),
  );
  const [s3ExcludeGlobs, setS3ExcludeGlobs] = useState(
    extractGlobsAsText(initial?.config, 'excludeGlobs'),
  );
  const [s3ShowAdvanced, setS3ShowAdvanced] = useState(false);

  // ---- http fields ----
  // 'urls' | 'sitemap' — determines which primary input is shown.
  const [httpMode, setHttpMode] = useState<'urls' | 'sitemap'>(
    initial?.config?.sitemapUrl && !initial?.config?.urls ? 'sitemap' : 'urls',
  );
  const [httpUrls, setHttpUrls] = useState(() => {
    const v = initial?.config?.urls;
    if (!Array.isArray(v)) return '';
    return (v as unknown[]).filter((u) => typeof u === 'string').join('\n');
  });
  const [httpSitemapUrl, setHttpSitemapUrl] = useState(extractStr(initial?.config, 'sitemapUrl'));
  const [httpUserAgent, setHttpUserAgent] = useState(extractStr(initial?.config, 'userAgent'));
  const [httpTimeoutMs, setHttpTimeoutMs] = useState<number>(() => {
    const v = initial?.config?.timeoutMs;
    return typeof v === 'number' ? v : 10000;
  });
  const [httpAllowedHosts, setHttpAllowedHosts] = useState(
    extractGlobsAsText(initial?.config, 'allowedHosts'),
  );
  const [httpIncludeGlobs, setHttpIncludeGlobs] = useState(
    extractGlobsAsText(initial?.config, 'includeGlobs'),
  );
  const [httpExcludeGlobs, setHttpExcludeGlobs] = useState(
    extractGlobsAsText(initial?.config, 'excludeGlobs'),
  );
  const [httpShowAdvanced, setHttpShowAdvanced] = useState(false);

  // ---- URL validation for http mode ----
  const httpUrlErrors = useMemo(() => {
    if (httpMode !== 'urls') return [];
    return parseLines(httpUrls).filter((u) => !isValidHttpUrl(u));
  }, [httpMode, httpUrls]);

  // ---- ui state ----
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const embeddingsCapableSettings = useMemo(
    () => aiSettings.filter((s) => s.capabilities?.includes('embeddings')),
    [aiSettings],
  );

  const selectedSetting = useMemo(
    () => aiSettings.find((s) => s.name === embeddingSettingName) ?? null,
    [aiSettings, embeddingSettingName],
  );

  const selectedSettingSupportsEmbeddings = Boolean(
    selectedSetting?.capabilities?.includes('embeddings'),
  );

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  const validate = (): string | null => {
    if (!name.trim()) return 'Le nom de la source est requis.';

    if (type === 'local' && !rootPath.trim()) {
      return 'Le chemin du dossier est requis.';
    }

    if (type === 's3') {
      if (!s3Bucket.trim()) return 'Le nom du bucket S3 est requis.';
      if (!s3Region.trim()) return 'La région S3 est requise.';
      if (!s3AccessKeyId.trim()) return "L'Access Key ID est requis.";
      // In edit mode the secret may be left blank (means "unchanged").
      if (!isEditing && !s3SecretAccessKey) return 'Le Secret Access Key est requis.';
    }

    if (type === 'http') {
      if (httpMode === 'urls') {
        const urls = parseLines(httpUrls);
        if (urls.length === 0) return 'Saisissez au moins une URL.';
        if (httpUrlErrors.length > 0) {
          return `${httpUrlErrors.length} URL(s) invalide(s) — vérifiez le format http(s)://.`;
        }
      }
      if (httpMode === 'sitemap') {
        if (!httpSitemapUrl.trim()) return "L'URL du sitemap est requise.";
        if (!isValidHttpUrl(httpSitemapUrl.trim()))
          return "L'URL du sitemap doit être une URL http(s):// valide.";
      }
    }

    if (!embeddingSettingName) {
      return 'Sélectionnez une configuration IA pour les embeddings.';
    }
    if (!selectedSettingSupportsEmbeddings) {
      return "La configuration IA sélectionnée ne supporte pas les embeddings.";
    }
    return null;
  };

  // ---------------------------------------------------------------------------
  // Payload builders
  // ---------------------------------------------------------------------------

  const buildLocalConfig = (): LocalConfig => ({
    rootPath: rootPath.trim(),
  });

  const buildS3Config = (): S3Config => {
    const config: S3Config = {
      bucket: s3Bucket.trim(),
      region: s3Region.trim(),
      accessKeyId: s3AccessKeyId.trim(),
      // If editing and the user left the field blank, omit it so the backend
      // keeps the existing encrypted value. The PATCH handler merges partial config.
      secretAccessKey: s3SecretAccessKey,
    };
    if (s3Prefix.trim()) config.prefix = s3Prefix.trim();
    if (s3Endpoint.trim()) config.endpoint = s3Endpoint.trim();
    if (s3ForcePathStyle) config.forcePathStyle = true;
    const ig = parseGlobs(s3IncludeGlobs);
    if (ig.length > 0) config.includeGlobs = ig;
    const eg = parseGlobs(s3ExcludeGlobs);
    if (eg.length > 0) config.excludeGlobs = eg;
    return config;
  };

  const buildHttpConfig = (): HttpConfig => {
    const config: HttpConfig = {};
    if (httpMode === 'urls') {
      const urls = parseLines(httpUrls);
      if (urls.length > 0) config.urls = urls;
    }
    if (httpMode === 'sitemap' && httpSitemapUrl.trim()) {
      config.sitemapUrl = httpSitemapUrl.trim();
    }
    if (httpUserAgent.trim()) config.userAgent = httpUserAgent.trim();
    if (httpTimeoutMs !== 10000) config.timeoutMs = httpTimeoutMs;
    const ah = parseLines(httpAllowedHosts);
    if (ah.length > 0) config.allowedHosts = ah;
    const ig = parseGlobs(httpIncludeGlobs);
    if (ig.length > 0) config.includeGlobs = ig;
    const eg = parseGlobs(httpExcludeGlobs);
    if (eg.length > 0) config.excludeGlobs = eg;
    return config;
  };

  const buildConfig = (): Record<string, unknown> => {
    if (type === 's3') {
      const cfg = buildS3Config();
      // Edit mode + blank secret field: re-inject the existing secret so the
      // PATCH payload (full-replace semantics) doesn't wipe it. The GET
      // returns the decrypted config to the frontend, so `initial.config`
      // already carries the previous secret.
      if (isEditing && !cfg.secretAccessKey) {
        const existing = initial?.config?.['secretAccessKey'];
        if (typeof existing === 'string' && existing.length > 0) {
          return { ...cfg, secretAccessKey: existing } as unknown as Record<string, unknown>;
        }
      }
      return cfg as unknown as Record<string, unknown>;
    }
    if (type === 'http') {
      return buildHttpConfig() as unknown as Record<string, unknown>;
    }
    return buildLocalConfig() as unknown as Record<string, unknown>;
  };

  const buildPayload = () => ({
    name: name.trim(),
    type,
    config: buildConfig(),
    embeddingSettingName,
    // Always include the polling field. On PATCH this ensures a transition
    // from "every 15 min" → "off" (null) actually clears the timer in the
    // scheduler — the route handler keys off `hasOwnProperty` for that.
    pollingIntervalSeconds,
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleSave = async () => {
    setError(null);
    setServerError(null);
    setTestResult(null);
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    try {
      const payload = buildPayload();
      const saved =
        isEditing && initial?.id
          ? await apiPatch<RagSourcePublic>(
              `/api/rag/sources/${encodeURIComponent(initial.id)}`,
              payload,
            )
          : await apiPost<RagSourcePublic>('/api/rag/sources', payload);
      onSave(saved);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(
          "Toutes les sources RAG doivent utiliser le même modèle d'embeddings (dimension fixe). " +
            "Réessaie avec une config IA dont le modèle a la même dimension que les sources existantes.",
        );
        setServerError(err.message);
      } else {
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Échec de l'enregistrement.";
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setError(null);
    setTestResult(null);
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setTesting(true);
    try {
      if (isEditing && initial?.id) {
        // Save current values first so the test runs against them.
        await apiPatch<RagSourcePublic>(
          `/api/rag/sources/${encodeURIComponent(initial.id)}`,
          buildPayload(),
        );
        await apiPost(`/api/rag/sources/${encodeURIComponent(initial.id)}/test`, {});
        setTestResult({ success: true, message: 'Connexion validée.' });
      } else {
        // For a new source there is no id yet; create-then-test.
        const created = await apiPost<RagSourcePublic>('/api/rag/sources', buildPayload());
        try {
          await apiPost(`/api/rag/sources/${encodeURIComponent(created.id)}/test`, {});
          setTestResult({ success: true, message: 'Source créée et connexion validée.' });
        } catch (testErr) {
          const message =
            testErr instanceof ApiError
              ? testErr.message
              : testErr instanceof Error
                ? testErr.message
                : 'Échec du test.';
          setTestResult({
            success: false,
            message: `Source créée, mais test échoué : ${message}`,
          });
        }
        onSave(created);
      }
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Échec du test.';
      setTestResult({ success: false, message });
    } finally {
      setTesting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="card-primary p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="heading-md text-xl">
          {isEditing ? 'Modifier la source' : 'Nouvelle source'}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-gray-400 hover:text-gray-200"
        >
          Fermer
        </button>
      </div>

      {/* Name */}
      <div>
        <FieldLabel htmlFor="rag-source-name" required>
          Nom de la source
        </FieldLabel>
        <input
          id="rag-source-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Documentation produit"
          className="input-editorial w-full text-sm mt-1"
        />
      </div>

      {/* Type */}
      <div>
        <FieldLabel htmlFor="rag-source-type" required>
          Type
        </FieldLabel>
        <select
          id="rag-source-type"
          value={type}
          onChange={(e) => setType(e.target.value as RagSourceType)}
          disabled={isEditing}
          className="input-editorial w-full text-sm mt-1 disabled:opacity-60"
        >
          {SOURCE_TYPES.map((t) => (
            <option key={t.value} value={t.value} disabled={!t.available} className="bg-gray-800">
              {t.label}
              {!t.available ? ' — Bientôt' : ''}
            </option>
          ))}
        </select>
        {isEditing && (
          <p className="text-xs text-gray-600 mt-1">
            Le type d'une source ne peut pas être modifié après création.
          </p>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Local config                                                         */}
      {/* ------------------------------------------------------------------ */}
      {type === 'local' && (
        <div>
          <FieldLabel htmlFor="rag-source-rootpath" required>
            Chemin absolu du dossier
          </FieldLabel>
          <div className="flex items-center gap-2 mt-1">
            <input
              id="rag-source-rootpath"
              type="text"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="/data/kb/produit"
              className="input-editorial flex-1 text-sm"
            />
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testing || saving}
              className="px-3 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
            >
              {testing ? 'Test…' : 'Tester'}
            </button>
          </div>
          <HelperText>
            Le serveur doit pouvoir lire ce chemin. Les fichiers ajoutés ultérieurement sont indexés
            à la prochaine synchronisation.
          </HelperText>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* S3 / R2 / MinIO config                                               */}
      {/* ------------------------------------------------------------------ */}
      {type === 's3' && (
        <div className="space-y-4">
          {/* Required fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <FieldLabel htmlFor="s3-bucket" required>
                Bucket
              </FieldLabel>
              <input
                id="s3-bucket"
                type="text"
                value={s3Bucket}
                onChange={(e) => setS3Bucket(e.target.value)}
                placeholder="my-knowledge-bucket"
                className="input-editorial w-full text-sm mt-1"
                autoComplete="off"
              />
            </div>
            <div>
              <FieldLabel htmlFor="s3-region" required>
                Région
              </FieldLabel>
              <input
                id="s3-region"
                type="text"
                value={s3Region}
                onChange={(e) => setS3Region(e.target.value)}
                placeholder="us-east-1"
                className="input-editorial w-full text-sm mt-1"
                autoComplete="off"
              />
              <HelperText>Utilisez 'auto' pour Cloudflare R2.</HelperText>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <FieldLabel htmlFor="s3-access-key-id" required>
                Access Key ID
              </FieldLabel>
              <input
                id="s3-access-key-id"
                type="text"
                value={s3AccessKeyId}
                onChange={(e) => setS3AccessKeyId(e.target.value)}
                placeholder="AKIAIOSFODNN7EXAMPLE"
                className="input-editorial w-full text-sm mt-1"
                autoComplete="off"
              />
            </div>
            <div>
              <FieldLabel htmlFor="s3-secret-access-key" required={!isEditing}>
                Secret Access Key
              </FieldLabel>
              <input
                id="s3-secret-access-key"
                type="password"
                value={s3SecretAccessKey}
                onChange={(e) => setS3SecretAccessKey(e.target.value)}
                placeholder={isEditing ? '(inchangé)' : '••••••••••••••••••••'}
                className="input-editorial w-full text-sm mt-1"
                autoComplete="new-password"
              />
              {isEditing && (
                <HelperText>Laissez vide pour conserver la clé existante.</HelperText>
              )}
            </div>
          </div>

          {/* Advanced section */}
          <div className="border border-white/5 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setS3ShowAdvanced((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-gray-400 hover:text-gray-300 hover:bg-white/[0.03] transition-colors"
              aria-expanded={s3ShowAdvanced}
            >
              <span className="font-medium">Avancé (optionnel)</span>
              <span aria-hidden="true" className="text-gray-600">
                {s3ShowAdvanced ? '▲' : '▼'}
              </span>
            </button>

            {s3ShowAdvanced && (
              <div className="px-3 pb-4 pt-1 space-y-3 border-t border-white/5">
                <div>
                  <FieldLabel htmlFor="s3-prefix">Préfixe (racine logique)</FieldLabel>
                  <input
                    id="s3-prefix"
                    type="text"
                    value={s3Prefix}
                    onChange={(e) => setS3Prefix(e.target.value)}
                    placeholder="docs/"
                    className="input-editorial w-full text-sm mt-1"
                  />
                  <HelperText>Racine logique dans le bucket. Laisser vide pour tout le bucket.</HelperText>
                </div>

                <div>
                  <FieldLabel htmlFor="s3-endpoint">Endpoint personnalisé</FieldLabel>
                  <input
                    id="s3-endpoint"
                    type="text"
                    value={s3Endpoint}
                    onChange={(e) => setS3Endpoint(e.target.value)}
                    placeholder="https://<account>.r2.cloudflarestorage.com"
                    className="input-editorial w-full text-sm mt-1"
                  />
                  <HelperText>Pour R2 / MinIO. Laisser vide pour AWS S3 standard.</HelperText>
                </div>

                <div className="flex items-start gap-2 pt-1">
                  <input
                    id="s3-force-path-style"
                    type="checkbox"
                    checked={s3ForcePathStyle}
                    onChange={(e) => setS3ForcePathStyle(e.target.checked)}
                    className="mt-0.5 accent-os-500 focus:ring-2 focus:ring-os-500"
                  />
                  <label htmlFor="s3-force-path-style" className="text-sm text-gray-400 select-none">
                    Force path-style
                    <HelperText>Requis pour MinIO. Désactiver pour AWS S3 et Cloudflare R2.</HelperText>
                  </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <FieldLabel htmlFor="s3-include-globs">Include globs</FieldLabel>
                    <textarea
                      id="s3-include-globs"
                      value={s3IncludeGlobs}
                      onChange={(e) => setS3IncludeGlobs(e.target.value)}
                      placeholder={'**/*.md\n**/*.pdf'}
                      rows={3}
                      className="input-editorial w-full text-sm mt-1 font-mono-plex resize-y"
                    />
                    <HelperText>Une glob par ligne. Vide = tout inclure.</HelperText>
                  </div>
                  <div>
                    <FieldLabel htmlFor="s3-exclude-globs">Exclude globs</FieldLabel>
                    <textarea
                      id="s3-exclude-globs"
                      value={s3ExcludeGlobs}
                      onChange={(e) => setS3ExcludeGlobs(e.target.value)}
                      placeholder={'**/node_modules/**\n**/.git/**'}
                      rows={3}
                      className="input-editorial w-full text-sm mt-1 font-mono-plex resize-y"
                    />
                    <HelperText>Une glob par ligne.</HelperText>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Test button */}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testing || saving}
              className="px-3 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
            >
              {testing ? 'Test…' : 'Tester la connexion'}
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* HTTP / URL config                                                    */}
      {/* ------------------------------------------------------------------ */}
      {type === 'http' && (
        <div className="space-y-4">
          {/* Mode picker */}
          <div>
            <fieldset>
              <legend className="text-sm text-gray-400 mb-2">
                Mode d'indexation <span className="text-red-400">*</span>
              </legend>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-gray-300">
                  <input
                    type="radio"
                    name="http-mode"
                    value="urls"
                    checked={httpMode === 'urls'}
                    onChange={() => setHttpMode('urls')}
                    className="accent-os-500"
                  />
                  Liste d'URLs fixe
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-gray-300">
                  <input
                    type="radio"
                    name="http-mode"
                    value="sitemap"
                    checked={httpMode === 'sitemap'}
                    onChange={() => setHttpMode('sitemap')}
                    className="accent-os-500"
                  />
                  Sitemap XML
                </label>
              </div>
            </fieldset>
          </div>

          {/* URLs textarea */}
          {httpMode === 'urls' && (
            <div>
              <FieldLabel htmlFor="http-urls" required>
                URLs à indexer
              </FieldLabel>
              <textarea
                id="http-urls"
                value={httpUrls}
                onChange={(e) => setHttpUrls(e.target.value)}
                placeholder={'https://docs.exemple.com/guide\nhttps://docs.exemple.com/api'}
                rows={5}
                className={`input-editorial w-full text-sm mt-1 font-mono-plex resize-y ${
                  httpUrlErrors.length > 0 ? 'border-red-600/60' : ''
                }`}
              />
              {httpUrlErrors.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {httpUrlErrors.map((url) => (
                    <p key={url} className="text-xs text-red-400 font-mono-plex">
                      URL invalide : {url}
                    </p>
                  ))}
                </div>
              )}
              <HelperText>Une URL http(s):// par ligne.</HelperText>
            </div>
          )}

          {/* Sitemap URL */}
          {httpMode === 'sitemap' && (
            <div>
              <FieldLabel htmlFor="http-sitemap-url" required>
                URL du sitemap
              </FieldLabel>
              <input
                id="http-sitemap-url"
                type="text"
                value={httpSitemapUrl}
                onChange={(e) => setHttpSitemapUrl(e.target.value)}
                placeholder="https://docs.exemple.com/sitemap.xml"
                className="input-editorial w-full text-sm mt-1"
              />
              <HelperText>
                Le connecteur fetche le XML et indexe chaque entrée &lt;loc&gt;.
              </HelperText>
            </div>
          )}

          {/* Common fields (always visible) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <FieldLabel htmlFor="http-user-agent">User-Agent</FieldLabel>
              <input
                id="http-user-agent"
                type="text"
                value={httpUserAgent}
                onChange={(e) => setHttpUserAgent(e.target.value)}
                placeholder="CalameRAG/1.0"
                className="input-editorial w-full text-sm mt-1"
              />
              <HelperText>Envoyé dans chaque requête HTTP.</HelperText>
            </div>
            <div>
              <FieldLabel htmlFor="http-timeout">Timeout (ms)</FieldLabel>
              <input
                id="http-timeout"
                type="number"
                value={httpTimeoutMs}
                min={1000}
                max={60000}
                step={1000}
                onChange={(e) => setHttpTimeoutMs(Number(e.target.value))}
                className="input-editorial w-full text-sm mt-1"
              />
              <HelperText>Min 1 000 ms, max 60 000 ms. Défaut : 10 000.</HelperText>
            </div>
          </div>

          {/* Advanced section */}
          <div className="border border-white/5 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setHttpShowAdvanced((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-gray-400 hover:text-gray-300 hover:bg-white/[0.03] transition-colors"
              aria-expanded={httpShowAdvanced}
            >
              <span className="font-medium">Avancé (filtres, sécurité)</span>
              <span aria-hidden="true" className="text-gray-600">
                {httpShowAdvanced ? '▲' : '▼'}
              </span>
            </button>

            {httpShowAdvanced && (
              <div className="px-3 pb-4 pt-1 space-y-3 border-t border-white/5">
                <div>
                  <FieldLabel htmlFor="http-allowed-hosts">Hosts autorisés</FieldLabel>
                  <textarea
                    id="http-allowed-hosts"
                    value={httpAllowedHosts}
                    onChange={(e) => setHttpAllowedHosts(e.target.value)}
                    placeholder={'docs.exemple.com\nblog.exemple.com'}
                    rows={3}
                    className="input-editorial w-full text-sm mt-1 font-mono-plex resize-y"
                  />
                  <HelperText>
                    Allowlist de sécurité. Laisser vide pour autoriser tous les hosts des URLs
                    indexées. Protège contre les docIds malicieux.
                  </HelperText>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <FieldLabel htmlFor="http-include-globs">Include globs (pathname)</FieldLabel>
                    <textarea
                      id="http-include-globs"
                      value={httpIncludeGlobs}
                      onChange={(e) => setHttpIncludeGlobs(e.target.value)}
                      placeholder={'/docs/**\n/blog/**'}
                      rows={3}
                      className="input-editorial w-full text-sm mt-1 font-mono-plex resize-y"
                    />
                    <HelperText>Appliqués au pathname de l'URL. Vide = tout inclure.</HelperText>
                  </div>
                  <div>
                    <FieldLabel htmlFor="http-exclude-globs">Exclude globs (pathname)</FieldLabel>
                    <textarea
                      id="http-exclude-globs"
                      value={httpExcludeGlobs}
                      onChange={(e) => setHttpExcludeGlobs(e.target.value)}
                      placeholder={'/private/**\n/admin/**'}
                      rows={3}
                      className="input-editorial w-full text-sm mt-1 font-mono-plex resize-y"
                    />
                    <HelperText>Une glob par ligne.</HelperText>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Test button */}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testing || saving}
              className="px-3 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
            >
              {testing ? 'Test…' : 'Tester la connexion'}
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Embeddings AI setting                                                */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <FieldLabel htmlFor="rag-source-embedding" required>
          Configuration d'embeddings
        </FieldLabel>
        {aiSettings.length === 0 ? (
          <p className="text-xs text-amber-400 mt-1">
            Aucune configuration IA enregistrée. Créez-en une dans la section "AI Settings" avec la
            capacité <span className="font-mono-plex">embeddings</span>.
          </p>
        ) : (
          <select
            id="rag-source-embedding"
            value={embeddingSettingName}
            onChange={(e) => setEmbeddingSettingName(e.target.value)}
            className="input-editorial w-full text-sm mt-1"
          >
            <option value="" className="bg-gray-800">
              Sélectionner une configuration IA…
            </option>
            {aiSettings.map((s) => {
              const supports = s.capabilities?.includes('embeddings');
              return (
                <option
                  key={s.name}
                  value={s.name}
                  disabled={!supports}
                  title={supports ? undefined : 'Cette config IA ne supporte pas les embeddings'}
                  className="bg-gray-800"
                >
                  {s.label}
                  {supports
                    ? s.embeddingModel
                      ? ` — ${s.embeddingModel}`
                      : ''
                    : ' — embeddings non supportés'}
                </option>
              );
            })}
          </select>
        )}
        {embeddingsCapableSettings.length === 0 && aiSettings.length > 0 && (
          <p className="text-xs text-amber-400 mt-1">
            Aucune configuration IA disponible ne supporte les embeddings. Activez la capacité
            <span className="font-mono-plex"> embeddings</span> sur l'une de vos configurations.
          </p>
        )}
        {selectedSetting && selectedSettingSupportsEmbeddings && (
          <div className="flex items-center gap-4 mt-1">
            <p className="text-xs text-gray-500">
              Modèle :{' '}
              <span className="font-mono-plex text-gray-400">
                {selectedSetting.embeddingModel ?? '(non spécifié)'}
              </span>
            </p>
            {initial?.embeddingDimensions !== undefined && (
              <p className="text-xs text-gray-500">
                Dimension :{' '}
                <span className="font-mono-plex text-gray-400">
                  {initial.embeddingDimensions} tokens
                </span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Polling interval (auto-sync)                                         */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <FieldLabel htmlFor="rag-source-polling">Intervalle de synchronisation auto</FieldLabel>
        <select
          id="rag-source-polling"
          value={pollingIntervalSeconds === null ? '' : String(pollingIntervalSeconds)}
          onChange={(e) => {
            const v = e.target.value;
            setPollingIntervalSeconds(v === '' ? null : Number(v));
          }}
          className="input-editorial w-full text-sm mt-1"
        >
          {POLLING_INTERVAL_OPTIONS.map((opt) => (
            <option
              key={opt.value === null ? 'off' : String(opt.value)}
              value={opt.value === null ? '' : String(opt.value)}
              className="bg-gray-800"
            >
              {opt.label}
            </option>
          ))}
        </select>
        <HelperText>
          Choisissez la fréquence à laquelle la source est interrogée pour détecter les changements.
          La synchronisation manuelle reste toujours disponible.
        </HelperText>
      </div>

      {/* Error / test result banners */}
      {error && (
        <div className="p-2.5 rounded-lg text-sm bg-red-950/30 border border-red-800/50 text-red-400 space-y-1">
          <p>{error}</p>
          {serverError && <p className="text-xs text-red-300 opacity-80">{serverError}</p>}
        </div>
      )}
      {testResult && (
        <div
          className={`p-2.5 rounded-lg text-sm ${
            testResult.success
              ? 'bg-green-950/30 border border-green-800/50 text-green-400'
              : 'bg-red-950/30 border border-red-800/50 text-red-400'
          }`}
        >
          {testResult.message}
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50 shadow-md shadow-os-900/20"
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}
