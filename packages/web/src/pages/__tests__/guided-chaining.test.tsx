// Guided source → data configuration → MCP server chaining (CALAME-6).
// Every suggestion opens a form or a proposal with the previous resource
// preselected; nothing is created or attached without an explicit click.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import ConfigurationsPage from '../ConfigurationsPage.js';
import ConfigurationDetailPage from '../ConfigurationDetailPage.js';
import McpListPage from '../McpListPage.js';
import McpDetailPage from '../McpDetailPage.js';
import { useSession } from '../../context/SessionContext.js';
import {
  render,
  makeSession,
  makeServeStatus,
  makeConfig,
  makeProfile,
  installFetchMock,
  flushEffects,
} from './testUtils.js';
import type { Configuration, Profile } from '../../types/schema.js';

vi.mock('../../context/SessionContext.js', () => ({
  useSession: vi.fn(),
}));

vi.mock('@calame-ee/rag-core/web', () => ({
  KnowledgeBaseManager: () => <div>KB Manager (mock)</div>,
  RagAccessSelector: () => <div>Rag selector (mock)</div>,
}));

vi.mock('@calame-ee/sso/web', () => ({
  ProfileSsoNotice: () => <></>,
  DataScopingSection: () => <div>Scoping (mock)</div>,
  OidcSettings: () => <div>OIDC settings (mock)</div>,
}));

const KB_CONFIG: Configuration = {
  name: 'docs',
  label: 'Docs',
  sources: ['src_1'],
  scopes: {
    src_1: { kind: 'document', mode: 'allowAll', allowedFolders: [], allowedDocuments: [] },
  },
};

function profileSaves(): unknown[] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([input]) => String(input).includes('/api/profiles/save'));
}

beforeEach(() => {
  installFetchMock();
  vi.mocked(useSession).mockReturnValue(makeSession({ ragEnabled: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('source → data configuration', () => {
  function renderConfigurations(prefillSource?: { id: string; name: string }) {
    const setConfigurations = vi.fn();
    const handleConfigurationSave = vi.fn(async () => true);
    const setView = vi.fn();
    render(
      <ConfigurationsPage
        prefillSource={prefillSource}
        setView={setView}
        configurations={[]}
        setConfigurations={setConfigurations}
        handleConfigurationSave={handleConfigurationSave}
        handleConfigurationDelete={vi.fn(async () => {})}
        connections={[]}
        profiles={[]}
        serveStatus={makeServeStatus()}
      />,
    );
    return { handleConfigurationSave, setView };
  }

  it('opens the creation form with the source preselected, without creating anything', () => {
    const { handleConfigurationSave } = renderConfigurations({ id: 'src_1', name: 'Docs' });

    expect((screen.getByPlaceholderText('Configuration name') as HTMLInputElement).value).toBe(
      'Docs',
    );
    expect(screen.getByText(/Included source: Docs/)).toBeTruthy();
    expect(handleConfigurationSave).not.toHaveBeenCalled();
  });

  it('creates the configuration with the source fully included on "Create"', () => {
    const { handleConfigurationSave, setView } = renderConfigurations({
      id: 'src_1',
      name: 'Docs',
    });

    fireEvent.click(screen.getByText('Create'));

    expect(handleConfigurationSave).toHaveBeenCalledTimes(1);
    expect(handleConfigurationSave).toHaveBeenCalledWith(KB_CONFIG);
    expect(setView).toHaveBeenCalledWith({ page: 'config-detail', configName: 'docs' });
  });

  it('drops the preselection when the form is cancelled', () => {
    const { handleConfigurationSave } = renderConfigurations({ id: 'src_1', name: 'Docs' });

    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('+ New Data Configuration'));
    fireEvent.change(screen.getByPlaceholderText('Configuration name'), {
      target: { value: 'other' },
    });
    fireEvent.change(screen.getByPlaceholderText('Display name'), { target: { value: 'Other' } });
    fireEvent.click(screen.getByText('Create'));

    expect(handleConfigurationSave).toHaveBeenCalledWith({ name: 'other', label: 'Other' });
  });
});

describe('data configuration → MCP server', () => {
  function renderDetail(profiles: Profile[]) {
    const setView = vi.fn();
    render(
      <ConfigurationDetailPage
        view={{ page: 'config-detail', configName: 'docs' }}
        setView={setView}
        configurations={[KB_CONFIG]}
        profiles={profiles}
        connections={[]}
        connectionSchemas={{}}
        piiDetections={null}
        scanning={false}
        globalMaskingRules={[]}
        handleScanPii={vi.fn()}
        handleConfigurationSave={vi.fn(async () => true)}
        handleConfigurationDelete={vi.fn(async () => {})}
        handleSchemaLoaded={vi.fn()}
        handlePiiOverride={vi.fn()}
        handleGlobalMaskingRulesChange={vi.fn()}
      />,
    );
    return setView;
  }

  it('offers to create a server with the configuration preselected', async () => {
    const setView = renderDetail([]);
    await flushEffects();

    fireEvent.click(screen.getByText('Create an MCP server with this configuration'));

    expect(setView).toHaveBeenCalledWith({ page: 'mcp-list', prefillConfiguration: 'docs' });
  });

  it('offers to open an existing server to attach the configuration', async () => {
    const setView = renderDetail([makeProfile(), makeProfile({ name: 'sales', label: 'Sales' })]);
    await flushEffects();

    fireEvent.change(screen.getByLabelText('Existing MCP server'), { target: { value: 'sales' } });
    fireEvent.click(screen.getByText('Attach to this server…'));

    expect(setView).toHaveBeenCalledWith({
      page: 'mcp-detail',
      profileName: 'sales',
      activeSection: 'tables',
      suggestConfiguration: 'docs',
    });
    expect(profileSaves()).toHaveLength(0);
  });

  it('hides the suggestion once a server mounts the configuration', async () => {
    renderDetail([makeProfile({ configurations: ['docs'] })]);
    await flushEffects();

    expect(screen.queryByTestId('config-next-step')).toBeNull();
  });

  it('creates the server with the preselected configuration only on "Create"', async () => {
    const handleProfileCreate = vi.fn();
    const setView = vi.fn();
    render(
      <McpListPage
        prefillConfiguration="docs"
        configurations={[KB_CONFIG]}
        setView={setView}
        configWithProfileOptions={makeConfig()}
        selectedTables={{}}
        profiles={[makeProfile()]}
        serveStatus={makeServeStatus()}
        fetchServeStatus={vi.fn(async () => {})}
        handleProfileCreate={handleProfileCreate}
        handleProfileDelete={vi.fn(async () => {})}
        setPreviewProfile={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.getByText('Included data configuration: Docs')).toBeTruthy();
    expect(handleProfileCreate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('MCP name...'), {
      target: { value: 'Docs server' },
    });
    fireEvent.click(screen.getByText('Create'));

    expect(handleProfileCreate).toHaveBeenCalledWith('docs-server', 'Docs server', ['docs']);
    expect(setView).toHaveBeenCalledWith({ page: 'mcp-detail', profileName: 'docs-server' });
  });

  it('proposes attaching on the server page and persists only on an explicit click', async () => {
    let current: Profile[] = [makeProfile()];
    const setProfiles = vi.fn((update: Profile[] | ((prev: Profile[]) => Profile[])) => {
      current = typeof update === 'function' ? update(current) : update;
    });
    render(
      <McpDetailPage
        view={{ page: 'mcp-detail', profileName: 'default', suggestConfiguration: 'docs' }}
        setView={vi.fn()}
        profiles={current}
        setProfiles={setProfiles}
        serveStatus={makeServeStatus()}
        configWithProfileOptions={makeConfig()}
        configurations={[KB_CONFIG]}
        setConfigurations={vi.fn()}
        activeProfileIndex={0}
        setActiveProfileIndex={vi.fn()}
        handleProfileDelete={vi.fn(async () => {})}
        handleConfigurationSave={vi.fn(async () => true)}
      />,
    );
    await flushEffects();

    const banner = screen.getByTestId('suggest-attach-configuration');
    expect(banner.textContent).toContain('Attach the data configuration “Docs” to this server?');
    expect(setProfiles).not.toHaveBeenCalled();
    expect(profileSaves()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await flushEffects();

    expect(current[0].configurations).toEqual(['docs']);
    expect(profileSaves()).toHaveLength(1);
  });

  it('lets the attach proposal be dismissed without any change', async () => {
    const setProfiles = vi.fn();
    render(
      <McpDetailPage
        view={{ page: 'mcp-detail', profileName: 'default', suggestConfiguration: 'docs' }}
        setView={vi.fn()}
        profiles={[makeProfile()]}
        setProfiles={setProfiles}
        serveStatus={makeServeStatus()}
        configWithProfileOptions={makeConfig()}
        configurations={[KB_CONFIG]}
        setConfigurations={vi.fn()}
        activeProfileIndex={0}
        setActiveProfileIndex={vi.fn()}
        handleProfileDelete={vi.fn(async () => {})}
        handleConfigurationSave={vi.fn(async () => true)}
      />,
    );
    await flushEffects();

    const banner = screen.getByTestId('suggest-attach-configuration');
    fireEvent.click(banner.querySelectorAll('button')[1]);

    expect(screen.queryByTestId('suggest-attach-configuration')).toBeNull();
    expect(setProfiles).not.toHaveBeenCalled();
  });
});
