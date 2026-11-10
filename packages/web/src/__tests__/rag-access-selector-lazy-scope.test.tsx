/**
 * Configuration → Knowledge bases (RagAccessSelector): folders are loaded one
 * level at a time, on expand (tester feedback #10). The selection saved below
 * a folder not expanded yet must stay visible (partial), survive a save, and
 * a click made before the load must not be undone by it.
 */
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RagAccessSelector } from '@calame-ee/rag-core/web';
import { I18nProvider } from '../i18n/I18nProvider.js';

// The selector's "?" help tips use the host app's translations.
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

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
  folderCount: 3,
  documentCount: 1,
};

const folder = (id: string, parentId: string | null, path: string) => ({
  id,
  sourceId: 'src_1',
  parentId,
  path,
  name: id,
  tenantId: 'default',
  createdAt: '2026-01-01T00:00:00.000Z',
});

// root ─ a ─ sub (s1.md), plus an empty sibling root folder `other`
const FOLDERS: Record<string, unknown[]> = {
  '': [folder('root', null, 'root'), folder('other', null, 'other')],
  root: [folder('a', 'root', 'root/a')],
  a: [folder('sub', 'a', 'root/a/sub')],
  sub: [],
};
const DOCUMENTS: Record<string, unknown[]> = {
  '': [],
  root: [],
  a: [],
  sub: [
    {
      id: 's1',
      sourceId: 'src_1',
      folderId: 'sub',
      path: 'root/a/sub/s1.md',
      name: 's1.md',
      mimeType: 'text/markdown',
      size: 1,
      hash: 'h',
      etag: null,
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      ingestError: null,
    },
  ],
};

function route(input: string): Response {
  const url = new URL(input, 'http://localhost');
  const folderId = url.searchParams.get('folder') ?? '';
  if (url.pathname === '/api/rag/sources') return json({ sources: [SOURCE] });
  if (url.pathname.startsWith('/api/rag/jobs')) return json({ jobs: [] });
  if (url.pathname.endsWith('/folders')) return json({ folders: FOLDERS[folderId] ?? [] });
  if (url.pathname.endsWith('/documents')) return json({ documents: DOCUMENTS[folderId] ?? [] });
  return json({ error: 'not mocked' }, 503);
}

const SAVED_SCOPES = {
  src_1: {
    kind: 'document' as const,
    mode: 'allowList' as const,
    allowedFolders: ['root/a/sub'],
    allowedDocuments: [],
  },
};

type Selection = { sources: string[]; scopes: Record<string, unknown> };

function renderSelector(onSelectionChange: (s: Selection) => void) {
  return render(
    <RagAccessSelector
      profileName="demo"
      initialScopes={SAVED_SCOPES}
      initialSources={['src_1']}
      onSelectionChange={onSelectionChange}
    />,
  );
}

const folderBox = (name: string) =>
  screen.findByRole('checkbox', { name: `Include folder ${name}` });

async function expandFolder(name: string) {
  const box = await folderBox(name);
  const row = box.parentElement!;
  fireEvent.click(row.querySelector('button[aria-expanded]')!);
}

beforeEach(() => {
  localStorage.setItem('calame-locale', 'en');
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => Promise.resolve(route(String(input)))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RagAccessSelector — folders loaded on demand', () => {
  it('keeps the saved allowlist of a source that was never expanded', async () => {
    const onSelectionChange = vi.fn();
    renderSelector(onSelectionChange);
    await screen.findByRole('button', { name: 'Expand source' });

    // An edit elsewhere (profile-wide PII toggle) reports the whole selection.
    const piiToggle = screen.getAllByRole('checkbox').find((el) => el.tagName === 'INPUT')!;
    fireEvent.click(piiToggle);

    await waitFor(() => expect(onSelectionChange).toHaveBeenCalled());
    const last = onSelectionChange.mock.calls.at(-1)![0] as Selection;
    expect(last.scopes['src_1']).toEqual({
      kind: 'document',
      mode: 'allowList',
      allowedFolders: ['root/a/sub'],
      allowedDocuments: [],
      piiMaskingMode: 'off',
    });
  });

  it('shows a nested selection as partial, then checked once its folders are loaded', async () => {
    renderSelector(vi.fn());
    fireEvent.click(await screen.findByRole('button', { name: 'Expand source' }));

    expect(await folderBox('root')).toHaveAttribute('aria-checked', 'mixed');
    await expandFolder('root');
    expect(await folderBox('a')).toHaveAttribute('aria-checked', 'mixed');
    await expandFolder('a');
    expect(await folderBox('sub')).toHaveAttribute('aria-checked', 'true');
    expect(await folderBox('a')).toHaveAttribute('aria-checked', 'true');
  });

  it('unchecking a folder before expanding it is not undone by the load', async () => {
    const onSelectionChange = vi.fn();
    renderSelector(onSelectionChange);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand source' }));

    fireEvent.click(await folderBox('root')); // partial → unchecked
    await expandFolder('root');
    await expandFolder('a');
    expect(await folderBox('sub')).toHaveAttribute('aria-checked', 'false');
    expect(await folderBox('root')).toHaveAttribute('aria-checked', 'false');

    const last = onSelectionChange.mock.calls.at(-1)![0] as Selection;
    expect(last.scopes['src_1']).toMatchObject({ allowedFolders: [], allowedDocuments: [] });
  });

  it('checking a folder selects every descendant loaded afterwards', async () => {
    const onSelectionChange = vi.fn();
    renderSelector(onSelectionChange);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand source' }));

    fireEvent.click(await folderBox('root')); // partial → unchecked
    fireEvent.click(await folderBox('root')); // unchecked → checked
    await expandFolder('root');
    await expandFolder('a');
    await expandFolder('sub');
    await screen.findByText('s1.md');
    for (const name of ['root', 'a', 'sub']) {
      expect(await folderBox(name)).toHaveAttribute('aria-checked', 'true');
    }

    const last = onSelectionChange.mock.calls.at(-1)![0] as Selection;
    expect(last.scopes['src_1']).toMatchObject({
      mode: 'allowList',
      allowedFolders: ['root'],
      allowedDocuments: [],
    });
  });

  it('checking a whole source before expanding it includes all its folders and descendants', async () => {
    const onSelectionChange = vi.fn();
    render(
      <RagAccessSelector
        profileName="demo"
        initialScopes={{}}
        initialSources={[]}
        onSelectionChange={onSelectionChange}
      />,
    );
    const sourceBox = await screen.findByRole('checkbox', { name: 'Include source Docs' });
    expect(sourceBox).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(sourceBox);
    expect(await folderBox('root')).toHaveAttribute('aria-checked', 'true');
    await expandFolder('root');
    await expandFolder('a');
    await expandFolder('sub');
    await screen.findByText('s1.md');
    for (const name of ['root', 'a', 'sub']) {
      expect(await folderBox(name)).toHaveAttribute('aria-checked', 'true');
    }
    expect(sourceBox).toHaveAttribute('aria-checked', 'true');

    const last = onSelectionChange.mock.calls.at(-1)![0] as Selection;
    expect(last.sources).toEqual(['src_1']);
    // The whole source, not a frozen list of today's folders: later additions stay covered.
    expect(last.scopes['src_1']).toEqual({
      kind: 'document',
      mode: 'allowAll',
      allowedFolders: [],
      allowedDocuments: [],
    });
  });

  it('checking a source while its contents are loading includes all its folders', async () => {
    let releaseRoot!: () => void;
    const rootHeld = new Promise<void>((resolve) => (releaseRoot = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname.endsWith('/folders') && !url.searchParams.has('folder')) await rootHeld;
        return route(String(input));
      }),
    );
    const onSelectionChange = vi.fn();
    render(
      <RagAccessSelector
        profileName="demo"
        initialScopes={{}}
        initialSources={[]}
        onSelectionChange={onSelectionChange}
      />,
    );
    const sourceBox = await screen.findByRole('checkbox', { name: 'Include source Docs' });

    // Expanded unchecked (load starts without "include all"), then checked mid-load.
    fireEvent.click(screen.getByRole('button', { name: 'Expand source' }));
    fireEvent.click(sourceBox);
    releaseRoot();

    expect(await folderBox('root')).toHaveAttribute('aria-checked', 'true');
    await expandFolder('root');
    await expandFolder('a');
    expect(await folderBox('sub')).toHaveAttribute('aria-checked', 'true');
    expect(sourceBox).toHaveAttribute('aria-checked', 'true');

    const last = onSelectionChange.mock.calls.at(-1)![0] as Selection;
    expect(last.sources).toEqual(['src_1']);
    expect(last.scopes['src_1']).toMatchObject({
      mode: 'allowAll',
      allowedFolders: [],
      allowedDocuments: [],
    });
  });

  it('expanding a source included with an allowAll scope shows its folders checked and keeps allowAll', async () => {
    const onSelectionChange = vi.fn();
    render(
      <RagAccessSelector
        profileName="demo"
        initialScopes={{
          src_1: { kind: 'document', mode: 'allowAll', allowedFolders: [], allowedDocuments: [] },
        }}
        initialSources={['src_1']}
        onSelectionChange={onSelectionChange}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Expand source' }));
    expect(await folderBox('root')).toHaveAttribute('aria-checked', 'true');
    expect(await folderBox('other')).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByRole('checkbox', { name: 'Include source Docs' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Saving after the expand must not freeze the scope into today's folders.
    const piiToggle = screen.getAllByRole('checkbox').find((el) => el.tagName === 'INPUT')!;
    fireEvent.click(piiToggle);
    await waitFor(() => expect(onSelectionChange).toHaveBeenCalled());
    const last = onSelectionChange.mock.calls.at(-1)![0] as Selection;
    expect(last.scopes['src_1']).toEqual({
      kind: 'document',
      mode: 'allowAll',
      allowedFolders: [],
      allowedDocuments: [],
      piiMaskingMode: 'off',
    });
  });
});
