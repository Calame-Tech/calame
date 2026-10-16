// ServePanel component tests (Lot E — quick wins + dead-code cleanup).
//
// Covers the dashboard/list view only — the dead "detail view" branch
// (reachable only when `onSelectProfile` was not provided) was removed since
// the component's sole call site (McpListPage) always supplies it.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { RenderOptions } from '@testing-library/react';
import ServePanel from '../ServePanel.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import type { Config, Profile, ServeStatus } from '../../types/schema.js';

/** Renders with the i18n context the component now requires. */
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nProvider, ...options });
}

const config: Config = {
  serverName: 'calame',
  transport: 'streamable-http',
  clientTarget: 'claude-desktop',
  outputDir: '',
};

const serveStatus: ServeStatus = {
  active: false,
  port: 4567,
  profiles: [],
  profileStatuses: {},
  totalRequests: 0,
};

const profiles: Profile[] = [{ name: 'default', label: 'Default' }];

function renderPanel(overrides: Partial<React.ComponentProps<typeof ServePanel>> = {}) {
  const onSelectProfile = vi.fn();
  const onCreateProfile = vi.fn();
  render(
    <ServePanel
      config={config}
      selectedTables={{}}
      profiles={profiles}
      serveStatus={serveStatus}
      onSelectProfile={onSelectProfile}
      onCreateProfile={onCreateProfile}
      {...overrides}
    />,
  );
  return { onSelectProfile, onCreateProfile };
}

describe('ServePanel', () => {
  it('renders the profile list and navigates via onSelectProfile on card click', () => {
    const { onSelectProfile } = renderPanel();
    expect(screen.getByText('Default')).toBeTruthy();
    fireEvent.click(screen.getByText('Default'));
    expect(onSelectProfile).toHaveBeenCalledWith('default');
  });

  it('creates a new profile with a unique name', () => {
    const { onCreateProfile } = renderPanel();
    fireEvent.click(screen.getByText('New MCP Server'));
    fireEvent.change(screen.getByPlaceholderText('MCP name...'), {
      target: { value: 'My New Server' },
    });
    fireEvent.click(screen.getByText('Create'));
    expect(onCreateProfile).toHaveBeenCalledWith('my-new-server', 'My New Server');
  });

  it('explains the safe defaults a new MCP starts with, before it is created', () => {
    renderPanel();
    fireEvent.click(screen.getByText('New MCP Server'));
    const defaults = screen.getByTestId('new-mcp-defaults');
    expect(defaults.textContent).toContain('Access by API key');
    expect(defaults.textContent).toContain('Natural answers');
    expect(defaults.textContent).toContain('Read-only');
    expect(defaults.textContent).toContain('Advanced options');
  });

  it('blocks creation and shows an inline error when the slugified name already exists', () => {
    const { onCreateProfile } = renderPanel({
      profiles: [{ name: 'default', label: 'Default' }],
    });
    fireEvent.click(screen.getByText('New MCP Server'));
    fireEvent.change(screen.getByPlaceholderText('MCP name...'), {
      target: { value: 'Default' },
    });
    fireEvent.click(screen.getByText('Create'));
    expect(onCreateProfile).not.toHaveBeenCalled();
    expect(screen.getByText('A profile named "default" already exists.')).toBeTruthy();
  });

  describe('Test MCP button', () => {
    const activeStatus: ServeStatus = {
      ...serveStatus,
      active: true,
      profiles: ['default'],
      profileStatuses: { default: { active: true, endpoint: '/mcp/default' } },
    } as ServeStatus;

    function installProbe(response: () => Promise<Response>) {
      const mock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
        if (String(input).includes('/api/serve/mcp-probe')) return response();
        return new Response('{}', { status: 200 });
      });
      vi.stubGlobal('fetch', mock);
      return mock;
    }

    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('is only offered for active profiles', () => {
      installProbe(() => json({}));
      renderPanel();
      expect(screen.queryByText('Test MCP')).toBeNull();
    });

    it('lists discovered tools without calling any AI endpoint, and states the scope', async () => {
      const fetchMock = installProbe(() =>
        json({
          success: true,
          profileName: 'default',
          tools: [
            { name: 'query', description: '' },
            { name: 'list_tables', description: '' },
          ],
        }),
      );
      const { onSelectProfile } = renderPanel({ serveStatus: activeStatus });
      fireEvent.click(screen.getByText('Test MCP'));
      const result = await screen.findByTestId('mcp-probe-result');
      expect(result.textContent).toContain('2 tools discovered');
      expect(result.textContent).toContain('query, list_tables');
      expect(result.textContent).toContain('does not run the tools or validate the data sources');
      expect(onSelectProfile).not.toHaveBeenCalled();

      const probeCall = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/serve/mcp-probe');
      expect(JSON.parse(String((probeCall?.[1] as RequestInit).body))).toEqual({
        profileName: 'default',
      });
      // The probe is the only POST: no chat / LLM request is issued.
      const posts = fetchMock.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.map((c) => String(c[0]))).toEqual(['/api/serve/mcp-probe']);
    });

    it('shows the failure category, the reason, the action and the technical detail', async () => {
      installProbe(() =>
        json(
          {
            success: false,
            error: {
              category: 'auth',
              stage: 'initialize',
              message: 'The MCP endpoint refused the credentials (HTTP 401).',
              action: 'Check the profile authentication mode.',
              detail: 'Bearer ***',
              httpStatus: 401,
            },
          },
          502,
        ),
      );
      renderPanel({ serveStatus: activeStatus });
      fireEvent.click(screen.getByText('Test MCP'));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('MCP test failed: authentication refused');
      expect(alert.textContent).toContain('refused the credentials (HTTP 401)');
      expect(alert.textContent).toContain('What to do: Check the profile authentication mode.');
      expect(alert.textContent).toContain('stage=initialize');
      expect(alert.textContent).toContain('http=401');
    });

    it('explains a missing configuration reported by the preflight', async () => {
      installProbe(() =>
        json(
          {
            success: false,
            error: {
              category: 'config',
              stage: 'preflight',
              message: 'The MCP server is not running.',
              action: 'Start the MCP server from the Serve page, then retry.',
            },
          },
          409,
        ),
      );
      renderPanel({ serveStatus: activeStatus });
      fireEvent.click(screen.getByText('Test MCP'));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('configuration incomplete');
      expect(alert.textContent).toContain('Start the MCP server from the Serve page');
    });

    it('reports an unreachable Calame server when the request itself fails', async () => {
      installProbe(() => Promise.reject(new TypeError('Failed to fetch')));
      renderPanel({ serveStatus: activeStatus });
      fireEvent.click(screen.getByText('Test MCP'));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('server unreachable');
      expect(alert.textContent).toContain('Check that Calame is still running');
      expect(alert.textContent).toContain('Failed to fetch');
    });

    it('does not hide an unexpected backend response behind a generic message', async () => {
      installProbe(() =>
        Promise.resolve(new Response('<html>Bad gateway</html>', { status: 500 })),
      );
      renderPanel({ serveStatus: activeStatus });
      fireEvent.click(screen.getByText('Test MCP'));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('server error');
      expect(alert.textContent).toContain('unexpected response (HTTP 500)');
      await waitFor(() => expect(screen.getByText('Test MCP')).toBeTruthy());
    });
  });
});
