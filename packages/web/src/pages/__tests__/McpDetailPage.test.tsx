// McpDetailPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import McpDetailPage from '../McpDetailPage.js';
import { createNewProfile } from '../../lib/profiles.js';
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

    // File writing is an advanced option, folded by default.
    expect(screen.queryByRole('switch', { name: 'Toggle file creation and editing' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }));

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

  describe('first-launch options (safe defaults)', () => {
    type Profile = ReturnType<typeof makeProfile>;
    function pageFor(profileName: string, profiles: Profile[]) {
      return (
        <McpDetailPage
          view={{ page: 'mcp-detail', profileName }}
          setView={vi.fn()}
          profiles={profiles}
          setProfiles={vi.fn()}
          serveStatus={makeServeStatus()}
          configWithProfileOptions={makeConfig()}
          configurations={[]}
          setConfigurations={vi.fn()}
          activeProfileIndex={0}
          setActiveProfileIndex={vi.fn()}
          handleProfileDelete={vi.fn(async () => {})}
          handleConfigurationSave={vi.fn(async () => true)}
        />
      );
    }
    function renderWithProfile(profile: Profile) {
      render(pageFor(profile.name, [profile]));
    }
    const advancedExpanded = () =>
      screen.getByRole('button', { name: 'Advanced options' }).getAttribute('aria-expanded');

    it('a new MCP shows API-key access and a short explanation per option, advanced folded', async () => {
      renderWithProfile(createNewProfile('first', 'First'));
      await flushEffects();

      expect(screen.getByTestId('current-auth-mode').textContent).toBe('Access: API Key');
      expect(screen.getByText(/Natural \(recommended\)/)).toBeTruthy();
      expect(screen.getByText(/Not needed to get started/)).toBeTruthy();

      const advanced = screen.getByRole('button', { name: 'Advanced options' });
      expect(advanced.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByText('Chat Authentication')).toBeNull();

      fireEvent.click(advanced);
      expect(advanced.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByText('Chat Authentication')).toBeTruthy();
      expect(screen.getByText(/API key \(recommended\)/)).toBeTruthy();
      expect(screen.getByText(/Off \(recommended\)/)).toBeTruthy();
      expect(screen.getByRole('button', { pressed: true, name: /API Key/ })).toBeTruthy();
    });

    it('keeps advanced options unfolded when an existing MCP already uses a non-default mode', async () => {
      renderWithProfile({ ...makeProfile(), authMode: 'calame' });
      await flushEffects();
      expect(
        screen.getByRole('button', { name: 'Advanced options' }).getAttribute('aria-expanded'),
      ).toBe('true');
      expect(screen.getByTestId('current-auth-mode').textContent).toBe('Access: Calame');
    });

    it('unfolds advanced options when a non-default profile loads after the first render', async () => {
      // Direct reload on /mcp/<name>: profiles are still empty on first render.
      const sso = { ...makeProfile(), name: 'team', authMode: 'sso' as const };
      const { rerender } = render(pageFor('team', []));
      await flushEffects();
      rerender(pageFor('team', [sso]));
      await flushEffects();
      expect(advancedExpanded()).toBe('true');
    });

    it('does not carry the folded/unfolded state over to another MCP', async () => {
      const first = createNewProfile('first', 'First');
      const second = createNewProfile('second', 'Second');
      const { rerender } = render(pageFor('first', [first, second]));
      await flushEffects();
      fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }));
      expect(advancedExpanded()).toBe('true');
      rerender(pageFor('second', [first, second]));
      await flushEffects();
      expect(advancedExpanded()).toBe('false');
    });

    it('always shows the open-access warning, even with advanced options folded', async () => {
      renderWithProfile({ ...makeProfile(), authMode: 'open' });
      await flushEffects();
      fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }));
      expect(
        screen.getByRole('button', { name: 'Advanced options' }).getAttribute('aria-expanded'),
      ).toBe('false');
      expect(screen.getByText(/accessible without any authentication/)).toBeTruthy();
    });
  });
});
