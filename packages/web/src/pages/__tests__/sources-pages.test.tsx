// SourcesPage / ConnectionsPage / KnowledgePage component tests (Phase 3 #16).
// The three pages are thin wrappers around components/SourcesPage, so they are
// grouped in a single file.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SourcesPage from '../SourcesPage.js';
import ConnectionsPage from '../ConnectionsPage.js';
import KnowledgePage from '../KnowledgePage.js';
import { useSession } from '../../context/SessionContext.js';
import { makeSession, installFetchMock, flushEffects } from './testUtils.js';

vi.mock('../../context/SessionContext.js', () => ({
  useSession: vi.fn(),
}));

// The shared lazy KnowledgeBaseManager targets the EE package — mock it so no
// BUSL/EE code is pulled into the test run.
vi.mock('@calame-ee/rag-core/web', () => ({
  KnowledgeBaseManager: () => <div>KB Manager (mock)</div>,
  RagAccessSelector: () => <div>Rag selector (mock)</div>,
}));

describe('SourcesPage', () => {
  beforeEach(() => {
    installFetchMock();
    vi.mocked(useSession).mockReturnValue(makeSession());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the databases tab with a disabled knowledge tab when RAG is off', async () => {
    render(
      <SourcesPage
        view={{ page: 'sources', tab: 'databases' }}
        setView={vi.fn()}
        connections={[]}
        setConnections={vi.fn()}
        handleSchemaLoaded={vi.fn()}
      />,
    );
    await flushEffects();
    expect(screen.getByText('Sources')).toBeTruthy();
    expect(screen.getAllByText('Databases').length).toBeGreaterThanOrEqual(1);
    const kbTab = screen.getByText('Knowledge bases').closest('button');
    expect(kbTab?.getAttribute('aria-disabled')).toBe('true');
  });

  it('switches to the knowledge tab via setView when RAG is enabled', async () => {
    vi.mocked(useSession).mockReturnValue(makeSession({ ragEnabled: true }));
    const setView = vi.fn();
    render(
      <SourcesPage
        view={{ page: 'sources', tab: 'databases' }}
        setView={setView}
        connections={[]}
        setConnections={vi.fn()}
        handleSchemaLoaded={vi.fn()}
      />,
    );
    await flushEffects();
    fireEvent.click(screen.getByText('Knowledge bases'));
    expect(setView).toHaveBeenCalledWith({ page: 'sources', tab: 'knowledge' });
  });
});

describe('ConnectionsPage (legacy alias for sources/databases)', () => {
  beforeEach(() => {
    installFetchMock();
    vi.mocked(useSession).mockReturnValue(makeSession({ ragEnabled: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the databases tab', async () => {
    render(
      <ConnectionsPage
        view={{ page: 'connections' }}
        setView={vi.fn()}
        connections={[]}
        setConnections={vi.fn()}
        handleSchemaLoaded={vi.fn()}
      />,
    );
    await flushEffects();
    expect(screen.getByText('Sources')).toBeTruthy();
    expect(screen.getAllByText('Databases').length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to the sources knowledge tab when clicking the knowledge tab', async () => {
    const setView = vi.fn();
    render(
      <ConnectionsPage
        view={{ page: 'connections' }}
        setView={setView}
        connections={[]}
        setConnections={vi.fn()}
        handleSchemaLoaded={vi.fn()}
      />,
    );
    await flushEffects();
    fireEvent.click(screen.getByText('Knowledge bases'));
    expect(setView).toHaveBeenCalledWith({ page: 'sources', tab: 'knowledge' });
  });
});

describe('KnowledgePage (legacy alias for sources/knowledge)', () => {
  beforeEach(() => {
    installFetchMock();
    vi.mocked(useSession).mockReturnValue(makeSession({ ragEnabled: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the knowledge tab with the lazy KnowledgeBaseManager', async () => {
    render(
      <KnowledgePage
        setView={vi.fn()}
        connections={[]}
        setConnections={vi.fn()}
        handleSchemaLoaded={vi.fn()}
      />,
    );
    expect(await screen.findByText('KB Manager (mock)')).toBeTruthy();
    await flushEffects();
  });

  it('navigates back to the databases tab via setView', async () => {
    const setView = vi.fn();
    render(
      <KnowledgePage
        setView={setView}
        connections={[]}
        setConnections={vi.fn()}
        handleSchemaLoaded={vi.fn()}
      />,
    );
    await flushEffects();
    fireEvent.click(screen.getByText('Databases'));
    expect(setView).toHaveBeenCalledWith({ page: 'sources', tab: 'databases' });
  });
});
