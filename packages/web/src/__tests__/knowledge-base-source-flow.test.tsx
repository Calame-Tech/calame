/**
 * "+ Add source" → "Knowledge base" flow, rendered against the real EE
 * KnowledgeBaseManager with a URL-routed fetch stub. Covers the async states
 * of the first source creation: initial load (failure + retry), save in
 * progress, success (the `{ source }` response is unwrapped) and failure.
 */
import { render as rtlRender, screen, fireEvent, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeBaseManager } from '@calame-ee/rag-core/web';
import { SOURCE_REQUEST_TIMEOUT_MS } from '../../../../ee/rag-core/src/web/SourceForm.js';
import { I18nProvider } from '../i18n/I18nProvider.js';

/** The source form's "?" help tips need the app's i18n context. */
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const LOCAL_SETTING = {
  name: 'local',
  label: 'Local',
  provider: 'local',
  capabilities: ['embeddings'],
  embeddingDimensions: 384,
  localModelAvailable: true,
};

const CREATED_SOURCE = {
  id: 'src_1',
  name: 'Docs',
  type: 'local',
  config: { rootPath: '/tmp/docs' },
  embeddingSettingName: 'local',
  embeddingModelVersion: 'm',
  embeddingDimensions: 384,
  pollingIntervalSeconds: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

let sources: unknown[] = [];
let jobs: unknown[] = [];
let syncPosts: string[] = [];
let overrides: Array<{ match: (url: string, method: string) => boolean; handler: Handler }> = [];

function route(url: string, init?: RequestInit): Promise<Response> | Response {
  const method = (init?.method ?? 'GET').toUpperCase();
  const override = overrides.find((o) => o.match(url, method));
  if (override) return override.handler(url, init);
  if (url.startsWith('/api/rag/sources?filter=deleted')) return json({ sources: [] });
  if (url === '/api/rag/sources' && method === 'GET') return json({ sources });
  if (url.startsWith('/api/ai-settings')) return json({ success: true, settings: [LOCAL_SETTING] });
  if (url.startsWith('/api/rag/jobs')) return json({ jobs });
  if (/\/api\/rag\/sources\/[^/]+\/sync$/.test(url) && method === 'POST') {
    syncPosts.push(url);
    const job = {
      id: `job_${syncPosts.length}`,
      sourceId: decodeURIComponent(url.split('/')[4] ?? ''),
      status: 'pending',
      progress: 0,
      totalDocuments: 0,
      processedDocuments: 0,
      skippedByEtag: 0,
      gcDeleted: 0,
      tokensEmbedded: 0,
      error: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: null,
    };
    jobs = [job, ...jobs];
    return json({ job }, 202);
  }
  if (/\/api\/rag\/sources\/[^/]+\/folders/.test(url)) return json({ folders: [] });
  if (/\/api\/rag\/sources\/[^/]+\/documents/.test(url)) return json({ documents: [] });
  return json({ error: 'not mocked' }, 503);
}

beforeEach(() => {
  // rag-core strings follow the saved app locale; these assertions use French.
  localStorage.setItem('calame-locale', 'fr');
  sources = [];
  jobs = [];
  syncPosts = [];
  overrides = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(route(String(input), init)),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A request that only settles when its abort signal fires (hung server). */
function hang(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });
}

async function openCreateForm() {
  fireEvent.click(await screen.findByRole('button', { name: '+ Nouvelle source' }));
  fireEvent.change(screen.getByLabelText(/Nom/), { target: { value: 'Docs' } });
  fireEvent.change(screen.getByLabelText(/^Chemin absolu du dossier/), {
    target: { value: '/tmp/docs' },
  });
}

describe('KnowledgeBaseManager — first source flow', () => {
  it('shows an explicit error with a retry action when the source list fails to load', async () => {
    let fail = true;
    overrides.push({
      match: (url, method) => url === '/api/rag/sources' && method === 'GET',
      handler: () => (fail ? Promise.reject(new TypeError('Failed to fetch')) : json({ sources })),
    });

    render(<KnowledgeBaseManager />);

    expect(await screen.findByText('Impossible de charger les sources.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch');
    // A failed fetch must not be presented as an empty knowledge base.
    expect(screen.queryByText(/Aucune source\./)).not.toBeInTheDocument();
    expect(screen.queryByText('Chargement des sources…')).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(await screen.findByText(/Aucune source\./)).toBeInTheDocument();
    expect(screen.queryByText('Impossible de charger les sources.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows saving, then selects the created source by its real id and name', async () => {
    let resolvePost: (res: Response) => void = () => {};
    overrides.push({
      match: (url, method) => url === '/api/rag/sources' && method === 'POST',
      handler: () =>
        new Promise<Response>((resolve) => {
          resolvePost = resolve;
        }),
    });

    render(<KnowledgeBaseManager />);
    await openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    const savingButton = await screen.findByRole('button', { name: 'Enregistrement…' });
    expect(savingButton).toBeDisabled();

    sources = [{ ...CREATED_SOURCE, folderCount: 0, documentCount: 0 }];
    // Server contract: POST answers `{ source }` (routes/rag-sources.ts).
    resolvePost(json({ source: CREATED_SOURCE }, 201));

    expect(await screen.findByRole('status')).toHaveTextContent('Source "Docs" enregistrée.');
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    // The new source is selected: its detail panel heading is rendered.
    expect(await screen.findAllByRole('heading', { name: 'Docs' })).not.toHaveLength(0);
    expect(screen.queryByText(/Sélectionnez une source à gauche/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument();
  });

  it('keeps the form open with a visible error and a working retry when creation fails', async () => {
    let attempts = 0;
    overrides.push({
      match: (url, method) => url === '/api/rag/sources' && method === 'POST',
      handler: () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: 'Connector validation failed: dossier introuvable' }, 400)
          : json({ source: CREATED_SOURCE }, 201);
      },
    });

    render(<KnowledgeBaseManager />);
    await openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La vérification de la source a échoué : dossier introuvable',
    );
    const retry = screen.getByRole('button', { name: 'Enregistrer' });
    expect(retry).toBeEnabled();

    sources = [{ ...CREATED_SOURCE, folderCount: 0, documentCount: 0 }];
    fireEvent.click(retry);
    expect(await screen.findByRole('status')).toHaveTextContent('Source "Docs" enregistrée.');
  });

  it('reports a missing source in the save response as an error instead of a success', async () => {
    overrides.push({
      match: (url, method) => url === '/api/rag/sources' && method === 'POST',
      handler: () => json({ source: null }, 201),
    });

    render(<KnowledgeBaseManager />);
    await openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Le serveur n'a pas renvoyé la source enregistrée.",
    );
    expect(screen.queryByText(/enregistrée\.$/)).not.toBeInTheDocument();
  });

  it('shows the real document counters of a running sync, and none when the total is unknown', async () => {
    sources = [{ ...CREATED_SOURCE, folderCount: 0, documentCount: 3 }];
    jobs = [
      {
        id: 'job_1',
        sourceId: 'src_1',
        status: 'running',
        progress: 0.3,
        totalDocuments: 10,
        processedDocuments: 3,
        skippedByEtag: 0,
        gcDeleted: 0,
        tokensEmbedded: 0,
        error: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: null,
      },
    ];

    const { unmount } = render(<KnowledgeBaseManager />);
    expect(await screen.findByText(/\(3 \/ 10 documents\)/)).toBeInTheDocument();
    unmount();

    jobs = [{ ...(jobs[0] as object), totalDocuments: 0, processedDocuments: 0, progress: 0 }];
    render(<KnowledgeBaseManager />);
    expect(await screen.findByText(/Synchronisation en cours…/)).toBeInTheDocument();
    expect(screen.queryByText(/documents\)/)).not.toBeInTheDocument();
  });

  it('ends a POST that never answers with an error and a retry instead of spinning forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let attempts = 0;
    overrides.push({
      match: (url, method) => url === '/api/rag/sources' && method === 'POST',
      handler: (url, init) => {
        attempts += 1;
        return attempts === 1 ? hang(url, init) : json({ source: CREATED_SOURCE }, 201);
      },
    });

    render(<KnowledgeBaseManager />);
    await openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('button', { name: 'Enregistrement…' })).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(SOURCE_REQUEST_TIMEOUT_MS);
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Le serveur n'a pas répondu après 90 s.");
    // The source may exist server-side despite the timeout: say so.
    expect(alert).toHaveTextContent('La source a peut-être été enregistrée');
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();

    sources = [{ ...CREATED_SOURCE, folderCount: 0, documentCount: 0 }];
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Source "Docs" enregistrée.');
    expect(attempts).toBe(2);
  });

  it('ends a "Tester" dry-run that never answers with an explicit failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    overrides.push({
      match: (url, method) => url === '/api/rag/sources/test-config' && method === 'POST',
      handler: hang,
    });

    render(<KnowledgeBaseManager />);
    await openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Tester' }));
    expect(await screen.findByRole('button', { name: 'Test…' })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(SOURCE_REQUEST_TIMEOUT_MS);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Le test n'a pas abouti après 90 s.",
    );
    expect(screen.getByRole('button', { name: 'Tester' })).toBeEnabled();
  });
});

describe('KnowledgeBaseManager — initial sync after creation', () => {
  function createSourceOnSave() {
    overrides.push({
      match: (url, method) => url === '/api/rag/sources' && method === 'POST',
      handler: () => {
        sources = [{ ...CREATED_SOURCE, folderCount: 0, documentCount: 0 }];
        return json({ source: CREATED_SOURCE }, 201);
      },
    });
  }

  it('triggers the existing POST /sync exactly once and shows it started', async () => {
    createSourceOnSave();

    render(<KnowledgeBaseManager />);
    await openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Source "Docs" enregistrée. Synchronisation initiale lancée.',
    );
    // The queued job is picked up by the job poll, without any extra click.
    expect((await screen.findAllByText(/Synchronisation en cours…/)).length).toBeGreaterThan(0);
    // Let re-renders and list refreshes settle: still a single trigger.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(syncPosts).toEqual(['/api/rag/sources/src_1/sync']);
  });

  it('treats a sync already running (watcher / scheduler) as started, without error', async () => {
    createSourceOnSave();
    overrides.push({
      match: (url, method) => url.endsWith('/sync') && method === 'POST',
      handler: (url) => {
        syncPosts.push(url);
        return json({ error: 'Sync already in progress for this source.' }, 409);
      },
    });

    render(<KnowledgeBaseManager />);
    await openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Sync déjà en cours pour "Docs".');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(syncPosts).toHaveLength(1);
  });

  it('keeps the source when the trigger fails and only retries on an explicit click', async () => {
    createSourceOnSave();
    let fail = true;
    overrides.push({
      match: (url, method) => url.endsWith('/sync') && method === 'POST',
      handler: (url) => {
        syncPosts.push(url);
        return fail
          ? json({ error: 'Embedding provider unavailable' }, 500)
          : json({ job: null }, 202);
      },
    });

    render(<KnowledgeBaseManager />);
    await openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'La source "Docs" est enregistrée, mais sa synchronisation initiale n\'a pas pu démarrer',
    );
    expect(alert).toHaveTextContent('Embedding provider unavailable');
    // The source stays listed and selected.
    expect(screen.getAllByRole('heading', { name: 'Docs' })).not.toHaveLength(0);
    // No automatic retry loop.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(syncPosts).toHaveLength(1);

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Relancer la synchronisation' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Synchronisation initiale lancée.');
    expect(screen.queryByText(/n'a pas pu démarrer/)).not.toBeInTheDocument();
    expect(syncPosts).toHaveLength(2);
  });

  it('explains an unreachable server in French, keeping "Failed to fetch" for the console', async () => {
    createSourceOnSave();
    overrides.push({
      match: (url, method) => url.endsWith('/sync') && method === 'POST',
      handler: (url) => {
        syncPosts.push(url);
        throw new TypeError('Failed to fetch');
      },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<KnowledgeBaseManager />);
      await openCreateForm();
      fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'La source "Docs" est enregistrée, mais sa synchronisation initiale n\'a pas pu démarrer : le serveur est injoignable.',
      );
      expect(alert).not.toHaveTextContent('Failed to fetch');
      expect(screen.getByRole('button', { name: 'Relancer la synchronisation' })).toBeEnabled();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('src_1'),
        expect.objectContaining({ message: 'Failed to fetch' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('offers an explicit retry when the sync job itself failed', async () => {
    sources = [{ ...CREATED_SOURCE, folderCount: 0, documentCount: 0 }];
    jobs = [
      {
        id: 'job_1',
        sourceId: 'src_1',
        status: 'failed',
        progress: 0,
        totalDocuments: 0,
        processedDocuments: 0,
        skippedByEtag: 0,
        gcDeleted: 0,
        tokensEmbedded: 0,
        error: 'boom',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
      },
    ];

    render(<KnowledgeBaseManager />);
    fireEvent.click(await screen.findByText('Docs'));

    const retry = await screen.findByRole('button', { name: 'Relancer la synchronisation' });
    expect(syncPosts).toHaveLength(0);
    fireEvent.click(retry);
    expect(await screen.findByRole('status')).toHaveTextContent('Sync lancée pour "Docs".');
    expect(syncPosts).toEqual(['/api/rag/sources/src_1/sync']);
  });
});

describe('KnowledgeBaseManager — English locale', () => {
  it('renders the list, sync status and trash in English', async () => {
    localStorage.setItem('calame-locale', 'en');
    sources = [{ ...CREATED_SOURCE, lastSyncAt: null, folderCount: 0, documentCount: 0 }];

    render(<KnowledgeBaseManager />);

    expect(await screen.findByText('Knowledge bases')).toBeInTheDocument();
    expect(await screen.findByLabelText('Never synced')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trash (0)' })).toBeInTheDocument();
    expect(screen.queryByText(/Jamais synchronisé|Corbeille/)).not.toBeInTheDocument();
  });
});

describe('KnowledgeBaseManager — source card counters', () => {
  it('shows the document and folder counts sent by the API', async () => {
    sources = [{ ...CREATED_SOURCE, folderCount: 3, documentCount: 15 }];

    render(<KnowledgeBaseManager />);

    expect(await screen.findByText('15 documents · 3 dossiers')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('omits the counters instead of printing "undefined" when they are missing', async () => {
    sources = [{ ...CREATED_SOURCE }];

    render(<KnowledgeBaseManager />);

    expect(await screen.findByText('Docs')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    expect(screen.queryByText(/document.* · .*dossier/)).not.toBeInTheDocument();
  });
});

describe('KnowledgeBaseManager — built-in embedding label', () => {
  it('shows the server-seeded French label in English when the UI is in English', async () => {
    localStorage.setItem('calame-locale', 'en');
    overrides.push({
      match: (url) => url.startsWith('/api/ai-settings'),
      handler: () =>
        json({
          success: true,
          settings: [{ ...LOCAL_SETTING, label: 'Embeddings locaux (inclus)' }],
        }),
    });

    render(<KnowledgeBaseManager />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New source' }));

    expect(
      await screen.findByRole('option', { name: /^Local embeddings \(built in\)/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Embeddings locaux/ })).not.toBeInTheDocument();
  });
});

describe('KnowledgeBaseManager — next step towards a data configuration', () => {
  it('offers to create a configuration with an indexed source, and only navigates on click', async () => {
    sources = [{ ...CREATED_SOURCE, folderCount: 1, documentCount: 4 }];
    const onCreateProfileFromSource = vi.fn();

    render(<KnowledgeBaseManager onCreateProfileFromSource={onCreateProfileFromSource} />);
    fireEvent.click(await screen.findByText('Docs'));

    const cta = await screen.findByRole('button', {
      name: 'Créer une configuration de données avec cette source',
    });
    expect(onCreateProfileFromSource).not.toHaveBeenCalled();
    fireEvent.click(cta);
    expect(onCreateProfileFromSource).toHaveBeenCalledWith({ id: 'src_1', name: 'Docs' });
  });

  it('does not offer it while the source has no indexed document yet', async () => {
    sources = [{ ...CREATED_SOURCE, folderCount: 0, documentCount: 0 }];

    render(<KnowledgeBaseManager onCreateProfileFromSource={vi.fn()} />);
    fireEvent.click(await screen.findByText('Docs'));

    // The detail panel of the source is open.
    expect(await screen.findByText('Aucune indexation en cours.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Créer une configuration de données avec cette source',
      }),
    ).not.toBeInTheDocument();
  });
});
