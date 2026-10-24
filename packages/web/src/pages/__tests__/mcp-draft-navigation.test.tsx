// Tester feedback #11: a half-filled "new MCP server" form must survive a
// detour through Sources and Data configurations, without creating anything
// early and without leaking into another account, workspace or configuration.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { screen, fireEvent, act } from '@testing-library/react';
import McpListPage from '../McpListPage.js';
import SourcesPage from '../SourcesPage.js';
import ConfigurationsPage from '../ConfigurationsPage.js';
import { useSession } from '../../context/SessionContext.js';
import { clearMcpDrafts } from '../../lib/mcp-draft.js';
import { setCurrentTenant } from '../../lib/api.js';
import {
  render,
  makeSession,
  makeServeStatus,
  makeConfig,
  makeProfile,
  installFetchMock,
  flushEffects,
} from './testUtils.js';
import type { Configuration } from '../../types/schema.js';
import type { View } from '../../router/index.js';

vi.mock('../../context/SessionContext.js', () => ({
  useSession: vi.fn(),
}));

vi.mock('@calame-ee/rag-core/web', () => ({
  KnowledgeBaseManager: () => <div>KB Manager (mock)</div>,
  RagAccessSelector: () => <div>Rag selector (mock)</div>,
}));

const CONFIGS: Configuration[] = [
  { name: 'docs', label: 'Docs' },
  { name: 'sales', label: 'Sales' },
];

let navigate: (view: View) => void = () => {};

/** Mounts one page at a time, like App.tsx does when `view.page` changes. */
function Shell({
  initial,
  account,
  handleProfileCreate,
}: {
  initial: View;
  account: string;
  handleProfileCreate: (name: string, label: string, configurations?: string[]) => void;
}) {
  const [view, setView] = useState<View>(initial);
  navigate = setView;
  if (view.page === 'mcp-list') {
    return (
      <McpListPage
        prefillConfiguration={view.prefillConfiguration}
        draftAccount={account}
        configurations={CONFIGS}
        setView={setView}
        configWithProfileOptions={makeConfig()}
        selectedTables={{}}
        profiles={[makeProfile()]}
        serveStatus={makeServeStatus()}
        fetchServeStatus={vi.fn(async () => {})}
        handleProfileCreate={handleProfileCreate}
        handleProfileDelete={vi.fn(async () => {})}
        setPreviewProfile={vi.fn()}
      />
    );
  }
  if (view.page === 'sources') {
    return (
      <SourcesPage
        view={view}
        setView={setView}
        connections={[]}
        setConnections={vi.fn()}
        handleSchemaLoaded={vi.fn()}
      />
    );
  }
  if (view.page === 'configurations') {
    return (
      <ConfigurationsPage
        setView={setView}
        configurations={CONFIGS}
        setConfigurations={vi.fn()}
        handleConfigurationSave={vi.fn(async () => true)}
        handleConfigurationDelete={vi.fn(async () => {})}
        connections={[]}
        profiles={[makeProfile()]}
        serveStatus={makeServeStatus()}
      />
    );
  }
  return <div>other page</div>;
}

function renderShell(initial: View, account = 'admin@example.com') {
  const handleProfileCreate = vi.fn();
  const { unmount } = render(
    <Shell initial={initial} account={account} handleProfileCreate={handleProfileCreate} />,
  );
  return Object.assign(handleProfileCreate, { unmount });
}

async function go(view: View) {
  act(() => navigate(view));
  await flushEffects();
}

function nameInput(): HTMLInputElement | null {
  return screen.queryByPlaceholderText('MCP name...') as HTMLInputElement | null;
}

function profileSaves(): unknown[] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([input]) => String(input).includes('/api/profiles/save'));
}

beforeEach(() => {
  clearMcpDrafts();
  setCurrentTenant('default');
  installFetchMock();
  vi.mocked(useSession).mockReturnValue(makeSession());
});

afterEach(() => {
  vi.unstubAllGlobals();
  setCurrentTenant('default');
});

describe('MCP creation draft across navigation', () => {
  it('keeps every field and selection through Sources and Data config, creating nothing early', async () => {
    const handleProfileCreate = renderShell({ page: 'mcp-list', prefillConfiguration: 'docs' });
    await flushEffects();
    fireEvent.change(nameInput()!, { target: { value: 'Docs server' } });

    await go({ page: 'sources' });
    expect(nameInput()).toBeNull();
    await go({ page: 'configurations' });
    // Back through the sidebar: no prefill in the view any more.
    await go({ page: 'mcp-list' });

    expect(nameInput()!.value).toBe('Docs server');
    expect(screen.getByText('docs-server')).toBeTruthy();
    expect(screen.getByText('Included data configuration: Docs')).toBeTruthy();
    expect(handleProfileCreate).not.toHaveBeenCalled();
    expect(profileSaves()).toHaveLength(0);

    fireEvent.click(screen.getByText('Create'));
    expect(handleProfileCreate).toHaveBeenCalledWith('docs-server', 'Docs server', ['docs']);
  });

  it('clears the draft after a successful creation', async () => {
    renderShell({ page: 'mcp-list' });
    await flushEffects();
    fireEvent.click(screen.getByText('New MCP Server'));
    fireEvent.change(nameInput()!, { target: { value: 'Ops' } });
    fireEvent.click(screen.getByText('Create'));

    await go({ page: 'sources' });
    await go({ page: 'mcp-list' });
    expect(nameInput()).toBeNull();
  });

  it('clears the draft on an explicit cancel', async () => {
    renderShell({ page: 'mcp-list' });
    await flushEffects();
    fireEvent.click(screen.getByText('New MCP Server'));
    fireEvent.change(nameInput()!, { target: { value: 'Ops' } });
    fireEvent.click(screen.getByText('Cancel'));

    await go({ page: 'sources' });
    await go({ page: 'mcp-list' });
    expect(nameInput()).toBeNull();
  });

  it('does not carry a draft into the flow of another data configuration', async () => {
    renderShell({ page: 'mcp-list', prefillConfiguration: 'docs' });
    await flushEffects();
    fireEvent.change(nameInput()!, { target: { value: 'Docs server' } });

    await go({ page: 'sources' });
    await go({ page: 'mcp-list', prefillConfiguration: 'sales' });

    expect(nameInput()!.value).toBe('');
    expect(screen.getByText('Included data configuration: Sales')).toBeTruthy();
    expect(screen.queryByText('Included data configuration: Docs')).toBeNull();
  });

  it('keeps drafts apart between accounts and workspaces', async () => {
    renderShell({ page: 'mcp-list' });
    await flushEffects();
    fireEvent.click(screen.getByText('New MCP Server'));
    fireEvent.change(nameInput()!, { target: { value: 'Mine' } });
    await go({ page: 'sources' });

    // Another workspace, same account.
    setCurrentTenant('acme');
    await go({ page: 'mcp-list' });
    expect(nameInput()).toBeNull();
    await go({ page: 'sources' });
    setCurrentTenant('default');
    await go({ page: 'mcp-list' });
    expect(nameInput()!.value).toBe('Mine');
  });

  it('does not show a draft to another account', async () => {
    const alice = renderShell({ page: 'mcp-list' }, 'alice@example.com');
    await flushEffects();
    fireEvent.click(screen.getByText('New MCP Server'));
    fireEvent.change(nameInput()!, { target: { value: 'Alice MCP' } });
    alice.unmount();

    const bob = renderShell({ page: 'mcp-list' }, 'bob@example.com');
    await flushEffects();
    expect(nameInput()).toBeNull();
    bob.unmount();

    renderShell({ page: 'mcp-list' }, 'alice@example.com');
    await flushEffects();
    expect(nameInput()!.value).toBe('Alice MCP');
  });
});
