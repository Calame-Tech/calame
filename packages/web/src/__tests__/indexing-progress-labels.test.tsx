/**
 * Indexing progress labels (tester feedback #10): a job whose total is still
 * unknown (totalDocuments 0 while active) must read as "preparing", never as
 * an ambiguous "0/0" progress nor as an empty source. Each state comes from the
 * job's real counters: preparing, progress, no documents, completed, failed.
 */
import { render as rtlRender, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IngestionStatusCard, RagAccessSelector } from '@calame-ee/rag-core/web';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { clearKnownRagSources } from '../lib/known-rag-sources.js';

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function job(id: string, status: string, processed: number, total: number, error: string | null) {
  return {
    id,
    sourceId: id,
    status,
    progress: total > 0 ? processed / total : 0,
    totalDocuments: total,
    processedDocuments: processed,
    skippedByEtag: 0,
    gcDeleted: 0,
    tokensEmbedded: 0,
    error,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
  };
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
    lastSyncAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    folderCount: 0,
    documentCount: 0,
  };
}

let jobs: ReturnType<typeof job>[] = [];

beforeEach(() => {
  localStorage.setItem('calame-locale', 'en');
  clearKnownRagSources();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/rag/sources')
        return Promise.resolve(
          json({ sources: [source('prep', 'Preparing'), source('run', 'Running')] }),
        );
      if (url.startsWith('/api/rag/sources?filter=deleted'))
        return Promise.resolve(json({ sources: [] }));
      if (url.startsWith('/api/rag/jobs')) return Promise.resolve(json({ jobs }));
      return Promise.resolve(json({}));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('IngestionStatusCard — readable progress', () => {
  it('shows discovering, progress, no documents, completed and failed without 0/0', async () => {
    jobs = [
      job('prep', 'running', 0, 0, null),
      job('run', 'running', 2, 4, null),
      job('empty', 'completed', 0, 0, null),
      job('done', 'completed', 4, 4, null),
      job('fail', 'failed', 0, 0, 'boom'),
    ];
    render(<IngestionStatusCard pollIntervalMs={60_000} />);

    const row = async (id: string) => (await screen.findByText(id)).closest('li') as HTMLElement;

    expect(within(await row('prep')).getByText('Discovering documents…')).toBeInTheDocument();
    expect(within(await row('run')).getByText('2 / 4 documents')).toBeInTheDocument();
    expect(within(await row('empty')).getByText('No documents found')).toBeInTheDocument();
    expect(within(await row('empty')).getByText('Completed')).toBeInTheDocument();
    expect(within(await row('done')).getByText('4 / 4 documents')).toBeInTheDocument();
    const failed = await row('fail');
    expect(within(failed).getByText('Failed')).toBeInTheDocument();
    expect(within(failed).queryByText('No documents found')).toBeNull();

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\b0 \/ [01] documents/);
    expect(text).not.toMatch(/indexating/i);
  });
});

describe('RagAccessSelector — source indexing badge', () => {
  it('says "preparing indexing" while the total is unknown, and counts once known', async () => {
    jobs = [job('prep', 'running', 0, 0, null), job('run', 'running', 1, 4, null)];
    render(<RagAccessSelector profileName="demo" initialScopes={{}} initialSources={[]} />);

    const prep = (await screen.findByText('Preparing')).closest('li') as HTMLElement;
    expect(await within(prep).findByText('preparing indexing…')).toBeInTheDocument();
    const run = screen.getByText('Running').closest('li') as HTMLElement;
    expect(await within(run).findByText('indexing 1/4')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('0/0');
  });
});
