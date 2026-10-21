/**
 * Knowledge-base list refresh (tester feedback #02): during a resync / remount
 * the known list must stay on screen with a visible "syncing" notice, a
 * failure must not clear it, a stale answer must not overwrite a fresher one,
 * the authoritative answer replaces it even when empty, and nothing leaks
 * from one account to another. Rendered against the real EE manager.
 */
import { render as rtlRender, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeBaseManager } from '@calame-ee/rag-core/web';
import SourcesPage from '../components/SourcesPage.js';
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    folderCount: 0,
    documentCount: 0,
  };
}

type Source = ReturnType<typeof source>;
type Cache = NonNullable<ComponentProps<typeof KnowledgeBaseManager>['sourcesCache']>;

/** Pending GET /api/rag/sources requests, settled by the test in any order. */
let listRequests: Array<{ resolve: (res: Response) => void; reject: (err: unknown) => void }> = [];

function route(url: string, init?: RequestInit): Promise<Response> | Response {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (url === '/api/rag/sources' && method === 'GET') {
    return new Promise<Response>((resolve, reject) => listRequests.push({ resolve, reject }));
  }
  if (url.startsWith('/api/rag/sources?filter=deleted')) return json({ sources: [] });
  if (url.startsWith('/api/ai-settings')) return json({ success: true, settings: [] });
  if (url.startsWith('/api/rag/jobs')) return json({ jobs: [] });
  if (/\/api\/rag\/sources\/[^/]+$/.test(url) && method === 'DELETE') return json({ ok: true });
  return json({ error: 'not mocked' }, 503);
}

beforeEach(() => {
  localStorage.setItem('calame-locale', 'fr');
  listRequests = [];
  clearKnownRagSources();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(route(String(input), init)),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function answerList(index: number, sources: Source[]) {
  await act(async () => {
    listRequests[index]!.resolve(json({ sources }));
  });
}

function seededCache(sources: Source[]): Cache {
  const cache = knownRagSourcesCache<Source>('alice@example.com', 'default');
  cache.set(sources);
  return cache as unknown as Cache;
}

describe('KnowledgeBaseManager — list refresh', () => {
  it('keeps the known list visible with a syncing notice, then applies the server answer', async () => {
    const cache = seededCache([source('a', 'Alpha'), source('b', 'Beta')]);
    render(<KnowledgeBaseManager sourcesCache={cache} />);

    // Remount during a resync: the last known list stays on screen.
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Synchronisation de la liste des sources…')).toBeInTheDocument();
    expect(screen.queryByText('Chargement des sources…')).not.toBeInTheDocument();

    await waitFor(() => expect(listRequests).toHaveLength(1));
    await answerList(0, [source('a', 'Alpha'), source('c', 'Gamma')]);

    expect(await screen.findByText('Gamma')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(screen.queryByText('Synchronisation de la liste des sources…')).not.toBeInTheDocument();
    expect(cache.get()?.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('applies an authoritative empty answer (real deletions are not masked)', async () => {
    const cache = seededCache([source('a', 'Alpha')]);
    render(<KnowledgeBaseManager sourcesCache={cache} />);
    await waitFor(() => expect(listRequests).toHaveLength(1));

    await answerList(0, []);

    expect(await screen.findByText(/Aucune source\./)).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(cache.get()).toEqual([]);
  });

  it('keeps the known list when the refresh fails and says so', async () => {
    const cache = seededCache([source('a', 'Alpha')]);
    render(<KnowledgeBaseManager sourcesCache={cache} />);
    await waitFor(() => expect(listRequests).toHaveLength(1));

    await act(async () => {
      listRequests[0]!.reject(new TypeError('Failed to fetch'));
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Impossible de rafraîchir la liste des sources (le serveur Calame ne répond pas). Dernière liste connue affichée.',
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Impossible de charger les sources.')).not.toBeInTheDocument();
    expect(screen.queryByText('Synchronisation de la liste des sources…')).not.toBeInTheDocument();
    expect(cache.get()?.map((s) => s.id)).toEqual(['a']);
  });

  it('ignores a stale answer that arrives after a fresher one', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const cache = seededCache([source('a', 'Alpha'), source('b', 'Beta')]);
    render(<KnowledgeBaseManager sourcesCache={cache} />);
    await waitFor(() => expect(listRequests).toHaveLength(1));

    // Delete Beta while the initial refresh is still pending → second refresh.
    const betaCard = screen.getByText('Beta').closest('[role="button"]') as HTMLElement;
    fireEvent.click(
      Array.from(betaCard.querySelectorAll('button')).find((b) => b.textContent === 'Supprimer')!,
    );
    await waitFor(() => expect(listRequests).toHaveLength(2));

    // Fresher answer first, then the stale one issued before the deletion.
    await answerList(1, [source('a', 'Alpha')]);
    await waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument());
    await answerList(0, [source('a', 'Alpha'), source('b', 'Beta')]);

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(cache.get()?.map((s) => s.id)).toEqual(['a']);
  });
});

describe('SourcesPage — known knowledge-base list per account', () => {
  const baseProps = {
    currentTab: 'knowledge' as const,
    onTabChange: () => {},
    connections: [],
    onConnectionsChange: () => {},
    onSchemaLoaded: () => {},
    ragEnabled: true,
    KnowledgeBaseManagerComponent: KnowledgeBaseManager,
  };

  it('never shows the list of the previous account, and the purge wipes every list', async () => {
    const { rerender } = render(<SourcesPage {...baseProps} account="alice@example.com" />);
    await waitFor(() => expect(listRequests.length).toBeGreaterThan(0));
    await act(async () => {
      for (const req of listRequests) req.resolve(json({ sources: [source('a', 'Alpha')] }));
    });
    expect(await screen.findByText('Alpha')).toBeInTheDocument();

    // Another account signs in: its own (unknown) list, never Alice's.
    rerender(<SourcesPage {...baseProps} account="bob@example.com" />);
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('Chargement des sources…')).toBeInTheDocument();

    expect(knownRagSourcesCache('alice@example.com', 'default').get()).toHaveLength(1);
    expect(knownRagSourcesCache('bob@example.com', 'default').get()).toBeUndefined();
    clearKnownRagSources();
    expect(knownRagSourcesCache('alice@example.com', 'default').get()).toBeUndefined();
  });
});
