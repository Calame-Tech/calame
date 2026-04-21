import type { Express } from 'express';
import type { AppState } from '../state.js';

export function registerAiSettingsRoute(app: Express, state: AppState): void {
  /** GET /api/ai-settings — Return the current AI config (API key masked). */
  app.get('/api/ai-settings', (_req, res) => {
    const mgr = state.aiConfigManager;
    if (!mgr) {
      res.json({ success: true, config: null });
      return;
    }
    res.json({ success: true, config: mgr.getMaskedConfig() });
  });

  /** POST /api/ai-settings — Save AI config. */
  app.post('/api/ai-settings', async (req, res) => {
    const mgr = state.aiConfigManager;
    if (!mgr) {
      res.status(500).json({ success: false, message: 'AI config manager not initialized.' });
      return;
    }

    const { provider, apiKey, model, baseUrl } = req.body;

    if (!provider || !['anthropic', 'openrouter', 'custom'].includes(provider)) {
      res.status(400).json({ success: false, message: 'Invalid provider.' });
      return;
    }

    if (provider !== 'custom' && !apiKey) {
      res.status(400).json({ success: false, message: 'API key is required for this provider.' });
      return;
    }

    if (provider === 'custom' && !baseUrl) {
      res.status(400).json({ success: false, message: 'Base URL is required for custom provider.' });
      return;
    }

    try {
      // If the API key contains '***', it's the masked value from GET — keep the existing key
      let finalApiKey: string = apiKey ?? '';
      if (finalApiKey.includes('***')) {
        const existing = mgr.getConfig();
        finalApiKey = existing?.apiKey ?? '';
      }
      await mgr.setConfig({ provider, apiKey: finalApiKey, model, baseUrl });
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to save AI config.';
      res.status(500).json({ success: false, message });
    }
  });

  /** POST /api/ai-settings/test — Test the AI connection by sending a simple message. */
  app.post('/api/ai-settings/test', async (req, res) => {
    const mgr = state.aiConfigManager;
    if (!mgr || !mgr.isConfigured()) {
      res.status(400).json({ success: false, message: 'AI is not configured.' });
      return;
    }

    const config = mgr.getConfig()!;

    try {
      if (config.provider === 'anthropic') {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const anthropic = new Anthropic({ apiKey: config.apiKey });
        const response = await anthropic.messages.create({
          model: config.model || 'claude-sonnet-4-20250514',
          max_tokens: 50,
          messages: [{ role: 'user', content: 'Say "OK" if you can hear me.' }],
        });
        const text = response.content
          .filter((b) => b.type === 'text')
          .map((b) => ('text' in b ? b.text : ''))
          .join('');
        res.json({ success: true, response: text });
      } else {
        // openrouter or custom — both use OpenAI SDK
        const OpenAI = (await import('openai')).default;
        const baseUrl =
          config.provider === 'openrouter'
            ? 'https://openrouter.ai/api/v1'
            : config.baseUrl;
        const openai = new OpenAI({ apiKey: config.apiKey || 'not-needed', baseURL: baseUrl });
        const completion = await openai.chat.completions.create({
          model: config.model || (config.provider === 'openrouter' ? 'anthropic/claude-sonnet-4' : 'default'),
          max_tokens: 50,
          messages: [
            { role: 'system', content: 'You are a test assistant.' },
            { role: 'user', content: 'Say "OK" if you can hear me.' },
          ],
        });
        const text = completion.choices[0]?.message?.content ?? '';
        res.json({ success: true, response: text });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Connection test failed.';
      res.json({ success: false, message });
    }
  });
}
