// McpDetailPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import McpDetailPage from '../McpDetailPage.js';
import ServePanel from '../../components/ServePanel.js';
import { resetMcpProbes } from '../../components/McpProbe.js';
import { SETUP_REFRESH_EVENT } from '../../components/SetupChecklist.js';
import { useNavigation } from '../../router/useNavigation.js';
import type { View } from '../../router/view.js';
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

function renderPage({
  profileName = 'default',
  setView = vi.fn(),
  serveStatus = makeServeStatus(),
} = {}) {
  return render(
    <McpDetailPage
      view={{ page: 'mcp-detail', profileName }}
      setView={setView}
      profiles={[makeProfile()]}
      setProfiles={vi.fn()}
      serveStatus={serveStatus}
      configWithProfileOptions={makeConfig()}
      configurations={[]}
      setConfigurations={vi.fn()}
      activeProfileIndex={0}
      setActiveProfileIndex={vi.fn()}
      handleProfileDelete={vi.fn(async () => {})}
      handleConfigurationSave={vi.fn(async () => true)}
    />,
  );
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

  it('shows the editable "AI instructions" field and updates the profile after saving', async () => {
    const fetchMock = installFetchMock();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/ai-instructions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, profile: { aiInstructions: 'New rule' } }),
        } as unknown as Response;
      }
      return base(input);
    });
    const setProfiles = vi.fn();
    render(
      <McpDetailPage
        view={{ page: 'mcp-detail', profileName: 'default' }}
        setView={vi.fn()}
        profiles={[makeProfile({ aiInstructions: 'Read 00-LISEZ-MOI.md' })]}
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

    const field = screen.getByLabelText('AI instructions') as HTMLTextAreaElement;
    expect(field.value).toBe('Read 00-LISEZ-MOI.md');
    fireEvent.change(field, { target: { value: 'New rule' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    });

    const updater = setProfiles.mock.calls.at(-1)?.[0] as (p: unknown[]) => unknown[];
    expect(updater([makeProfile({ aiInstructions: 'Read 00-LISEZ-MOI.md' })])).toEqual([
      makeProfile({ aiInstructions: 'New rule' }),
    ]);
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

  it('selects the Connect tab on a hash navigation to /connect while the same MCP is open', async () => {
    let navigate: (view: View) => void = () => {};
    function RoutedPage() {
      const { view, setView } = useNavigation();
      navigate = setView;
      if (view.page !== 'mcp-detail') return null;
      return (
        <McpDetailPage
          view={view}
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
        />
      );
    }
    window.location.hash = '#/mcp/default';
    try {
      render(<RoutedPage />);
      await flushEffects();
      expect(screen.queryByText('AI Settings')).toBeNull();

      // e.g. the getting-started card's "Connect a client" link.
      act(() => {
        window.location.hash = '#/mcp/default/connect';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await flushEffects();
      expect(screen.getByText('AI Settings')).toBeTruthy();

      // Back on another tab, the same link (unchanged URL) still selects Connect.
      fireEvent.click(screen.getByText('Exposed Data'));
      await flushEffects();
      expect(screen.queryByText('AI Settings')).toBeNull();
      act(() => navigate({ page: 'mcp-detail', profileName: 'default', activeSection: 'connect' }));
      await flushEffects();
      expect(screen.getByText('AI Settings')).toBeTruthy();
    } finally {
      window.location.hash = '';
    }
  });

  it('starting an MCP without a data configuration shows a translated message and a link to attach one', async () => {
    const base = installFetchMock();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/serve/start')) {
          return new Response(
            JSON.stringify({
              success: false,
              code: 'no_profiles',
              message: 'No profiles found. Create profiles first.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return base(input);
      }),
    );
    renderPage();
    await flushEffects();
    fireEvent.click(screen.getByText('Connect'));
    await flushEffects();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    });
    await flushEffects();
    expect(screen.queryByText(/No profiles found/)).toBeNull();
    expect(screen.getByText(/has no data configuration yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Attach a data configuration' }));
    await flushEffects();
    expect(screen.queryByText(/has no data configuration yet/)).toBeNull();
    expect(screen.queryByText('AI Settings')).toBeNull(); // back on "Exposed Data"
  });

  it('shows a not-found message for an unknown profile', async () => {
    renderPage({ profileName: 'ghost' });
    expect(screen.getByText('MCP Server "ghost" not found.')).toBeTruthy();
    await flushEffects();
  });

  it('navigates back to the MCP list via the breadcrumb', async () => {
    const setView = vi.fn();
    renderPage({ setView });
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

  describe('Test MCP button', () => {
    const activeStatus = makeServeStatus({
      active: true,
      profiles: ['default'],
      profileStatuses: { default: { active: true, endpoint: '/mcp/default' } },
    });

    /** Answers the probe with `body`; every other endpoint keeps the default stub. */
    function installProbe(body: unknown, status = 200) {
      const base = installFetchMock();
      const fallback = base.getMockImplementation()!;
      const mock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
        if (String(input) === '/api/serve/mcp-probe') {
          return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return fallback(input);
      });
      vi.stubGlobal('fetch', mock);
      return mock;
    }

    function renderCard(serveStatus = activeStatus) {
      return render(
        <ServePanel
          config={makeConfig()}
          selectedTables={{}}
          profiles={[makeProfile()]}
          serveStatus={serveStatus}
          onSelectProfile={vi.fn()}
        />,
      );
    }

    const success = {
      success: true,
      profileName: 'default',
      tools: [
        { name: 'query', description: '' },
        { name: 'list_tables', description: '' },
      ],
    };

    afterEach(() => {
      resetMcpProbes();
    });

    it('sits next to Start/Stop and lists the discovered tools without any AI call', async () => {
      const fetchMock = installProbe(success);
      const refreshed = vi.fn();
      window.addEventListener(SETUP_REFRESH_EVENT, refreshed);
      try {
        renderPage({ serveStatus: activeStatus });
        await flushEffects();
        const button = screen.getByRole('button', { name: 'Test MCP' });
        expect(button.parentElement).toBe(screen.getByText('Stop').parentElement);

        fireEvent.click(button);
        const result = await screen.findByTestId('mcp-probe-result');
        expect(result.textContent).toContain('2 tools discovered');
        expect(result.textContent).toContain('query, list_tables');
        expect(result.textContent).toContain('does not run the tools or validate the data sources');

        const probeCall = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/serve/mcp-probe');
        expect(JSON.parse(String((probeCall?.[1] as RequestInit).body))).toEqual({
          profileName: 'default',
        });
        const posts = fetchMock.mock.calls
          .filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
          .map((c) => String(c[0]));
        expect(posts).toEqual(['/api/serve/mcp-probe']);
        // The setup guide re-reads the kept outcome (step 4).
        expect(refreshed).toHaveBeenCalled();
      } finally {
        window.removeEventListener(SETUP_REFRESH_EVENT, refreshed);
      }
    });

    it('shows a classified error with its reason, action and technical detail', async () => {
      installProbe(
        {
          success: false,
          error: {
            category: 'auth',
            stage: 'initialize',
            message: 'The MCP endpoint refused the credentials (HTTP 401).',
            action: 'Check the profile authentication mode.',
            httpStatus: 401,
          },
        },
        502,
      );
      renderPage({ serveStatus: activeStatus });
      await flushEffects();
      fireEvent.click(screen.getByRole('button', { name: 'Test MCP' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('MCP test failed: authentication refused');
      expect(alert.textContent).toContain('refused the credentials (HTTP 401)');
      expect(alert.textContent).toContain('What to do: Check the profile authentication mode.');
      expect(alert.textContent).toContain('stage=initialize');
    });

    it('is available on a stopped server and reports it with what to do', async () => {
      installProbe(
        {
          success: false,
          error: {
            category: 'unreachable',
            stage: 'preflight',
            code: 'server_stopped',
            message: 'The MCP server "default" is stopped.',
            action: 'Click Start on the MCP server, then run the test again.',
          },
        },
        409,
      );
      renderPage();
      await flushEffects();
      fireEvent.click(screen.getByRole('button', { name: 'Test MCP' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('The MCP server is stopped.');
      expect(alert.textContent).toContain('What to do: Click Start, then run the test again.');
    });

    it('shares its result with the MCP list card, both ways', async () => {
      installProbe(success);
      const page = renderPage({ serveStatus: activeStatus });
      await flushEffects();
      fireEvent.click(screen.getByRole('button', { name: 'Test MCP' }));
      await screen.findByTestId('mcp-probe-result');
      page.unmount();

      // The card shows the test run from the page…
      const card = renderCard();
      expect(screen.getByTestId('mcp-probe-result').textContent).toContain('2 tools discovered');

      // …and a test run from the card replaces it on the page.
      installProbe({ success: false, error: { category: 'timeout', message: 'No answer.' } }, 504);
      fireEvent.click(screen.getByText('Test MCP'));
      await screen.findByRole('alert');
      card.unmount();

      renderPage({ serveStatus: activeStatus });
      await flushEffects();
      expect(screen.getByRole('alert').textContent).toContain('MCP test failed: timeout');
      expect(screen.queryByText('2 tools discovered', { exact: false })).toBeNull();
    });

    it('drops a result once the server is started or stopped', async () => {
      installProbe(success);
      const page = renderPage({ serveStatus: activeStatus });
      await flushEffects();
      fireEvent.click(screen.getByRole('button', { name: 'Test MCP' }));
      await screen.findByTestId('mcp-probe-result');
      page.unmount();

      // Stopped meanwhile: neither the card nor the page show the stale result.
      renderCard(makeServeStatus()).unmount();
      renderPage();
      await flushEffects();
      expect(screen.queryByTestId('mcp-probe-result')).toBeNull();
    });
  });
});
