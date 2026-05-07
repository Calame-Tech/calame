import { useState, useEffect, useCallback } from 'react';
import HelpTip from './HelpTip.js';

type Provider = 'anthropic' | 'openrouter' | 'custom';
type ClassifierProvider = 'anthropic' | 'openrouter' | 'custom';
type AiCapability = 'chat' | 'embeddings';

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
});

/** Sentinel value for `editingName` meaning "create a new setting". */
const NEW_SENTINEL = '__new__';

/** Slug-style validation (must match the backend NAME_RE). */
const SLUG_RE = /^[a-z0-9_-]{1,64}$/;

export default function AiSettings() {
  // List of all AI settings (refreshed after each mutation)
  const [settings, setSettings] = useState<MaskedAiSetting[]>([]);
  const [loading, setLoading] = useState(true);

  // Currently-edited row: a setting name, NEW_SENTINEL for creation, or null for nothing.
  const [editingName, setEditingName] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [perProvider, setPerProvider] = useState<Record<Provider, PerProviderFields>>(emptyPerProvider());
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingName, setTestingName] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Capabilities form state (per-setting form — not global)
  const [capChat, setCapChat] = useState(true);
  const [capEmbeddings, setCapEmbeddings] = useState(false);
  const [embeddingModel, setEmbeddingModel] = useState('');

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

  const updateField = (field: keyof PerProviderFields, value: string) => {
    setPerProvider((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], [field]: value },
    }));
  };

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/ai-settings', { credentials: 'include' });
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
          if (cfg.injectionThreshold !== undefined) setInjectionThreshold(Math.round(cfg.injectionThreshold * 100));
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

  /** Build the capabilities array from the two checkboxes. */
  const buildCapabilities = (): AiCapability[] => {
    const caps: AiCapability[] = [];
    if (capChat) caps.push('chat');
    if (capEmbeddings) caps.push('embeddings');
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
        setFormError('Name must be 1-64 chars: lowercase letters, digits, dash, underscore.');
        return;
      }
      if (!formLabel.trim()) {
        setFormError('Label is required.');
        return;
      }
    }
    if (provider !== 'custom' && !apiKey) {
      setFormError('API key is required for this provider.');
      return;
    }
    if (provider === 'custom' && !baseUrl) {
      setFormError('Base URL is required for the custom provider.');
      return;
    }
    if (!capChat && !capEmbeddings) {
      setFormError('Au moins une capacité doit être sélectionnée (Chat ou Embeddings).');
      return;
    }
    if (capEmbeddings && !embeddingModel.trim()) {
      setFormError("Le modèle d'embeddings est requis lorsque la capacité Embeddings est activée.");
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
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setSaveResult('Saved.');
        await refresh();
        setEditingName(null);
      } else {
        setFormError(data.message || 'Failed to save.');
      }
    } catch {
      setFormError('Connection error.');
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
        await fetch(`/api/ai-settings/${encodeURIComponent(editingName)}`, {
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
        const res = await fetch(`/api/ai-settings/${encodeURIComponent(editingName)}/test`, {
          method: 'POST',
          credentials: 'include',
        });
        const data = await res.json();
        setTestResult(
          data.success
            ? { success: true, message: `Connection OK: "${data.response}"` }
            : { success: false, message: data.message || 'Test failed.' },
        );
        await refresh();
      } else {
        // No `name` yet → fall back to the legacy single-config endpoint, which writes to 'default'.
        await fetch('/api/ai-settings', {
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
        const res = await fetch('/api/ai-settings/test', { method: 'POST', credentials: 'include' });
        const data = await res.json();
        setTestResult(
          data.success
            ? { success: true, message: `Connection OK: "${data.response}"` }
            : { success: false, message: data.message || 'Test failed.' },
        );
        await refresh();
      }
    } catch {
      setTestResult({ success: false, message: 'Connection error.' });
    } finally {
      setTesting(false);
    }
  };

  const handleQuickTest = async (s: MaskedAiSetting) => {
    setTestingName(s.name);
    setTestResult(null);
    try {
      const res = await fetch(`/api/ai-settings/${encodeURIComponent(s.name)}/test`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      setTestResult(
        data.success
          ? { success: true, message: `${s.label}: OK — "${data.response}"` }
          : { success: false, message: `${s.label}: ${data.message || 'Test failed.'}` },
      );
    } catch {
      setTestResult({ success: false, message: `${s.label}: connection error.` });
    } finally {
      setTestingName(null);
    }
  };

  const handleDelete = async (s: MaskedAiSetting) => {
    if (!window.confirm(`Delete AI setting "${s.label}"?`)) return;
    try {
      await fetch(`/api/ai-settings/${encodeURIComponent(s.name)}`, {
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
      await fetch('/api/ai-settings', {
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
      setSaveResult('Router settings saved.');
    } catch {
      setSaveResult('Failed to save router.');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult(null), 3000);
    }
  };

  if (loading) {
    return <div className="text-gray-400 text-sm">Loading AI settings...</div>;
  }

  const providers: { value: Provider; label: string; desc: string }[] = [
    { value: 'anthropic', label: 'Anthropic', desc: 'Claude API' },
    { value: 'openrouter', label: 'OpenRouter', desc: 'Multi-model gateway' },
    { value: 'custom', label: 'Custom', desc: 'OpenAI-compatible (Ollama, vLLM...)' },
  ];

  const renderEditForm = () => (
    <div className="space-y-4 p-4 rounded-lg border border-os-600/40 bg-os-700/5 mt-2">
      <div className="flex items-center justify-between">
        <h3 className="eyebrow">{isCreating ? 'New AI Setting' : `Edit "${editingName}"`}</h3>
        <button onClick={cancelEdit} className="text-xs text-gray-400 hover:text-gray-200">
          Close
        </button>
      </div>

      {/* Identity */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm text-gray-400">
            Name <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={!isCreating}
            placeholder="prod-claude"
            className="input-editorial w-full text-sm mt-1 disabled:opacity-60"
          />
          <p className="text-xs text-gray-600 mt-1">
            Unique slug (lowercase, dash, underscore). Cannot be changed later.
          </p>
        </div>
        <div>
          <label className="text-sm text-gray-400">
            Label <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={formLabel}
            onChange={(e) => setFormLabel(e.target.value)}
            placeholder="Production Claude"
            className="input-editorial w-full text-sm mt-1"
          />
        </div>
      </div>

      {/* Provider selection */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <label className="text-sm text-gray-400">Provider</label>
          <HelpTip
            content="LLM provider used for chat. Anthropic provides direct access to Claude models. OpenRouter is a multi-model gateway. Custom lets you use a local OpenAI-compatible server such as Ollama or vLLM."
            position="right"
            maxWidth={320}
          />
        </div>
        <div className="flex gap-3">
          {providers.map((p) => (
            <button
              key={p.value}
              onClick={() => setProvider(p.value)}
              className={`flex-1 px-4 py-3 rounded-lg border text-left transition-all duration-200 ${
                provider === p.value
                  ? 'border-os-500 bg-os-700/20'
                  : 'border-white/5 bg-gray-900/40 hover:border-white/10'
              }`}
            >
              <div className={`text-sm font-medium ${provider === p.value ? 'text-os-400' : 'text-gray-300'}`}>
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
          <label className="text-sm text-gray-400">Capacités</label>
          <HelpTip
            content="Chat : ce setting peut être utilisé pour les conversations avec le LLM. Embeddings : ce setting peut générer des vecteurs pour le RAG (OpenAI/Ollama uniquement)."
            position="right"
            maxWidth={320}
          />
        </div>
        <div className="space-y-3 pl-1">
          {/* Chat capability */}
          <div className="flex items-start gap-3">
            <input
              id="cap-chat"
              type="checkbox"
              checked={capChat}
              onChange={(e) => setCapChat(e.target.checked)}
              className="mt-0.5 rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30"
            />
            <div className="flex-1">
              <label htmlFor="cap-chat" className="text-sm text-gray-200 cursor-pointer">
                Chat
              </label>
              {capChat && (
                <div className="mt-1">
                  <label className="text-xs text-gray-400">Modèle (Chat)</label>
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => updateField('model', e.target.value)}
                    placeholder={
                      provider === 'anthropic'
                        ? 'claude-sonnet-4-20250514'
                        : provider === 'openrouter'
                          ? 'anthropic/claude-sonnet-4'
                          : 'llama3, mistral, etc.'
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
                disabled={provider === 'anthropic'}
                className="rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
              />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <label
                  htmlFor="cap-embeddings"
                  className={`text-sm cursor-pointer ${provider === 'anthropic' ? 'text-gray-500' : 'text-gray-200'}`}
                >
                  Embeddings
                </label>
                {provider === 'anthropic' && (
                  <span
                    className="text-xs text-amber-400 cursor-default"
                    title="Anthropic ne propose pas de modèles d'embeddings — utilisez OpenAI, Ollama ou un endpoint custom"
                  >
                    Non disponible
                  </span>
                )}
              </div>
              {capEmbeddings && provider !== 'anthropic' && (
                <div className="mt-1">
                  <label className="text-xs text-gray-400">
                    Modèle d'embeddings <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    placeholder="text-embedding-3-small, nomic-embed-text, etc."
                    className="input-editorial w-full text-sm mt-1"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* The model field is now embedded inside the Chat capability section above. */}

      {/* API Key */}
      {provider !== 'custom' && (
        <div>
          <label className="text-sm text-gray-400">
            {provider === 'openrouter' ? 'OpenRouter API Key' : 'Anthropic API Key'}{' '}
            <span className="text-red-400">*</span>
          </label>
          <div className="relative mt-1">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => updateField('apiKey', e.target.value)}
              placeholder={provider === 'openrouter' ? 'sk-or-...' : 'sk-ant-...'}
              className="input-editorial w-full text-sm pr-16"
            />
            <button
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300"
            >
              {showApiKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
      )}

      {provider === 'custom' && (
        <div>
          <label className="text-sm text-gray-400">API Key (optional)</label>
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => updateField('apiKey', e.target.value)}
            placeholder="Leave empty if not required"
            className="input-editorial w-full text-sm mt-1"
          />
        </div>
      )}

      {provider === 'custom' && (
        <div>
          <label className="text-sm text-gray-400">Base URL</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => updateField('baseUrl', e.target.value)}
            placeholder="http://localhost:11434/v1"
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
          {saving ? 'Saving...' : isCreating ? 'Create setting' : 'Save changes'}
        </button>
        <button
          onClick={handleTestForm}
          disabled={testing}
          className="px-4 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
        >
          {testing ? 'Testing...' : 'Test connection'}
        </button>
        {saveResult && <span className="text-sm text-green-400">{saveResult}</span>}
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
            <h2 className="heading-md">AI Settings</h2>
            <HelpTip
              content="Configure one or more LLM providers. Each MCP server can be linked to several settings, and the chat user picks which one to use."
              position="right"
              maxWidth={340}
            />
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Define the AI providers your MCP servers can use. Associate them per-MCP in the profile editor.
          </p>
        </div>
        <button
          onClick={startCreate}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 shadow-md shadow-os-900/20 ${
            isCreating
              ? 'bg-gray-700/40 hover:bg-gray-700/60 text-gray-300'
              : 'bg-os-700 hover:bg-os-600 text-white'
          }`}
        >
          {isCreating ? 'Cancel' : '+ New AI Setting'}
        </button>
      </div>

      {/* List with inline editing — selected row expands an edit panel just below itself. */}
      <div className="space-y-2">
        {settings.length === 0 && !isCreating && (
          <div className="text-sm text-gray-500 italic px-3 py-6 text-center border border-dashed border-white/5 rounded-lg">
            No AI setting yet. Click <span className="text-os-400">+ New AI Setting</span> to create one.
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
                      title={s.configured ? 'Configured' : 'Not configured'}
                    />
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <span className="text-xs text-gray-500">
                      {s.provider}
                      {s.model ? ` · ${s.model}` : ''}
                    </span>
                    {/* Capability badges */}
                    {(() => {
                      const caps = s.capabilities ?? ['chat'];
                      const hasChat = caps.includes('chat');
                      const hasEmb = caps.includes('embeddings');
                      const label =
                        hasChat && hasEmb
                          ? 'Chat + Embeddings'
                          : hasEmb
                            ? 'Embeddings'
                            : 'Chat';
                      return (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-os-500/10 text-os-300 ring-1 ring-os-500/20">
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
                    {testingName === s.name ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(s);
                    }}
                    className="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-950/40"
                  >
                    Delete
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
              <h3 className="eyebrow">LLM Router / Classifier</h3>
              <HelpTip
                content="Two-stage pipeline: a lightweight classifier analyzes each message before the main LLM. It detects prompt injection attempts and off-topic queries, reducing costs and improving security."
                position="right"
                maxWidth={340}
              />
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              Two-stage pipeline: lightweight classifier detects intent and blocks injection attempts before
              the main LLM processes the query.
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={routerEnabled}
              onChange={(e) => setRouterEnabled(e.target.checked)}
              className="rounded border-gray-600 bg-gray-700 text-os-500 focus:ring-os-500/30"
            />
            <span className="text-sm text-gray-300">Enable</span>
          </label>
        </div>

        {routerEnabled && (
          <div className="space-y-4 pl-2 border-l-2 border-white/10">
            <div>
              <label className="text-sm text-gray-400">Classifier Provider</label>
              <select
                value={classifierProvider}
                onChange={(e) => setClassifierProvider(e.target.value as ClassifierProvider)}
                className="input-editorial w-full text-sm mt-1"
              >
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Custom / Ollama</option>
              </select>
            </div>
            <div>
              <label className="text-sm text-gray-400">
                Classifier Model <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={classifierModel}
                onChange={(e) => setClassifierModel(e.target.value)}
                placeholder={classifierProvider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini'}
                className="input-editorial w-full text-sm mt-1"
              />
            </div>
            <div>
              <label className="text-sm text-gray-400">Classifier API Key</label>
              <input
                type="password"
                value={classifierApiKey}
                onChange={(e) => setClassifierApiKey(e.target.value)}
                placeholder="sk-..."
                className="input-editorial w-full text-sm mt-1"
              />
              <p className="text-xs text-gray-600 mt-1">Leave empty to use the same key as the main provider.</p>
            </div>
            {classifierProvider === 'custom' && (
              <div>
                <label className="text-sm text-gray-400">Classifier Endpoint</label>
                <input
                  type="text"
                  value={classifierEndpoint}
                  onChange={(e) => setClassifierEndpoint(e.target.value)}
                  placeholder="http://localhost:11434/v1"
                  className="input-editorial w-full text-sm mt-1"
                />
              </div>
            )}
            <div>
              <label className="text-sm text-gray-400">
                Injection Detection Threshold: {injectionThreshold}%
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
                <span>50% (aggressive)</span>
                <span>100% (permissive)</span>
              </div>
            </div>
          </div>
        )}

        <button
          onClick={saveRouterOnly}
          disabled={saving}
          className="px-3 py-1.5 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
        >
          Save router settings
        </button>
      </div>
    </div>
  );
}
