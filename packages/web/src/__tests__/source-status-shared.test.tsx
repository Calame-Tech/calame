/**
 * One source of truth for knowledge-base sources (tester feedback #12): the
 * Sources page (KnowledgeBaseManager) and the data-configuration knowledge
 * tab (RagAccessSelector) read the same known list and the same job-status
 * rule, so a source shows the same status in both views. Its inclusion in a
 * configuration stays a separate, per-configuration setting.
 */
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeBaseManager, RagAccessSelector } from '@calame-ee/rag-core/web';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { clearKnownRagSources, knownRagSourcesCache } from '../lib/known-rag-sources.js';

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function source(id: string, name: string) {
  return {
    id,
    name,
    type: 'local',
    config: { rootPath: `/tmp/${id}` },
    embeddingSettingName: 'local',
    embeddingModelVersion: 'm',
    embeddingDimensions: 384,
    pollingIntervalSeconds: null,
    lastSyncAt: new Date().toISOString(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    folderCount: 0,
    documentCount: 0,
  };
}

function job(id: string, sourceId: string, status: string, error: string | null = null) {
  return {
    id,
    sourceId,
    status,
    progress: 0,
    totalDocuments: 4,
    processedDocuments: 1,
    skippedByEtag: 0,
    gcDeleted: 0,
    tokensEmbedded: 0,
    error,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
  };
}

type Source = ReturnType<typeof source>;
type Cache = NonNullable<ComponentProps<typeof KnowledgeBaseManager>['sourcesCache']>;

const ALPHA = source('a', 'Alpha');
const BETA = source('b', 'Beta');
const GAMMA = source('c', 'Gamma');

// Newest first, as GET /api/rag/jobs returns them. Alpha failed once, then a
// later sync succeeded: it is synced. Beta's latest sync failed. Gamma is syncing.
const JOBS = [
  job('j4', 'c', 'running'),
  job('j3', 'a', 'completed'),
  job('j2', 'b', 'failed', 'disk unreachable'),
  job('j1', 'a', 'failed', 'old failure'),
];

let serverSources: Source[] = [];

function route(url: string): Response {
  if (url === '/api/rag/sources') return json({ sources: serverSources });
  if (url.startsWith('/api/rag/sources?filter=deleted')) return json({ sources: [] });
  if (url.startsWith('/api/rag/jobs')) return json({ jobs: JOBS });
  if (url.startsWith('/api/ai-settings')) return json({ success: true, settings: [] });
  return json({ error: 'not mocked' }, 503);
}

beforeEach(() => {
  localStorage.setItem('calame-locale', 'fr');
  clearKnownRagSources();
  serverSources = [ALPHA, BETA, GAMMA];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => Promise.resolve(route(String(input)))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sharedCache(): Cache {
  return knownRagSourcesCache<Source>('alice@example.com', 'default') as unknown as Cache;
}

/** Status shown for a source in Sources: 'failed' | 'syncing' | 'ok'. */
function sourcesPageStatus(name: string): string {
  const row = within(screen.getByTestId('sources')).getByText(name).closest('[role="button"]');
  const text = (row as HTMLElement).textContent ?? '';
  if (text.includes('Échec de la dernière sync')) return 'failed';
  if (text.includes('Synchronisation en cours')) return 'syncing';
  return 'ok';
}

/** Status shown for the same source in the configuration's knowledge tab. */
function configStatus(name: string): string {
  const row = within(screen.getByTestId('config')).getByText(name).closest('li');
  const text = (row as HTMLElement).textContent ?? '';
  if (text.includes('sync échouée')) return 'failed';
  if (text.includes('indexation')) return 'syncing';
  return 'ok';
}

describe('Sources and MCP configuration — shared source status', () => {
  it('shows the same status for each source in both views', async () => {
    const cache = sharedCache();
    render(
      <>
        <div data-testid="sources">
          <KnowledgeBaseManager sourcesCache={cache} />
        </div>
        <div data-testid="config">
          <RagAccessSelector
            profileName="demo"
            initialScopes={{}}
            initialSources={['b']}
            sourcesCache={cache}
          />
        </div>
      </>,
    );

    await waitFor(() => {
      expect(sourcesPageStatus('Gamma')).toBe('syncing');
      expect(configStatus('Gamma')).toBe('syncing');
    });
    // An old failure superseded by a successful sync is not "failed" anywhere.
    expect(sourcesPageStatus('Alpha')).toBe('ok');
    expect(configStatus('Alpha')).toBe('ok');
    expect(sourcesPageStatus('Beta')).toBe('failed');
    expect(configStatus('Beta')).toBe('failed');
  });

  it('keeps the inclusion in the configuration distinct from the source status', async () => {
    render(
      <div data-testid="config">
        <RagAccessSelector
          profileName="demo"
          initialScopes={{}}
          initialSources={['b']}
          sourcesCache={sharedCache()}
        />
      </div>,
    );

    await waitFor(() => expect(configStatus('Beta')).toBe('failed'));
    // Failed source still selected; synced source still not selected.
    expect(screen.getByRole('checkbox', { name: 'Inclure la source Beta' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('checkbox', { name: 'Inclure la source Alpha' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('starts from the list known by Sources and refreshes it for both views', async () => {
    const cache = sharedCache();
    cache.set([ALPHA] as never);
    serverSources = [ALPHA, BETA];

    const config = render(
      <div data-testid="config">
        <RagAccessSelector
          profileName="demo"
          initialScopes={{}}
          initialSources={[]}
          sourcesCache={cache}
        />
      </div>,
    );

    // The known list is shown at once (no empty "loading" view), with a notice…
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Synchronisation de la liste des sources…')).toBeInTheDocument();
    // …then replaced by the server answer, which the Sources page reuses.
    expect(await screen.findByText('Beta')).toBeInTheDocument();
    expect(cache.get()?.map((s) => s.id)).toEqual(['a', 'b']);
    config.unmount();

    serverSources = [ALPHA, BETA];
    render(
      <div data-testid="sources">
        <KnowledgeBaseManager sourcesCache={cache} />
      </div>,
    );
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('keeps the known list when the refresh fails', async () => {
    const cache = sharedCache();
    cache.set([ALPHA] as never);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input) === '/api/rag/sources'
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve(route(String(input))),
      ),
    );

    render(
      <RagAccessSelector
        profileName="demo"
        initialScopes={{}}
        initialSources={[]}
        sourcesCache={cache}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('le serveur Calame ne répond pas');
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(cache.get()?.map((s) => s.id)).toEqual(['a']);
  });
});
