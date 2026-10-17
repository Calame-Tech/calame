/**
 * Configuration → Knowledge bases (RagAccessSelector): French wording of the
 * heading and the selection summary ("10 documents sélectionnés" used to be
 * rendered without the space before the participle).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RagAccessSelector } from '@calame-ee/rag-core/web';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SOURCE = {
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
  folderCount: 0,
  documentCount: 10,
};

const DOCUMENTS = Array.from({ length: 10 }, (_, i) => ({
  id: `doc_${i}`,
  sourceId: 'src_1',
  folderId: null,
  path: `doc${i}.md`,
  name: `doc${i}.md`,
  mimeType: 'text/markdown',
  size: 1,
  hash: 'h',
  etag: null,
  lastIndexedAt: '2026-01-01T00:00:00.000Z',
}));

function route(url: string): Response {
  if (url === '/api/rag/sources') return json({ sources: [SOURCE] });
  if (url.startsWith('/api/rag/jobs')) return json({ jobs: [] });
  if (url.endsWith('/folders')) return json({ folders: [] });
  if (url.endsWith('/documents')) return json({ documents: DOCUMENTS });
  return json({ error: 'not mocked' }, 503);
}

beforeEach(() => {
  localStorage.setItem('calame-locale', 'fr');
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => Promise.resolve(route(String(input)))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RagAccessSelector — French wording', () => {
  it('uses "profil" / "bases de connaissances" and spaces the selection summary', async () => {
    const { container } = render(
      <RagAccessSelector profileName="demo" initialScopes={{}} initialSources={['src_1']} />,
    );

    expect(
      await screen.findByText(/Bases de connaissances accessibles — profil/),
    ).toBeInTheDocument();

    // The source list loads asynchronously (shared with the Sources page): wait for it.
    fireEvent.click(await screen.findByRole('button', { name: 'Développer la source' }));

    await screen.findByText('doc0.md');
    expect(container.textContent).toContain('10 documents sélectionnés');
    expect(container.textContent).not.toMatch(/documentssélectionnés/);
    expect(container.textContent).not.toMatch(/Scopes RAG|knowledge bases|\bprofile\b/);
  });
});
