import type { Express } from 'express';
import type { AppState } from '../state.js';
import type { AiProvider, AiSetting } from '../ai-config.js';

const VALID_PROVIDERS: ReadonlySet<AiProvider> = new Set(['anthropic', 'openrouter', 'custom']);

/** Slug-style names: lowercase letters, digits, dash, underscore. */
const NAME_RE = /^[a-z0-9_-]{1,64}$/;

interface SettingPayload {
  name?: string;
  label?: string;
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

function validateProviderFields(body: SettingPayload): string | null {
  if (!body.provider || !VALID_PROVIDERS.has(body.provider as AiProvider)) {
    return 'Invalid provider.';
  }
  if (body.provider !== 'custom' && !body.apiKey) {
    return 'API key is required for this provider.';
  }
  if (body.provider === 'custom' && !body.baseUrl) {
    return 'Base URL is required for custom provider.';
  }
  return null;
}

async function testConnection(setting: AiSetting): Promise<{ ok: true; response: string } | { ok: false; message: string }> {
  try {
    if (setting.provider === 'anthropic') {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const anthropic = new Anthropic({ apiKey: setting.apiKey });
      const response = await anthropic.messages.create({
        model: setting.model || 'claude-sonnet-4-20250514',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Say "OK" if you can hear me.' }],
      });
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => ('text' in b ? b.text : ''))
        .join('');
      return { ok: true, response: text };
    }
    const OpenAI = (await import('openai')).default;
    const baseUrl =
      setting.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : setting.baseUrl;
    const openai = new OpenAI({ apiKey: setting.apiKey || 'not-needed', baseURL: baseUrl });
    const completion = await openai.chat.completions.create({
      model:
        setting.model || (setting.provider === 'openrouter' ? 'anthropic/claude-sonnet-4' : 'default'),
      max_tokens: 50,
      messages: [
        { role: 'system', content: 'You are a test assistant.' },
        { role: 'user', content: 'Say "OK" if you can hear me.' },
      ],
    });
    return { ok: true, response: completion.choices[0]?.message?.content ?? '' };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : 'Connection test failed.' };
  }
}

export function registerAiSettingsRoute(app: Express, state: AppState): void {
  /** GET /api/ai-settings — list all settings (api keys masked). */
  app.get('/api/ai-settings', (_req, res) => {
    const mgr = state.aiSettingsManager;
    if (!mgr) {
      res.json({ success: true, settings: [], config: null });
      return;
    }
    const settings = mgr.listMaskedSettings();
    // Backward-compat: also expose `config` (first setting) for older callers.
    res.json({ success: true, settings, config: settings[0] ?? null });
  });

  /** GET /api/ai-settings/:name — single setting (masked). */
  app.get('/api/ai-settings/:name', (req, res) => {
    const mgr = state.aiSettingsManager;
    if (!mgr) {
      res.status(500).json({ success: false, message: 'AI settings manager not initialized.' });
      return;
    }
    const setting = mgr.getMaskedSetting(req.params.name);
    if (!setting) {
      res.status(404).json({ success: false, message: 'Setting not found.' });
      return;
    }
    res.json({ success: true, setting });
  });

  /** POST /api/ai-settings — create a new setting, OR (legacy) upsert single config. */
  app.post('/api/ai-settings', async (req, res) => {
    const mgr = state.aiSettingsManager;
    if (!mgr) {
      res.status(500).json({ success: false, message: 'AI settings manager not initialized.' });
      return;
    }

    const body = (req.body ?? {}) as SettingPayload;
    const fieldError = validateProviderFields(body);
    if (fieldError) {
      res.status(400).json({ success: false, message: fieldError });
      return;
    }

    // Legacy single-config behaviour: no `name` → upsert the 'default' setting.
    if (!body.name) {
      let finalApiKey: string = body.apiKey ?? '';
      if (finalApiKey.includes('***')) {
        const existing = mgr.getSetting('default');
        finalApiKey = existing?.apiKey ?? '';
      }
      try {
        await mgr.setConfig({
          provider: body.provider as AiProvider,
          apiKey: finalApiKey,
          model: body.model,
          baseUrl: body.baseUrl,
        });
        res.json({ success: true });
      } catch (error: unknown) {
        res.status(500).json({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to save AI config.',
        });
      }
      return;
    }

    if (!NAME_RE.test(body.name)) {
      res.status(400).json({
        success: false,
        message: 'Name must be 1-64 chars: lowercase letters, digits, dash, underscore.',
      });
      return;
    }
    if (!body.label) {
      res.status(400).json({ success: false, message: 'Label is required.' });
      return;
    }

    try {
      mgr.createSetting({
        name: body.name,
        label: body.label,
        provider: body.provider as AiProvider,
        apiKey: body.apiKey ?? '',
        model: body.model,
        baseUrl: body.baseUrl,
      });
      res.json({ success: true, setting: mgr.getMaskedSetting(body.name) });
    } catch (error: unknown) {
      res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : 'Failed to create setting.',
      });
    }
  });

  /** PUT /api/ai-settings/:name — update an existing setting. */
  app.put('/api/ai-settings/:name', (req, res) => {
    const mgr = state.aiSettingsManager;
    if (!mgr) {
      res.status(500).json({ success: false, message: 'AI settings manager not initialized.' });
      return;
    }
    const existing = mgr.getSetting(req.params.name);
    if (!existing) {
      res.status(404).json({ success: false, message: 'Setting not found.' });
      return;
    }

    const body = (req.body ?? {}) as SettingPayload;
    const fieldError = validateProviderFields(body);
    if (fieldError) {
      res.status(400).json({ success: false, message: fieldError });
      return;
    }

    let finalApiKey: string = body.apiKey ?? '';
    if (finalApiKey.includes('***')) finalApiKey = existing.apiKey;

    try {
      mgr.updateSetting(req.params.name, {
        label: body.label ?? existing.label,
        provider: body.provider as AiProvider,
        apiKey: finalApiKey,
        model: body.model,
        baseUrl: body.baseUrl,
      });
      res.json({ success: true, setting: mgr.getMaskedSetting(req.params.name) });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update setting.',
      });
    }
  });

  /** DELETE /api/ai-settings/:name — remove a setting. */
  app.delete('/api/ai-settings/:name', (req, res) => {
    const mgr = state.aiSettingsManager;
    if (!mgr) {
      res.status(500).json({ success: false, message: 'AI settings manager not initialized.' });
      return;
    }
    if (!mgr.getSetting(req.params.name)) {
      res.status(404).json({ success: false, message: 'Setting not found.' });
      return;
    }
    mgr.deleteSetting(req.params.name);
    res.json({ success: true });
  });

  /** POST /api/ai-settings/test — test the legacy default setting (backward-compat). */
  app.post('/api/ai-settings/test', async (_req, res) => {
    const mgr = state.aiSettingsManager;
    if (!mgr || !mgr.isConfigured()) {
      res.status(400).json({ success: false, message: 'AI is not configured.' });
      return;
    }
    const setting = mgr.listSettings()[0];
    if (!setting) {
      res.status(400).json({ success: false, message: 'No AI setting found.' });
      return;
    }
    const result = await testConnection(setting);
    if (result.ok) {
      res.json({ success: true, response: result.response });
    } else {
      res.status(502).json({ success: false, message: result.message });
    }
  });

  /** POST /api/ai-settings/:name/test — test connection for a specific setting. */
  app.post('/api/ai-settings/:name/test', async (req, res) => {
    const mgr = state.aiSettingsManager;
    if (!mgr) {
      res.status(500).json({ success: false, message: 'AI settings manager not initialized.' });
      return;
    }
    const setting = mgr.getSetting(req.params.name);
    if (!setting) {
      res.status(404).json({ success: false, message: 'Setting not found.' });
      return;
    }
    const result = await testConnection(setting);
    if (result.ok) {
      res.json({ success: true, response: result.response });
    } else {
      res.status(502).json({ success: false, message: result.message });
    }
  });
}
