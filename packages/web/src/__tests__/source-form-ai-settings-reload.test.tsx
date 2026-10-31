/**
 * Captain feedback (network recovery in the source edit form): after a failed
 * load of the AI settings (offline), opening a source's edit form claimed
 * "the built-in local provider is unavailable" / "the selected AI
 * configuration does not support embeddings" and refused to save until the
 * user left Sources. The capabilities are now reloaded when the form opens
 * and when the network comes back, and a failed load is shown as a load
 * error with "Retry" — never as "unavailable".
 */
import { render as rtlRender, screen, fireEvent, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeBaseManager, SourceForm } from '@calame-ee/rag-core/web';
import { I18nProvider } from '../i18n/I18nProvider.js';

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const LOCAL = {
  name: 'local',
  label: 'Local',
  provider: 'local',
  capabilities: ['embeddings'],
  embeddingDimensions: 384,
  localModelAvailable: true,
};

const SOURCE = {
  id: 's1',
  name: 'Alpha',
  type: 'local',
  config: { rootPath: '/tmp/alpha' },
  embeddingSettingName: 'local',
  embeddingModelVersion: 'm',
  embeddingDimensions: 384,
  pollingIntervalSeconds: null,
  lastSyncAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  folderCount: 0,
  documentCount: 0,
};

const UNAVAILABLE = /fournisseur local intégré est indisponible/;
const LOAD_ERROR = /Impossible de charger les paramètres IA/;

let online = false;

beforeEach(() => {
  localStorage.setItem('calame-locale', 'fr');
  online = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/ai-settings')) {
        return online
          ? Promise.resolve(json({ success: true, settings: [LOCAL] }))
          : Promise.reject(new TypeError('Failed to fetch'));
      }
      if (url === '/api/rag/sources') return Promise.resolve(json({ sources: [SOURCE] }));
      if (url.startsWith('/api/rag/sources?filter=deleted')) {
        return Promise.resolve(json({ sources: [] }));
      }
      if (url.startsWith('/api/rag/jobs')) return Promise.resolve(json({ jobs: [] }));
      return Promise.resolve(json({ error: 'not mocked' }, 503));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SourceForm — AI capabilities not loaded', () => {
  it('shows a load error with Retry instead of "unavailable"', () => {
    const retry = vi.fn();
    render(
      <SourceForm
        initial={SOURCE as never}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        aiSettings={[]}
        aiSettingsStatus="error"
        onRetryAiSettings={retry}
      />,
    );
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(screen.getByText(LOAD_ERROR)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('still reports a provider list that loaded empty as unavailable', () => {
    render(<SourceForm onSave={vi.fn()} onCancel={vi.fn()} aiSettings={[]} />);
    expect(screen.getByText(UNAVAILABLE)).toBeTruthy();
  });
});

describe('KnowledgeBaseManager — AI capabilities reload', () => {
  async function settle() {
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it('reloads the capabilities when the edit form opens after the network is back', async () => {
    render(<KnowledgeBaseManager />);
    await screen.findByText('Alpha');
    await settle();

    online = true;
    fireEvent.click(screen.getByRole('button', { name: 'Modifier la source Alpha' }));
    await settle();

    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
    expect(screen.getByRole('option', { name: /Local — inclus, 100 % local/ })).toBeTruthy();
  });

  it('shows the load error while offline, then recovers on the "online" event', async () => {
    render(<KnowledgeBaseManager />);
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Modifier la source Alpha' }));
    await settle();

    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(screen.getByText(LOAD_ERROR)).toBeTruthy();

    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();

    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
    expect(screen.getByRole('option', { name: /Local — inclus, 100 % local/ })).toBeTruthy();
  });
});
