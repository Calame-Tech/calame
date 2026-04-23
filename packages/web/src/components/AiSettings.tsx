import { useState, useEffect } from 'react';
import HelpTip from './HelpTip.js';

type Provider = 'anthropic' | 'openrouter' | 'custom';

type ClassifierProvider = 'anthropic' | 'openrouter' | 'custom';

interface AiConfigDisplay {
  provider: Provider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  configured: boolean;
  // LLM Router fields
  routerEnabled?: boolean;
  classifierProvider?: ClassifierProvider;
  classifierModel?: string;
  classifierApiKey?: string;
  classifierEndpoint?: string;
  injectionThreshold?: number; // stored as 0-1 on backend
}

interface PerProviderFields {
  apiKey: string;
  model: string;
  baseUrl: string;
}

const emptyFields: PerProviderFields = { apiKey: '', model: '', baseUrl: '' };

export default function AiSettings() {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [perProvider, setPerProvider] = useState<Record<Provider, PerProviderFields>>({
    anthropic: { ...emptyFields },
    openrouter: { ...emptyFields },
    custom: { ...emptyFields },
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);

  // LLM Router state
  const [routerEnabled, setRouterEnabled] = useState(false);
  const [classifierProvider, setClassifierProvider] = useState<ClassifierProvider>('anthropic');
  const [classifierModel, setClassifierModel] = useState('');
  const [classifierApiKey, setClassifierApiKey] = useState('');
  const [classifierEndpoint, setClassifierEndpoint] = useState('');
  const [injectionThreshold, setInjectionThreshold] = useState(80); // percentage (50–100)

  // Accessors for current provider fields
  const apiKey = perProvider[provider].apiKey;
  const model = perProvider[provider].model;
  const baseUrl = perProvider[provider].baseUrl;

  const updateField = (field: keyof PerProviderFields, value: string) => {
    setPerProvider((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], [field]: value },
    }));
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/ai-settings', { credentials: 'include' });
        const data = await res.json();
        if (data.success && data.config) {
          const cfg = data.config as AiConfigDisplay;
          setProvider(cfg.provider);
          setPerProvider((prev) => ({
            ...prev,
            [cfg.provider]: {
              apiKey: cfg.apiKey ?? '',
              model: cfg.model ?? '',
              baseUrl: cfg.baseUrl ?? '',
            },
          }));
          setConfigured(cfg.configured);
          // Restore LLM Router fields if present
          if (cfg.routerEnabled !== undefined) setRouterEnabled(cfg.routerEnabled);
          if (cfg.classifierProvider) setClassifierProvider(cfg.classifierProvider);
          if (cfg.classifierModel !== undefined) setClassifierModel(cfg.classifierModel);
          if (cfg.classifierApiKey !== undefined) setClassifierApiKey(cfg.classifierApiKey);
          if (cfg.classifierEndpoint !== undefined) setClassifierEndpoint(cfg.classifierEndpoint);
          if (cfg.injectionThreshold !== undefined)
            setInjectionThreshold(Math.round(cfg.injectionThreshold * 100));
        }
      } catch {
        // Not configured yet
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch('/api/ai-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider,
          apiKey,
          model: model || undefined,
          baseUrl: baseUrl || undefined,
          // Router fields
          routerEnabled,
          classifierProvider: routerEnabled ? classifierProvider : undefined,
          classifierModel: routerEnabled ? classifierModel || undefined : undefined,
          classifierApiKey: routerEnabled ? classifierApiKey || undefined : undefined,
          classifierEndpoint: routerEnabled ? classifierEndpoint || undefined : undefined,
          injectionThreshold: routerEnabled ? injectionThreshold / 100 : undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSaveResult('Saved successfully.');
        setConfigured(true);
      } else {
        setSaveResult(data.message || 'Failed to save.');
      }
    } catch {
      setSaveResult('Connection error.');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult(null), 3000);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Save first, then test
      await fetch('/api/ai-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider,
          apiKey,
          model: model || undefined,
          baseUrl: baseUrl || undefined,
          routerEnabled,
          classifierProvider: routerEnabled ? classifierProvider : undefined,
          classifierModel: routerEnabled ? classifierModel || undefined : undefined,
          classifierApiKey: routerEnabled ? classifierApiKey || undefined : undefined,
          classifierEndpoint: routerEnabled ? classifierEndpoint || undefined : undefined,
          injectionThreshold: routerEnabled ? injectionThreshold / 100 : undefined,
        }),
      });

      const res = await fetch('/api/ai-settings/test', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        setTestResult({ success: true, message: `Connection OK: "${data.response}"` });
        setConfigured(true);
      } else {
        setTestResult({ success: false, message: data.message || 'Test failed.' });
      }
    } catch {
      setTestResult({ success: false, message: 'Connection error.' });
    } finally {
      setTesting(false);
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-100">AI Settings</h2>
            <HelpTip
              content="Configure the LLM provider used by the Calame chat. All users share this configuration — their API key is never exposed. The model selects available MCP tools based on each user's connection profile."
              position="right"
              maxWidth={320}
            />
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Configure the AI provider for user chat. Users will use this configuration.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              configured ? 'bg-green-500 shadow-lg shadow-green-500/30' : 'bg-gray-600'
            }`}
          />
          <span className="text-sm text-gray-400">
            {configured ? 'Configured' : 'Not configured'}
          </span>
        </div>
      </div>

      {/* Provider selection */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <label className="text-sm text-gray-400">Provider</label>
          <HelpTip
            content="LLM provider used for chat. Anthropic provides direct access to Claude models. OpenRouter is a multi-model gateway (Claude, GPT, Gemini, etc.). Custom lets you use a local OpenAI-compatible server such as Ollama or vLLM."
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
                  : 'border-gray-700 bg-gray-900/40 hover:border-gray-600'
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

      {/* API Key — for anthropic and openrouter */}
      {provider !== 'custom' && (
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <label className="text-sm text-gray-400">
              {provider === 'openrouter' ? 'OpenRouter API Key' : 'Anthropic API Key'}{' '}
              <span className="text-red-400">*</span>
            </label>
            <HelpTip
              content={
                provider === 'openrouter'
                  ? "OpenRouter API key — get it at openrouter.ai/keys. Starts with \"sk-or-\". Stored encrypted on the server and never exposed to chat users."
                  : "Anthropic API key — get it at console.anthropic.com. Starts with \"sk-ant-\". Stored encrypted on the server. Make sure your account has access to the desired Claude models."
              }
              position="right"
              maxWidth={320}
            />
          </div>
          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => updateField('apiKey', e.target.value)}
              placeholder={provider === 'openrouter' ? 'sk-or-...' : 'sk-ant-...'}
              className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500 pr-16"
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

      {/* API Key — optional for custom */}
      {provider === 'custom' && (
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <label className="text-sm text-gray-400">API Key (optional)</label>
            <HelpTip
              content="API key for your custom endpoint. Leave empty if your local server (Ollama, LM Studio) does not require authentication. Required for some vLLM deployments or OpenAI-compatible cloud services."
              position="right"
              maxWidth={320}
            />
          </div>
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => updateField('apiKey', e.target.value)}
            placeholder="Leave empty if not required"
            className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
          />
        </div>
      )}

      {/* Model — for openrouter and custom */}
      {(provider === 'openrouter' || provider === 'custom') && (
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <label className="text-sm text-gray-400">Model</label>
            <HelpTip
              content={
                provider === 'openrouter'
                  ? "OpenRouter model identifier in the format \"provider/model\" (e.g. anthropic/claude-sonnet-4, openai/gpt-4o, google/gemini-pro). See openrouter.ai/models for the full list and pricing."
                  : "Model name as exposed by your local server (e.g. llama3, mistral, phi3). Must exactly match the name returned by /v1/models on your endpoint."
              }
              position="right"
              maxWidth={340}
            />
          </div>
          <input
            type="text"
            value={model}
            onChange={(e) => updateField('model', e.target.value)}
            placeholder={
              provider === 'openrouter'
                ? 'anthropic/claude-sonnet-4'
                : 'llama3, mistral, etc.'
            }
            className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
          />
        </div>
      )}

      {/* Base URL — for custom */}
      {provider === 'custom' && (
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <label className="text-sm text-gray-400">Base URL</label>
            <HelpTip
              content="Base URL of your OpenAI-compatible endpoint. The /v1 path is typically included. Examples: http://localhost:11434/v1 (Ollama), http://localhost:1234/v1 (LM Studio), http://localhost:8000/v1 (vLLM). Must be reachable from the Node.js server, not from the browser."
              position="right"
              maxWidth={340}
            />
          </div>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => updateField('baseUrl', e.target.value)}
            placeholder="http://localhost:11434/v1"
            className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
          />
          <p className="text-xs text-gray-600 mt-1">
            OpenAI-compatible API URL (Ollama, vLLM, LM Studio, etc.)
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          title="Enregistre la configuration IA sur le serveur. Tous les chats utilisateurs utiliseront ces paramètres immédiatement."
          className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50 shadow-md shadow-os-900/20"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          title="Enregistre puis envoie un message de test « Bonjour » au fournisseur pour vérifier que la clé API et le modèle sont valides."
          className="px-4 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>

        {saveResult && (
          <span className="text-sm text-green-400">{saveResult}</span>
        )}
      </div>

      {/* Test result */}
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

      {/* Divider */}
      <div className="border-t border-gray-700 my-6"></div>

      {/* LLM Router / Classifier */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-200">LLM Router / Classifier</h3>
              <HelpTip
                content="Two-stage pipeline: a lightweight classifier analyzes each message before the main LLM. It detects prompt injection attempts and off-topic queries, reducing costs and improving security."
                position="right"
                maxWidth={340}
              />
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              Two-stage pipeline: lightweight classifier detects intent and blocks injection attempts
              before the main LLM processes the query.
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
          <div className="space-y-4 pl-2 border-l-2 border-gray-700">
            {/* Classifier Provider */}
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-sm text-gray-400">Classifier Provider</label>
                <HelpTip
                  content="Provider for the classifier model. To optimize costs, choose a cheaper model than the main LLM (e.g. Claude Haiku when the main is Claude Sonnet). Custom/Ollama lets you run a completely free local model."
                  position="right"
                  maxWidth={340}
                />
              </div>
              <select
                value={classifierProvider}
                onChange={(e) => setClassifierProvider(e.target.value as ClassifierProvider)}
                className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
              >
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Custom / Ollama</option>
              </select>
              <p className="text-xs text-gray-600 mt-1">
                Use a lightweight model (Haiku, GPT-4o-mini) for cost efficiency.
              </p>
            </div>

            {/* Classifier Model */}
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-sm text-gray-400">
                  Classifier Model <span className="text-red-400">*</span>
                </label>
                <HelpTip
                  content="Lightweight model used for classification. Prefer fast, cost-effective models: claude-haiku-4-5 (Anthropic), gpt-4o-mini (OpenAI via OpenRouter), llama3:8b (local Ollama). Classification quality does not require a large model."
                  position="right"
                  maxWidth={340}
                />
              </div>
              <input
                type="text"
                value={classifierModel}
                onChange={(e) => setClassifierModel(e.target.value)}
                placeholder={
                  classifierProvider === 'anthropic'
                    ? 'claude-haiku-4-5-20251001'
                    : 'gpt-4o-mini'
                }
                className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
              />
            </div>

            {/* Classifier API Key */}
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-sm text-gray-400">Classifier API Key</label>
                <HelpTip
                  content="Dedicated API key for the classifier. Leave empty to reuse the main provider's key. Useful when the classifier uses a different provider or a separate account for cost tracking."
                  position="right"
                  maxWidth={320}
                />
              </div>
              <input
                type="password"
                value={classifierApiKey}
                onChange={(e) => setClassifierApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
              />
              <p className="text-xs text-gray-600 mt-1">
                Leave empty to use the same key as the main provider.
              </p>
            </div>

            {/* Classifier Endpoint — only for custom/Ollama */}
            {classifierProvider === 'custom' && (
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <label className="text-sm text-gray-400">Classifier Endpoint</label>
                  <HelpTip
                    content="Base URL of the OpenAI-compatible endpoint for the classifier. Can differ from the main endpoint (e.g. local Ollama classifier + main LLM on a separate vLLM server)."
                    position="right"
                    maxWidth={320}
                  />
                </div>
                <input
                  type="text"
                  value={classifierEndpoint}
                  onChange={(e) => setClassifierEndpoint(e.target.value)}
                  placeholder="http://localhost:11434/v1"
                  className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-os-500/30 focus:border-os-500"
                />
              </div>
            )}

            {/* Injection Detection Threshold */}
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-sm text-gray-400">
                  Injection Detection Threshold: {injectionThreshold}%
                </label>
                <HelpTip
                  content="Confidence threshold above which the classifier blocks a message as an injection attempt. Low value (50-65%): very strict, may block ambiguous legitimate queries. High value (85-100%): permissive, passes more requests but less secure. Recommended value: 75-80%."
                  position="left"
                  maxWidth={340}
                />
              </div>
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
      </div>
    </div>
  );
}
