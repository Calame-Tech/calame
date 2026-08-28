import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'use-intl/react';
import { apiFetch } from '../lib/api.js';
import HelpTip from './HelpTip.js';

type Provider = 'anthropic' | 'openrouter' | 'custom' | 'local';
type ClassifierProvider = 'anthropic' | 'openrouter' | 'custom';
type AiCapability = 'chat' | 'embeddings' | 'rerank';

/**
 * The bundled local embedding model's fixed identity — mirrors
 * packages/cli/src/rag/local-embedding-meta.ts. Never user-editable: the
 * backend's PUT guard for provider==='local' only accepts label changes and
 * silently ignores everything else (see routes/ai-settings.ts), so the form
 * shows this as read-only rather than a text input a user could "change"
 * with no effect.
 */
const LOCAL_MODEL_INFO = {
  embeddingModel: 'embeddinggemma-300m-q4',
  dimensions: 768,
  maxTokens: 2048,
};

interface MaskedAiSetting {
  name: string;
  label: string;
  provider: Provider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  configured: boolean;
  capabilities?: AiCapability[];
  embeddingModel?: string;
  rerankModel?: string;
  embeddingDimensions?: number;
  /** Only present for provider==='local' — whether the bundled model files are actually staged on disk. */
  localModelAvailable?: boolean;
}

interface AiConfigDisplay {
  provider: Provider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  configured: boolean;
  // LLM Router fields (still attached to the legacy single-config payload)
  routerEnabled?: boolean;
  classifierProvider?: ClassifierProvider;
  classifierModel?: string;
  classifierApiKey?: string;
  classifierEndpoint?: string;
  injectionThreshold?: number;
}

interface PerProviderFields {
  apiKey: string;
  model: string;
  baseUrl: string;
}

const emptyFields: PerProviderFields = { apiKey: '', model: '', baseUrl: '' };
const emptyPerProvider = (): Record<Provider, PerProviderFields> => ({
  anthropic: { ...emptyFields },
  openrouter: { ...emptyFields },
  custom: { ...emptyFields },
  local: { ...emptyFields },
});

/** Sentinel value for `editingName` meaning "create a new setting". */
const NEW_SENTINEL = '__new__';

/** Slug-style validation (must match the backend NAME_RE). */
const SLUG_RE = /^[a-z0-9_-]{1,64}$/;

export default function AiSettings() {
  const t = useTranslations('aiSettings');
  const tCommon = useTranslations('common');

  // List of all AI settings (refreshed after each mutation)
  const [settings, setSettings] = useState<MaskedAiSetting[]>([]);
  const [loading, setLoading] = useState(true);

  // Currently-edited row: a setting name, NEW_SENTINEL for creation, or null for nothing.
  const [editingName, setEditingName] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [perProvider, setPerProvider] =
    useState<Record<Provider, PerProviderFields>>(emptyPerProvider());
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingName, setTestingName] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Capabilities form state (per-setting form — not global)
  const [capChat, setCapChat] = useState(true);
  const [capEmbeddings, setCapEmbeddings] = useState(false);
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [capRerank, setCapRerank] = useState(false);
  const [rerankModel, setRerankModel] = useState('');

  // LLM Router state — global, independent of individual AI settings
  const [routerEnabled, setRouterEnabled] = useState(false);
  const [classifierProvider, setClassifierProvider] = useState<ClassifierProvider>('anthropic');
  const [classifierModel, setClassifierModel] = useState('');
  const [classifierApiKey, setClassifierApiKey] = useState('');
  const [classifierEndpoint, setClassifierEndpoint] = useState('');
  const [injectionThreshold, setInjectionThreshold] = useState(80); // percentage

  const apiKey = perProvider[provider].apiKey;
  const model = perProvider[provider].model;
  const baseUrl = perProvider[provider].baseUrl;

  const isCreating = editingName === NEW_SENTINEL;
  // The setting currently open for editing (undefined while creating or when
  // nothing is open). Used to detect "this is a provider:'local' row" so the
  // form can visually reflect the backend's read-only-except-label guard
  // (see routes/ai-settings.ts's PUT handler) instead of showing controls
  // that would silently no-op on save.
  const editingSetting =
    editingName && !isCreating ? settings.find((s) => s.name === editingName) : undefined;
  const isEditingLocalSetting = editingSetting?.provider === 'local';

  const updateField = (field: keyof PerProviderFields, value: string) => {
    setPerProvider((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], [field]: value },
    }));
  };

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch('/api/ai-settings', { credentials: 'include' });
      const data = await res.json();
      if (data.success) {
        setSettings((data.settings ?? []) as MaskedAiSetting[]);

        // Restore LLM Router fields from the legacy `config` payload
        const cfg = data.config as AiConfigDisplay | null;
        if (cfg) {
          if (cfg.routerEnabled !== undefined) setRouterEnabled(cfg.routerEnabled);
          if (cfg.classifierProvider) setClassifierProvider(cfg.classifierProvider);
          if (cfg.classifierModel !== undefined) setClassifierModel(cfg.classifierModel);
          if (cfg.classifierApiKey !== undefined) setClassifierApiKey(cfg.classifierApiKey);
          if (cfg.classifierEndpoint !== undefined) setClassifierEndpoint(cfg.classifierEndpoint);
          if (cfg.injectionThreshold !== undefined)
            setInjectionThreshold(Math.round(cfg.injectionThreshold * 100));
        }
      }
    } catch {
      // Ignore — UI shows empty state.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetForm = () => {
    setFormError(null);
    setSaveResult(null);
    setTestResult(null);
  };

  /** Build the capabilities array from the three checkboxes. */
  const buildCapabilities = (): AiCapability[] => {
    const caps: AiCapability[] = [];
    if (capChat) caps.push('chat');
    if (capEmbeddings) caps.push('embeddings');
    if (capRerank) caps.push('rerank');
    return caps;
  };

  const startCreate = () => {
    if (isCreating) {
      setEditingName(null);
      return;
    }
    setEditingName(NEW_SENTINEL);
    setFormName('');
    setFormLabel('');
    setProvider('anthropic');
    setPerProvider(emptyPerProvider());
    setCapChat(true);
    setCapEmbeddings(false);
    setEmbeddingModel('');
    setCapRerank(false);
    setRerankModel('');
    resetForm();
  };

  const startEdit = (s: MaskedAiSetting) => {
    if (editingName === s.name) {
      // Toggle: clicking Edit on the open row closes it.
      setEditingName(null);
      return;
    }
    setEditingName(s.name);
    setFormName(s.name);
    setFormLabel(s.label);
    setProvider(s.provider);
    setPerProvider({
      ...emptyPerProvider(),
      [s.provider]: {
        apiKey: s.apiKey ?? '',
        model: s.model ?? '',
        baseUrl: s.baseUrl ?? '',
      },
    });
    // Restore capabilities — default to ['chat'] if not set (legacy settings).
    const caps = s.capabilities ?? ['chat'];
    setCapChat(caps.includes('chat'));
    setCapEmbeddings(caps.includes('embeddings'));
    setEmbeddingModel(s.embeddingModel ?? '');
    setCapRerank(caps.includes('rerank'));
    setRerankModel(s.rerankModel ?? '');
    resetForm();
  };

  const cancelEdit = () => {
    setEditingName(null);
    resetForm();
  };

  const handleSave = async () => {
    setFormError(null);
    setSaveResult(null);

    if (isCreating) {
      if (!SLUG_RE.test(formName)) {
        setFormError(t('errors.nameFormat'));
        return;
      }
      if (!formLabel.trim()) {
        setFormError(t('errors.labelRequired'));
        return;
      }
    }
    if (provider !== 'custom' && provider !== 'local' && !apiKey) {
      setFormError(t('errors.apiKeyRequired'));
      return;
    }
    if (provider === 'custom' && !baseUrl) {
      setFormError(t('errors.baseUrlRequired'));
      return;
    }
    if (!capChat && !capEmbeddings) {
      setFormError(t('errors.capabilityRequired'));
      return;
    }
    if (capEmbeddings && !embeddingModel.trim()) {
      setFormError(t('errors.embeddingModelRequired'));
      return;
    }
    if (capRerank && !rerankModel.trim()) {
      setFormError(t('errors.rerankModelRequired'));
      return;
    }

    setSaving(true);
    try {
      const capabilities = buildCapabilities();
      const body = {
        name: formName,
        label: formLabel,
        provider,
        apiKey,
        model: model || undefined,
        baseUrl: baseUrl || undefined,
        // Capabilities — tells the backend which features this setting provides.
        capabilities,
        embeddingModel: capEmbeddings ? embeddingModel.trim() || undefined : undefined,
        rerankModel: capRerank ? rerankModel.trim() || undefined : undefined,
        // LLM Router fields are global but still transported here for backward-compat
        routerEnabled,
        classifierProvider: routerEnabled ? classifierProvider : undefined,
        classifierModel: routerEnabled ? classifierModel || undefined : undefined,
        classifierApiKey: routerEnabled ? classifierApiKey || undefined : undefined,
        classifierEndpoint: routerEnabled ? classifierEndpoint || undefined : undefined,
        injectionThreshold: routerEnabled ? injectionThreshold / 100 : undefined,
      };

      const url = isCreating
        ? '/api/ai-settings'
        : `/api/ai-settings/${encodeURIComponent(editingName!)}`;
      const method = isCreating ? 'POST' : 'PUT';
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setSaveResult({ ok: true, message: t('saveResult.saved') });
        await refresh();
        setEditingName(null);
      } else {
        setFormError(data.message || t('errors.failedToSave'));
      }
    } catch {
      setFormError(t('errors.connectionError'));
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult(null), 3000);
    }
  };

  const handleTestForm = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // For an existing setting, save first so the test uses the latest values.
      if (!isCreating && editingName) {
        await apiFetch(`/api/ai-settings/${encodeURIComponent(editingName)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            label: formLabel,
            provider,
            apiKey,
            model: model || undefined,
            baseUrl: baseUrl || undefined,
          }),
        });
        const res = await apiFetch(`/api/ai-settings/${encodeURIComponent(editingName)}/test`, {
          method: 'POST',
          credentials: 'include',
        });
        const data = await res.json();
        setTestResult(
          data.success
            ? { success: true, message: t('testResult.connectionOk', { response: data.response }) }
            : { success: false, message: data.message || t('testResult.testFailed') },
        );
        await refresh();
      } else {
        // No `name` yet → fall back to the legacy single-config endpoint, which writes to 'default'.
        await apiFetch('/api/ai-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            provider,
            apiKey,
            model: model || undefined,
            baseUrl: baseUrl || undefined,
          }),
        });
        // Test the setting we just wrote by name ('default') — NOT the
        // no-name legacy `/test` endpoint, which picks `listSettings()[0]`.
        // That's always the built-in `local` setting (seeded first on every
        // install), so it used to silently test the wrong provider here.
        const res = await apiFetch('/api/ai-settings/default/test', {
          method: 'POST',
          credentials: 'include',
        });
        const data = await res.json();
        setTestResult(
          data.success
            ? { success: true, message: t('testResult.connectionOk', { response: data.response }) }
            : { success: false, message: data.message || t('testResult.testFailed') },
        );
        await refresh();
      }
    } catch {
      setTestResult({ success: false, message: t('errors.connectionError') });
    } finally {
      setTesting(false);
    }
  };

  const handleQuickTest = async (s: MaskedAiSetting) => {
    setTestingName(s.name);
    setTestResult(null);
    try {
      const res = await apiFetch(`/api/ai-settings/${encodeURIComponent(s.name)}/test`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      setTestResult(
        data.success
          ? {
              success: true,
              message: t('quickTest.ok', { label: s.label, response: data.response }),
            }
          : {
              success: false,
              message: t('quickTest.failed', {
                label: s.label,
                message: data.message || t('testResult.testFailed'),
              }),
            },
      );
    } catch {
      setTestResult({
        success: false,
        message: t('quickTest.connectionError', { label: s.label }),
      });
    } finally {
      setTestingName(null);
    }
  };

  const handleDelete = async (s: MaskedAiSetting) => {
    if (!window.confirm(t('confirmDelete', { label: s.label }))) return;
    try {
      await apiFetch(`/api/ai-settings/${encodeURIComponent(s.name)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (editingName === s.name) setEditingName(null);
      await refresh();
    } catch {
      // ignore
    }
  };

  const saveRouterOnly = async () => {
    setSaving(true);
    try {
      const fallback = settings[0];
      await apiFetch('/api/ai-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider: fallback?.provider ?? 'anthropic',
          apiKey: fallback?.apiKey ?? '',
          model: fallback?.model,
          baseUrl: fallback?.baseUrl,
          routerEnabled,
          classifierProvider: routerEnabled ? classifierProvider : undefined,
          classifierModel: routerEnabled ? classifierModel || undefined : undefined,
          classifierApiKey: routerEnabled ? classifierApiKey || undefined : undefined,
          classifierEndpoint: routerEnabled ? classifierEndpoint || undefined : undefined,
          injectionThreshold: routerEnabled ? injectionThreshold / 100 : undefined,
        }),
      });
      setSaveResult({ ok: true, message: t('router.saveResult.saved') });
    } catch {
      setSaveResult({ ok: false, message: t('router.saveResult.failed') });
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult(null), 3000);
    }
  };

  if (loading) {
    return <div className="text-gray-400 text-sm">{t('loading')}</div>;
  }

  const providers: { value: Provider; label: string; desc: string }[] = [
    {
      value: 'local',
      label: t('providers.local.label'),
      desc: t('providers.local.desc'),
    },
    {
      value: 'anthropic',
      label: t('providers.anthropic.label'),
      desc: t('providers.anthropic.desc'),
    },
    {
      value: 'openrouter',
      label: t('providers.openrouter.label'),
      desc: t('providers.openrouter.desc'),
    },
    { value: 'custom', label: t('providers.custom.label'), desc: t('providers.custom.desc') },
  ];

  const renderEditForm = () => (
    <div className="space-y-4 p-4 rounded-lg border border-os-600/40 bg-os-700/5 mt-2">
      <div className="flex items-center justify-between">
        <h3 className="eyebrow">
          {isCreating ? t('form.newTitle') : t('form.editTitle', { name: editingName ?? '' })}
        </h3>
        <button onClick={cancelEdit} className="text-xs text-gray-400 hover:text-gray-200">
          {t('form.close')}
        </button>
      </div>

      {/* Identity */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm text-gray-400">
            {t('form.nameLabel')} <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={!isCreating}
            placeholder={t('form.namePlaceholder')}
            className="input-editorial w-full text-sm mt-1 disabled:opacity-60"
          />
          <p className="text-xs text-gray-600 mt-1">{t('form.nameHelp')}</p>
        </div>
        <div>
          <label className="text-sm text-gray-400">
            {t('form.labelLabel')} <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={formLabel}
            onChange={(e) => setFormLabel(e.target.value)}
            placeholder={t('form.labelPlaceholder')}
            className="input-editorial w-full text-sm mt-1"
          />
        </div>
      </div>

      {/* Provider selection */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <label className="text-sm text-gray-400">{t('form.providerLabel')}</label>
          <HelpTip content={t('form.providerHelp')} position="right" maxWidth={320} />
        </div>
        {isEditingLocalSetting && (
          <p className="text-xs text-gray-500 mb-2">{t('form.localProviderNote')}</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          {providers.map((p) => (
            <button
              key={p.value}
              disabled={isEditingLocalSetting}
              onClick={() => {
                setProvider(p.value);
                if (p.value === 'local') {
                  setCapChat(false);
                  setCapEmbeddings(true);
                  setCapRerank(false);
                  setEmbeddingModel(LOCAL_MODEL_INFO.embeddingModel);
                  setRerankModel('');
                }
              }}
              className={`px-4 py-3 rounded-lg border text-left transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${
                provider === p.value
                  ? 'border-os-500 bg-os-700/20'
                  : 'border-white/5 bg-gray-900/40 hover:border-white/10'
              }`}
            >
              <div
                className={`text-sm font-medium ${provider === p.value ? 'text-os-400' : 'text-gray-300'}`}
              >
                {p.label}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">{p.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Capabilities section */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <label className="text-sm text-gray-400">{t('form.capabilitiesLabel')}</label>
          <HelpTip content={t('form.capabilitiesHelp')} position="right" maxWidth={320} />
        </div>
        <div className="space-y-3 pl-1">
          {/* Chat capability */}
          <div className="flex items-start gap-3">
            <input
              id="cap-chat"
              type="checkbox"
              checked={capChat}
              onChange={(e) => setCapChat(e.target.checked)}
              disabled={provider === 'local'}
              className="mt-0.5 rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
            />
            <div className="flex-1">
              <label
                htmlFor="cap-chat"
                className={`text-sm cursor-pointer ${provider === 'local' ? 'text-gray-500' : 'text-gray-200'}`}
              >
                {t('form.chatLabel')}
              </label>
              {capChat && (
                <div className="mt-1">
                  <label className="text-xs text-gray-400">{t('form.chatModelLabel')}</label>
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => updateField('model', e.target.value)}
                    placeholder={
                      provider === 'anthropic'
                        ? t('form.chatModelPlaceholder.anthropic')
                        : provider === 'openrouter'
                          ? t('form.chatModelPlaceholder.openrouter')
                          : t('form.chatModelPlaceholder.custom')
                    }
                    className="input-editorial w-full text-sm mt-1"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Embeddings capability */}
          <div className="flex items-start gap-3">
            <div className="relative mt-0.5">
              <input
                id="cap-embeddings"
                type="checkbox"
                checked={capEmbeddings}
                onChange={(e) => {
                  setCapEmbeddings(e.target.checked);
                  if (!e.target.checked) setEmbeddingModel('');
                }}
                disabled={provider === 'anthropic' || provider === 'local'}
                className="rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
              />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <label
                  htmlFor="cap-embeddings"
                  className={`text-sm cursor-pointer ${provider === 'anthropic' ? 'text-gray-500' : 'text-gray-200'}`}
                >
                  {t('form.embeddingsLabel')}
                </label>
                {provider === 'anthropic' && (
                  <span
                    className="text-xs text-amber-400 cursor-default"
                    title={t('form.embeddingsNotAvailableTitle')}
                  >
                    {t('form.embeddingsNotAvailable')}
                  </span>
                )}
                {provider === 'local' && (
                  <span
                    className="text-xs text-green-400 cursor-default"
                    title={t('form.embeddingsAlwaysOnTitle')}
                  >
                    {t('form.embeddingsAlwaysOn')}
                  </span>
                )}
              </div>
              {capEmbeddings && provider === 'local' && (
                <div className="mt-1">
                  <label className="text-xs text-gray-400">{t('form.embeddingsModelLabel')}</label>
                  <div className="input-editorial w-full text-sm mt-1 opacity-70 cursor-default select-none">
                    {t('form.embeddingsModelInfo', {
                      model: LOCAL_MODEL_INFO.embeddingModel,
                      dimensions: LOCAL_MODEL_INFO.dimensions,
                      maxTokens: LOCAL_MODEL_INFO.maxTokens,
                    })}
                  </div>
                  {editingSetting?.localModelAvailable === false && (
                    <p className="text-xs text-amber-400 mt-1">
                      {t.rich('form.modelFilesNotFound', {
                        code: (chunks) => <code>{chunks}</code>,
                      })}
                    </p>
                  )}
                  <p className="text-xs text-gray-600 mt-1">{t('form.localPrivacyNote')}</p>
                  <a
                    href="https://ai.google.dev/gemma/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-gray-500 hover:text-gray-300 underline underline-offset-2 mt-1 inline-block"
                    title={t('form.thirdPartyLicensesTitle')}
                  >
                    {t('form.thirdPartyLicenses')}
                  </a>
                </div>
              )}
              {capEmbeddings && provider !== 'anthropic' && provider !== 'local' && (
                <div className="mt-1">
                  <label className="text-xs text-gray-400">
                    {t('form.embeddingsModelLabel')} <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    placeholder={t('form.embeddingsModelPlaceholder')}
                    className="input-editorial w-full text-sm mt-1"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Rerank capability */}
          <div className="flex items-start gap-3">
            <div className="relative mt-0.5">
              <input
                id="cap-rerank"
                type="checkbox"
                checked={capRerank}
                onChange={(e) => {
                  setCapRerank(e.target.checked);
                  if (!e.target.checked) setRerankModel('');
                }}
                disabled={provider === 'local'}
                className="rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
              />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <label
                  htmlFor="cap-rerank"
                  className={`text-sm cursor-pointer ${provider === 'local' ? 'text-gray-500' : 'text-gray-200'}`}
                >
                  {t('form.rerankLabel')}
                </label>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{t('form.rerankDescription')}</p>
              {capRerank && (
                <div className="mt-2">
                  <label className="text-xs text-gray-400">
                    {t('form.rerankModelLabel')} <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={rerankModel}
                    onChange={(e) => setRerankModel(e.target.value)}
                    placeholder={t('form.rerankModelPlaceholder')}
                    className="input-editorial w-full text-sm mt-1"
                  />
                  <p className="text-xs text-gray-600 mt-1">
                    {t.rich('form.rerankModelNote', {
                      code: (chunks) => <code className="text-gray-500">{chunks}</code>,
                    })}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* The model field is now embedded inside the Chat capability section above. */}

      {/* API Key */}
      {provider !== 'custom' && provider !== 'local' && (
        <div>
          <label className="text-sm text-gray-400">
            {provider === 'openrouter'
              ? t('form.apiKeyLabel.openrouter')
              : t('form.apiKeyLabel.anthropic')}{' '}
            <span className="text-red-400">*</span>
          </label>
          <div className="relative mt-1">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => updateField('apiKey', e.target.value)}
              placeholder={
                provider === 'openrouter'
                  ? t('form.apiKeyPlaceholder.openrouter')
                  : t('form.apiKeyPlaceholder.anthropic')
              }
              className="input-editorial w-full text-sm pr-16"
            />
            <button
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300"
            >
              {showApiKey ? t('form.hideApiKey') : t('form.showApiKey')}
            </button>
          </div>
        </div>
      )}

      {provider === 'custom' && (
        <div>
          <label className="text-sm text-gray-400">{t('form.apiKeyOptionalLabel')}</label>
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => updateField('apiKey', e.target.value)}
            placeholder={t('form.apiKeyOptionalPlaceholder')}
            className="input-editorial w-full text-sm mt-1"
          />
        </div>
      )}

      {provider === 'custom' && (
        <div>
          <label className="text-sm text-gray-400">{t('form.baseUrlLabel')}</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => updateField('baseUrl', e.target.value)}
            placeholder={t('form.baseUrlPlaceholder')}
            className="input-editorial w-full text-sm mt-1"
          />
        </div>
      )}

      {formError && (
        <div className="p-2.5 rounded-lg text-sm bg-red-950/30 border border-red-800/50 text-red-400">
          {formError}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50 shadow-md shadow-os-900/20"
        >
          {saving ? t('form.saving') : isCreating ? t('form.createSetting') : t('form.saveChanges')}
        </button>
        <button
          onClick={handleTestForm}
          disabled={testing}
          className="px-4 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
        >
          {testing ? t('form.testing') : t('form.testConnection')}
        </button>
        {saveResult && (
          <span className={`text-sm ${saveResult.ok ? 'text-green-400' : 'text-red-400'}`}>
            {saveResult.message}
          </span>
        )}
      </div>

      {testResult && (
        <div
          className={`p-3 rounded-lg text-sm ${
            testResult.success
              ? 'bg-green-950/30 border border-green-800/50 text-green-400'
              : 'bg-red-950/30 border border-red-800/50 text-red-400'
          }`}
        >
          {testResult.message}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="heading-md">{t('title')}</h2>
            <HelpTip content={t('titleHelp')} position="right" maxWidth={340} />
          </div>
          <p className="text-sm text-gray-500 mt-1">{t('description')}</p>
        </div>
        <button
          onClick={startCreate}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 shadow-md shadow-os-900/20 ${
            isCreating
              ? 'bg-gray-700/40 hover:bg-gray-700/60 text-gray-300'
              : 'bg-os-700 hover:bg-os-600 text-white'
          }`}
        >
          {isCreating ? tCommon('cancel') : t('newSettingButton')}
        </button>
      </div>

      {/* List with inline editing — selected row expands an edit panel just below itself. */}
      <div className="space-y-2">
        {settings.length === 0 && !isCreating && (
          <div className="text-sm text-gray-500 italic px-3 py-6 text-center border border-dashed border-white/5 rounded-lg">
            {t.rich('emptyState', {
              span: (chunks) => <span className="text-os-400">{chunks}</span>,
            })}
          </div>
        )}

        {settings.map((s) => {
          const isOpen = editingName === s.name;
          return (
            <div key={s.name}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={() => startEdit(s)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    startEdit(s);
                  }
                }}
                className={`flex items-center justify-between p-3 rounded-lg border bg-gray-900/40 transition-colors cursor-pointer hover:border-white/10 focus:outline-none focus:ring-2 focus:ring-os-500/40 ${
                  isOpen ? 'border-os-600/40' : 'border-white/5'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200 truncate">{s.label}</span>
                    <span className="text-xs text-gray-500">·</span>
                    <span className="text-xs text-gray-500 truncate">{s.name}</span>
                    <span
                      className={`w-1.5 h-1.5 rounded-full ml-1 ${
                        s.configured ? 'bg-green-500 shadow-md shadow-green-500/30' : 'bg-gray-600'
                      }`}
                      title={s.configured ? t('status.configured') : t('status.notConfigured')}
                    />
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <span className="text-xs text-gray-500">
                      {s.provider === 'local' ? 'local' : s.provider}
                      {s.model ? ` · ${s.model}` : ''}
                    </span>
                    {s.provider === 'local' && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 ring-1 ring-green-500/20"
                        title={t('builtInBadgeTitle')}
                      >
                        {t('builtInBadge')}
                      </span>
                    )}
                    {/* Capability badges */}
                    {(() => {
                      const caps = s.capabilities ?? ['chat'];
                      const hasChat = caps.includes('chat');
                      const hasEmb = caps.includes('embeddings');
                      const hasRerank = caps.includes('rerank');
                      const parts: string[] = [];
                      if (hasChat) parts.push(t('form.chatLabel'));
                      if (hasEmb) parts.push(t('form.embeddingsLabel'));
                      if (hasRerank) parts.push(t('form.rerankLabel'));
                      const label = parts.length > 0 ? parts.join(' + ') : t('form.chatLabel');
                      const isLocal = s.provider === 'local';
                      return (
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded-full ring-1 ${
                            isLocal
                              ? 'bg-green-500/10 text-green-400 ring-green-500/20'
                              : 'bg-os-500/10 text-os-300 ring-os-500/20'
                          }`}
                        >
                          {label}
                        </span>
                      );
                    })()}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleQuickTest(s);
                    }}
                    disabled={testingName === s.name}
                    className="px-2 py-1 rounded text-xs text-gray-300 hover:bg-gray-700/40 disabled:opacity-50"
                  >
                    {testingName === s.name ? t('list.testingButton') : t('list.testButton')}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(s);
                    }}
                    disabled={s.provider === 'local'}
                    title={s.provider === 'local' ? t('list.deleteDisabledTitle') : undefined}
                    className="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-950/40 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                  >
                    {t('list.deleteButton')}
                  </button>
                  <span
                    aria-hidden="true"
                    className={`text-xs text-gray-500 ml-1 transition-transform duration-200 ${
                      isOpen ? 'rotate-180 text-os-400' : ''
                    }`}
                  >
                    ▾
                  </span>
                </div>
              </div>

              {/* Inline edit panel — opens just below the selected row */}
              {isOpen && renderEditForm()}
            </div>
          );
        })}

        {/* Create panel — shown at the bottom of the list when "+ New" is active */}
        {isCreating && renderEditForm()}

        {testResult && !editingName && (
          <div
            className={`p-3 rounded-lg text-sm ${
              testResult.success
                ? 'bg-green-950/30 border border-green-800/50 text-green-400'
                : 'bg-red-950/30 border border-red-800/50 text-red-400'
            }`}
          >
            {testResult.message}
          </div>
        )}
      </div>

      {/* ------------------------- LLM Router section ------------------------- */}
      <div className="border-t border-white/5 my-4"></div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="eyebrow">{t('router.title')}</h3>
              <HelpTip content={t('router.titleHelp')} position="right" maxWidth={340} />
            </div>
            <p className="text-xs text-gray-500 mt-0.5">{t('router.description')}</p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={routerEnabled}
              onChange={(e) => setRouterEnabled(e.target.checked)}
              className="rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30"
            />
            <span className="text-sm text-gray-300">{t('router.enableLabel')}</span>
          </label>
        </div>

        {routerEnabled && (
          <div className="space-y-4 pl-2 border-l-2 border-white/10">
            <div>
              <label className="text-sm text-gray-400">{t('router.classifierProviderLabel')}</label>
              <select
                value={classifierProvider}
                onChange={(e) => setClassifierProvider(e.target.value as ClassifierProvider)}
                className="input-editorial w-full text-sm mt-1"
              >
                <option value="anthropic">{t('router.classifierProviderOptions.anthropic')}</option>
                <option value="openrouter">
                  {t('router.classifierProviderOptions.openrouter')}
                </option>
                <option value="custom">{t('router.classifierProviderOptions.custom')}</option>
              </select>
            </div>
            <div>
              <label className="text-sm text-gray-400">
                {t('router.classifierModelLabel')} <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={classifierModel}
                onChange={(e) => setClassifierModel(e.target.value)}
                placeholder={
                  classifierProvider === 'anthropic'
                    ? t('router.classifierModelPlaceholder.anthropic')
                    : t('router.classifierModelPlaceholder.other')
                }
                className="input-editorial w-full text-sm mt-1"
              />
            </div>
            <div>
              <label className="text-sm text-gray-400">{t('router.classifierApiKeyLabel')}</label>
              <input
                type="password"
                value={classifierApiKey}
                onChange={(e) => setClassifierApiKey(e.target.value)}
                placeholder={t('router.classifierApiKeyPlaceholder')}
                className="input-editorial w-full text-sm mt-1"
              />
              <p className="text-xs text-gray-600 mt-1">{t('router.classifierApiKeyHelp')}</p>
            </div>
            {classifierProvider === 'custom' && (
              <div>
                <label className="text-sm text-gray-400">
                  {t('router.classifierEndpointLabel')}
                </label>
                <input
                  type="text"
                  value={classifierEndpoint}
                  onChange={(e) => setClassifierEndpoint(e.target.value)}
                  placeholder={t('router.classifierEndpointPlaceholder')}
                  className="input-editorial w-full text-sm mt-1"
                />
              </div>
            )}
            <div>
              <label className="text-sm text-gray-400">
                {t('router.injectionThresholdLabel', { threshold: injectionThreshold })}
              </label>
              <input
                type="range"
                min={50}
                max={100}
                value={injectionThreshold}
                onChange={(e) => setInjectionThreshold(Number(e.target.value))}
                className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-os-500"
              />
              <div className="flex justify-between text-xs text-gray-600 mt-1">
                <span>{t('router.thresholdMin')}</span>
                <span>{t('router.thresholdMax')}</span>
              </div>
            </div>
          </div>
        )}

        <button
          onClick={saveRouterOnly}
          disabled={saving}
          className="px-3 py-1.5 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
        >
          {t('router.saveButton')}
        </button>
      </div>
    </div>
  );
}
