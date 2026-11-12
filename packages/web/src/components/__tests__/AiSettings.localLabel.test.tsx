/**
 * Settings → AI Provider: the bundled local embedding setting is seeded
 * server-side with a French label; the English UI must show it in English
 * (second tester pass), while a label the user chose is shown as is.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiSettings from '../AiSettings.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const local = (label: string) => ({
  name: 'local',
  label,
  provider: 'local',
  apiKey: '',
  configured: true,
  capabilities: ['embeddings'],
  localModelAvailable: true,
});

function mockSettings(settings: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/ai-settings')) return json({ success: true, settings });
      return json({ success: true });
    }),
  );
}

beforeEach(() => localStorage.setItem('calame-locale', 'en'));
afterEach(() => vi.unstubAllGlobals());

describe('AiSettings — local embedding label', () => {
  it('shows the seeded French label in English', async () => {
    mockSettings([local('Embeddings locaux (inclus)')]);
    render(<AiSettings />, { wrapper: I18nProvider });
    expect(await screen.findByText('Local embeddings (included)')).toBeTruthy();
    expect(screen.queryByText('Embeddings locaux (inclus)')).toBeNull();
  });

  it('keeps a label renamed by the user', async () => {
    mockSettings([local('My local model')]);
    render(<AiSettings />, { wrapper: I18nProvider });
    expect(await screen.findByText('My local model')).toBeTruthy();
  });
});
