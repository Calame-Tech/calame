// McpDetailPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import McpDetailPage from '../McpDetailPage.js';
import {
  render,
  makeServeStatus,
  makeConfig,
  makeProfile,
  installFetchMock,
  flushEffects,
} from './testUtils.js';

// The page lazily imports ProfileSsoNotice / DataScopingSection from the EE
// SSO package — mock the module so the license boundary is never crossed.
vi.mock('@calame-ee/sso/web', () => ({
  ProfileSsoNotice: () => <></>,
  DataScopingSection: () => <div>Scoping (mock)</div>,
  OidcSettings: () => <div>OIDC settings (mock)</div>,
}));

function renderPage({ profileName = 'default', setView = vi.fn() } = {}) {
  render(
    <McpDetailPage
      view={{ page: 'mcp-detail', profileName }}
      setView={setView}
      profiles={[makeProfile()]}
      setProfiles={vi.fn()}
      serveStatus={makeServeStatus()}
      configWithProfileOptions={makeConfig()}
      configurations={[]}
      setConfigurations={vi.fn()}
      activeProfileIndex={0}
      setActiveProfileIndex={vi.fn()}
      handleProfileDelete={vi.fn(async () => {})}
      handleConfigurationSave={vi.fn(async () => true)}
    />,
  );
  return setView;
}

describe('McpDetailPage', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the profile detail with its section tabs', async () => {
    renderPage();
    // Label appears in the breadcrumb and the heading
    expect(screen.getAllByText('Default').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Exposed Data')).toBeTruthy();
    expect(screen.getByText('Connect')).toBeTruthy();
    expect(screen.getByText('API Keys')).toBeTruthy();
    expect(screen.getByText('Audit Log')).toBeTruthy();
    await flushEffects();
  });

  it('moves the AI client/settings UI to its own "Connect" tab, out of "Exposed Data"', async () => {
    renderPage();
    await flushEffects();

    // Exposed Data is the default tab — it must not show AI-connect content.
    expect(screen.queryByText('AI Settings')).toBeNull();

    fireEvent.click(screen.getByText('Connect'));
    await flushEffects();
    expect(screen.getByText('AI Settings')).toBeTruthy();

    // Switching back to Exposed Data hides it again — confirms it really
    // moved rather than just always rendering everywhere.
    fireEvent.click(screen.getByText('Exposed Data'));
    await flushEffects();
    expect(screen.queryByText('AI Settings')).toBeNull();
  });

  it('shows a not-found message for an unknown profile', async () => {
    renderPage({ profileName: 'ghost' });
    expect(screen.getByText('MCP Server "ghost" not found.')).toBeTruthy();
    await flushEffects();
  });

  it('navigates back to the MCP list via the breadcrumb', async () => {
    const setView = renderPage();
    fireEvent.click(screen.getByText('MCP Servers'));
    expect(setView).toHaveBeenCalledWith({ page: 'mcp-list' });
    await flushEffects();
  });

  it('file-write capability: off by default, opt-in PATCH, per-source checkbox', async () => {
    installFetchMock();
    const fallback = globalThis.fetch;
    const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/rag/sources')) {
        return new Response(
          JSON.stringify({
            sources: [
              { id: 'src-local', name: 'Nationex', type: 'local' },
              { id: 'src-s3', name: 'Bucket', type: 's3' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return fallback(input, init);
    });
    vi.stubGlobal('fetch', mock);
    const setProfiles = vi.fn();
    render(
      <McpDetailPage
        view={{ page: 'mcp-detail', profileName: 'default' }}
        setView={vi.fn()}
        profiles={[makeProfile()]}
        setProfiles={setProfiles}
        serveStatus={makeServeStatus()}
        configWithProfileOptions={makeConfig()}
        configurations={[]}
        setConfigurations={vi.fn()}
        activeProfileIndex={0}
        setActiveProfileIndex={vi.fn()}
        handleProfileDelete={vi.fn(async () => {})}
        handleConfigurationSave={vi.fn(async () => true)}
      />,
    );
    await flushEffects();
    fireEvent.click(screen.getByText('Connect'));
    await flushEffects();

    const toggle = screen.getByRole('switch', { name: 'Toggle file creation and editing' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // Source checkboxes are hidden while the capability is off.
    expect(screen.queryByRole('checkbox', { name: 'Allow writing in Nationex' })).toBeNull();

    fireEvent.click(toggle);
    await flushEffects();
    const patch = mock.mock.calls.find(
      ([u, init]) =>
        String(u).includes('/api/profiles/default/document-write') &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patch).toBeTruthy();
    expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({
      enabled: true,
      sources: {},
    });
  });
});
