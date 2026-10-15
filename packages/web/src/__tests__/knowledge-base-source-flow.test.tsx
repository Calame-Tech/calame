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
let overrides: Array<{ match: (url: string, method: string) => boolean; handler: Handler }> = [];

function route(url: string, init?: RequestInit): Promise<Response> | Response {
  const method = (init?.method ?? 'GET').toUpperCase();
  const override = overrides.find((o) => o.match(url, method));
  if (override) return override.handler(url, init);
  if (url.startsWith('/api/rag/sources?filter=deleted')) return json({ sources: [] });
  if (url === '/api/rag/sources' && method === 'GET') return json({ sources });
  if (url.startsWith('/api/ai-settings')) return json({ success: true, settings: [LOCAL_SETTING] });
  if (url.startsWith('/api/rag/jobs')) return json({ jobs });
  if (/\/api\/rag\/sources\/[^/]+\/folders/.test(url)) return json({ folders: [] });
  if (/\/api\/rag\/sources\/[^/]+\/documents/.test(url)) return json({ documents: [] });
  return json({ error: 'not mocked' }, 503);
}

beforeEach(() => {
  // rag-core strings follow the saved app locale; these assertions use French.
  localStorage.setItem('calame-locale', 'fr');
  sources = [];
  jobs = [];
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
      'Connector validation failed: dossier introuvable',
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
