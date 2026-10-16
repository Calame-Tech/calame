// SetupChecklist — floating guided path (data → data profile → MCP → client).
// The state must come from the server resources (data profiles, saved MCPs,
// audit log), so it survives a reload, and the client step only completes on
// an audited call.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import SetupChecklist, {
  SETUP_CHECKLIST_COLLAPSED_KEY,
  SETUP_CHECKLIST_DISMISSED_KEY,
  SETUP_CHECKLIST_LEGACY_HIDDEN_KEY,
  SETUP_POLL_INTERVAL_MS,
  SETUP_POLL_MAX_ATTEMPTS,
} from '../SetupChecklist.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface ServerState {
  configurations?: Array<{ name: string; sources?: string[] }>;
  profiles?: Record<string, { configurations?: string[]; sources?: unknown[] }>;
  entries?: Array<{ profileName: string; result: 'success' | 'error' }>;
  ragSources?: Array<{ id: string; name: string }>;
  /** Newest first, like GET /api/rag/jobs. */
  ragJobs?: Array<{ sourceId: string; status: string; error: string | null }>;
  /** Last MCP probe per profile, as kept by the server. */
  probes?: Record<string, unknown>;
  fail?: boolean;
}

function installServer(server: ServerState) {
  const mock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (server.fail) return jsonResponse({ success: false }, false);
    if (url.includes('/api/configurations')) {
      // Same shape as the real route: an object indexed by data profile name.
      const configurations = Object.fromEntries(
        (server.configurations ?? []).map(({ name, ...c }) => [name, c]),
      );
      return jsonResponse({ success: true, configurations });
    }
    if (url.includes('/api/rag/sources')) {
      return jsonResponse({ sources: server.ragSources ?? [] });
    }
    if (url.includes('/api/rag/jobs')) {
      return jsonResponse({ jobs: server.ragJobs ?? [] });
    }
    if (url.includes('/api/serve/mcp-probe/last')) {
      return jsonResponse({ results: server.probes ?? {} });
    }
    if (url.includes('/api/profiles/load')) {
      const profiles = server.profiles ?? {};
      return jsonResponse({ found: Object.keys(profiles).length > 0, profiles });
    }
    if (url.includes('/api/audit')) {
      // Mirrors the server filters (profileName, result, limit).
      const params = new URL(url, 'http://localhost').searchParams;
      const profile = params.get('profileName');
      const result = params.get('result');
      const limit = Number(params.get('limit') ?? Infinity);
      const matching = (server.entries ?? [])
        .filter((e) => (!profile || e.profileName === profile) && (!result || e.result === result))
        .slice(0, limit);
      return jsonResponse({
        entries: matching.map((e, i) => ({
          id: String(i),
          timestamp: '2026-10-14T10:00:00.000Z',
          toolName: 'query',
          toolArgs: {},
          durationMs: 1,
          ...e,
        })),
        total: matching.length,
      });
    }
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function auditUrls(mock: ReturnType<typeof installServer>): string[] {
  return mock.mock.calls.map(([input]) => String(input)).filter((u) => u.includes('/api/audit'));
}

function stepStatus(title: RegExp): string | null {
  // The title also appears in the "current step" banner: read the list item.
  const item = screen
    .getAllByText(title)
    .map((el) => el.closest('li'))
    .find(Boolean);
  return item?.getAttribute('data-status') ?? null;
}

const salesData = { name: 'sales-config', sources: ['warehouse'] };
const salesMcp = { sales: { configurations: ['sales-config'] } };

describe('SetupChecklist', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.removeItem(SETUP_CHECKLIST_DISMISSED_KEY);
    localStorage.removeItem(SETUP_CHECKLIST_LEGACY_HIDDEN_KEY);
    localStorage.removeItem(SETUP_CHECKLIST_COLLAPSED_KEY);
  });

  it('renders nothing before the first answer, then the four steps with step 1 current', async () => {
    installServer({});
    const { container } = render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} />);
    expect(container.innerHTML).toBe('');
    await screen.findAllByText('1. Connect data');
    expect(stepStatus(/1\. Connect data/)).toBe('current');
    expect(stepStatus(/2\. Create a data profile/)).toBe('todo');
    expect(stepStatus(/3\. Create the MCP server/)).toBe('todo');
    expect(stepStatus(/4\. Connect and test the MCP/)).toBe('todo');
    expect(screen.getByTestId('setup-current-step').textContent).toContain(
      'Current step: 1. Connect data',
    );
    expect(screen.getByTestId('setup-current-step').textContent).toContain(
      'Then: 2. Create a data profile',
    );
  });

  it('points to the data profile (not the MCP) right after data is connected', async () => {
    installServer({});
    const onNavigate = vi.fn();
    render(<SetupChecklist sourceCount={1} onNavigate={onNavigate} />);
    await screen.findAllByText('1. Connect data');
    expect(stepStatus(/2\. Create a data profile/)).toBe('current');
    fireEvent.click(screen.getByRole('button', { name: 'Create a data profile' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'configurations' });
  });

  it('points to MCP creation once a data profile contains data', async () => {
    installServer({ configurations: [salesData] });
    const onNavigate = vi.fn();
    render(<SetupChecklist sourceCount={1} onNavigate={onNavigate} />);
    await screen.findAllByText('1. Connect data');
    expect(stepStatus(/2\. Create a data profile/)).toBe('done');
    expect(stepStatus(/3\. Create the MCP server/)).toBe('current');
    fireEvent.click(screen.getByRole('button', { name: 'Create the MCP server' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'mcp-list' });
  });

  it('gives client instructions once the MCP is attached, without marking it used', async () => {
    installServer({ configurations: [salesData], profiles: salesMcp });
    const onNavigate = vi.fn();
    render(<SetupChecklist sourceCount={1} onNavigate={onNavigate} />);
    await screen.findAllByText('1. Connect data');
    expect(stepStatus(/3\. Create the MCP server/)).toBe('done');
    expect(stepStatus(/4\. Connect and test the MCP/)).toBe('current');
    fireEvent.click(screen.getByRole('button', { name: 'Connect a client' }));
    expect(onNavigate).toHaveBeenCalledWith({
      page: 'mcp-detail',
      profileName: 'sales',
      activeSection: 'connect',
    });
  });

  describe('step 4 reflects the last MCP test kept by the server', () => {
    function step4Hint(): string {
      const item = screen
        .getAllByText(/4\. Connect and test the MCP/)
        .map((el) => el.closest('li'))
        .find(Boolean);
      return item?.querySelector('p + p')?.textContent ?? '';
    }

    it('not tested: keeps the client instructions', async () => {
      installServer({ configurations: [salesData], profiles: salesMcp });
      render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
      await screen.findAllByText('1. Connect data');
      expect(step4Hint()).toContain('follow the instructions for your AI client');
      expect(step4Hint()).not.toContain('Connection verified');
    });

    it('test passed: shows the verified connection, yet stays open until a client call', async () => {
      installServer({
        configurations: [salesData],
        profiles: salesMcp,
        probes: { sales: { success: true, at: '2026-10-16T10:00:00.000Z', toolCount: 3 } },
      });
      render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
      await screen.findAllByText('1. Connect data');
      expect(stepStatus(/4\. Connect and test the MCP/)).toBe('current');
      expect(step4Hint()).toContain('Connection verified ✓ (3 tools discovered)');
      expect(step4Hint()).toContain('ask a question about your data from your AI client');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(localStorage.getItem(SETUP_CHECKLIST_DISMISSED_KEY)).toBeNull();
    });

    it('test failed: shows the short reason as an alert', async () => {
      installServer({
        configurations: [salesData],
        profiles: salesMcp,
        probes: {
          sales: {
            success: false,
            at: '2026-10-16T10:00:00.000Z',
            error: { category: 'unreachable', code: 'server_stopped', message: 'stopped' },
          },
        },
      });
      render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
      await screen.findAllByText('1. Connect data');
      expect(stepStatus(/4\. Connect and test the MCP/)).toBe('current');
      expect(screen.getByRole('alert').textContent).toContain(
        'Last MCP test failed: server stopped.',
      );
    });
  });

  it('renders step actions under the title and hint, not beside them', async () => {
    installServer({ configurations: [salesData], profiles: salesMcp });
    render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
    await screen.findAllByText('1. Connect data');
    // Step 4 has two actions; done steps keep a single one. All must sit in the
    // text column so the title and hint keep the full card width.
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(4);
    const buttons = items.flatMap((li) => Array.from(li.querySelectorAll('button')));
    expect(buttons).toHaveLength(5);
    for (const button of buttons) {
      const textColumn = button.closest('li')?.querySelector(':scope > div');
      expect(textColumn).toBeTruthy();
      expect(textColumn?.contains(button)).toBe(true);
      expect(button.parentElement?.className).toContain('flex-wrap');
    }
  });

  it('queries the audit log per attached MCP for one successful call only', async () => {
    const server = installServer({ configurations: [salesData], profiles: salesMcp });
    render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
    await screen.findAllByText('1. Connect data');
    expect(auditUrls(server)).toEqual([
      '/api/audit?profileName=sales&result=success&limit=1&offset=0',
    ]);
  });

  describe('success state once a client has called the MCP', () => {
    const usedServer: ServerState = {
      configurations: [salesData],
      profiles: salesMcp,
      entries: [{ profileName: 'sales', result: 'success' }],
    };

    it('shows 4/4, congratulations, the client confirmation and next actions', async () => {
      installServer(usedServer);
      const onNavigate = vi.fn();
      render(<SetupChecklist sourceCount={1} onNavigate={onNavigate} />);
      const success = await screen.findByTestId('setup-success');
      expect(screen.getByRole('heading').textContent).toBe('Getting started · 4/4');
      expect(success.textContent).toContain('Congratulations, your MCP server works!');
      expect(success.textContent).toContain('A client has called this MCP server successfully.');
      // Not hidden automatically: nothing is persisted until the user closes it.
      expect(localStorage.getItem(SETUP_CHECKLIST_DISMISSED_KEY)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Open the MCP server' }));
      expect(onNavigate).toHaveBeenCalledWith({ page: 'mcp-detail', profileName: 'sales' });
      fireEvent.click(screen.getByRole('button', { name: 'See the calls in the audit log' }));
      expect(onNavigate).toHaveBeenCalledWith({ page: 'audit-log' });
      expect(screen.getByTestId('setup-success')).toBeTruthy();
    });

    it('stays visible across reloads until it is closed, then stays closed', async () => {
      const server = installServer(usedServer);
      const first = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
      await screen.findByTestId('setup-success');
      first.unmount();

      const second = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
      await screen.findByTestId('setup-success');
      fireEvent.click(screen.getByRole('button', { name: 'Close the guide' }));
      expect(screen.queryByTestId('setup-success')).toBeNull();
      expect(localStorage.getItem(SETUP_CHECKLIST_DISMISSED_KEY)).toBe('1');
      second.unmount();

      const calls = server.mock.calls.length;
      const { container } = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
      expect(container.innerHTML).toBe('');
      // Closed for good: the server is not even queried.
      expect(server.mock.calls.length).toBe(calls);
    });

    it('shows the success once to installations hidden automatically by the former flag', async () => {
      localStorage.setItem(SETUP_CHECKLIST_LEGACY_HIDDEN_KEY, '1');
      installServer(usedServer);
      render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
      await screen.findByTestId('setup-success');
      fireEvent.click(screen.getByRole('button', { name: 'Close the guide' }));
      expect(localStorage.getItem(SETUP_CHECKLIST_DISMISSED_KEY)).toBe('1');
      expect(localStorage.getItem(SETUP_CHECKLIST_LEGACY_HIDDEN_KEY)).toBeNull();
    });

    it('names the success in the folded pill', async () => {
      localStorage.setItem(SETUP_CHECKLIST_COLLAPSED_KEY, '1');
      installServer(usedServer);
      render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
      const pill = await screen.findByRole('button', { name: 'Reopen the getting-started guide' });
      expect(pill.textContent).toContain('Getting started · 4/4');
      expect(screen.getByTestId('setup-pill-step').textContent).toBe('Your MCP works ✓');
    });
  });

  describe('periodic check while step 4 waits for a client call', () => {
    function auditCount(server: ReturnType<typeof installServer>): number {
      return auditUrls(server).length;
    }

    it('detects the first client call without focus or "Check again", then stops', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const state: ServerState = { configurations: [salesData], profiles: salesMcp };
      const server = installServer(state);
      render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
      await screen.findAllByText('1. Connect data');
      expect(stepStatus(/4\. Connect and test the MCP/)).toBe('current');

      // A client calls the MCP from another application.
      state.entries = [{ profileName: 'sales', result: 'success' }];
      await act(async () => {
        vi.advanceTimersByTime(SETUP_POLL_INTERVAL_MS);
      });
      await screen.findByTestId('setup-success');

      const calls = auditCount(server);
      await act(async () => {
        vi.advanceTimersByTime(SETUP_POLL_INTERVAL_MS * 3);
      });
      expect(auditCount(server)).toBe(calls);
    });

    it('does not poll before step 4', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const server = installServer({ configurations: [salesData] });
      render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
      await screen.findAllByText('1. Connect data');
      const calls = server.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(SETUP_POLL_INTERVAL_MS * 3);
      });
      expect(server.mock.calls.length).toBe(calls);
    });

    it('is bounded, skips ticks while a request is pending, and is cleared on unmount', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const server = installServer({ configurations: [salesData], profiles: salesMcp });
      const view = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
      await screen.findAllByText('1. Connect data');
      const initial = auditCount(server);

      // A pending request: further ticks must not start concurrent ones.
      let release: () => void = () => {};
      const realFetch = server.getMockImplementation()!;
      server.mockImplementationOnce(async (input) => {
        await new Promise<void>((resolve) => (release = resolve));
        return realFetch(input);
      });
      await act(async () => {
        vi.advanceTimersByTime(SETUP_POLL_INTERVAL_MS * 3);
      });
      const pendingCalls = server.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(SETUP_POLL_INTERVAL_MS * 2);
      });
      expect(server.mock.calls.length).toBe(pendingCalls);
      await act(async () => release());
      await waitFor(() => expect(auditCount(server)).toBe(initial + 1));

      for (let i = 0; i < SETUP_POLL_MAX_ATTEMPTS + 5; i++) {
        await act(async () => {
          vi.advanceTimersByTime(SETUP_POLL_INTERVAL_MS);
        });
      }
      expect(auditCount(server)).toBe(initial + SETUP_POLL_MAX_ATTEMPTS);

      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('re-checks after an action that changes a step (new data profile / MCP)', async () => {
    const state: ServerState = { configurations: [salesData] };
    const server = installServer(state);
    const view = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} refreshKey={1} />);
    await screen.findAllByText('1. Connect data');
    expect(stepStatus(/3\. Create the MCP server/)).toBe('current');
    state.profiles = salesMcp;
    const calls = server.mock.calls.length;
    view.rerender(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} refreshKey={2} />);
    await waitFor(() => expect(stepStatus(/3\. Create the MCP server/)).toBe('done'));
    expect(server.mock.calls.length).toBeGreaterThan(calls);
  });

  it('can be folded and reopened, and stays folded across reloads', async () => {
    installServer({ configurations: [salesData] });
    const first = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
    await screen.findAllByText('1. Connect data');
    fireEvent.click(screen.getByRole('button', { name: 'Fold the getting-started guide' }));
    expect(screen.queryByText('1. Connect data')).toBeNull();
    expect(localStorage.getItem(SETUP_CHECKLIST_COLLAPSED_KEY)).toBe('1');
    first.unmount();

    render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
    const reopen = await screen.findByRole('button', { name: 'Reopen the getting-started guide' });
    // The pill names the current step so the guide stays readable while folded.
    expect(reopen.textContent).toContain('Getting started · 2/4');
    expect(screen.getByTestId('setup-pill-step').textContent).toBe('3. Create the MCP server');
    fireEvent.click(reopen);
    expect(screen.getAllByText('1. Connect data').length).toBeGreaterThan(0);
    expect(localStorage.getItem(SETUP_CHECKLIST_COLLAPSED_KEY)).toBeNull();
  });

  it('re-checks the server on window focus and on the setup refresh event', async () => {
    const server = installServer({});
    render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
    await screen.findAllByText('1. Connect data');
    const calls = server.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('calame:setup-refresh'));
    });
    await waitFor(() => expect(server.mock.calls.length).toBeGreaterThan(calls));
  });

  it('shows an error with a retry action when the state cannot be loaded', async () => {
    const server: ServerState = { fail: true };
    installServer(server);
    render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not check your setup progress.',
    );
    server.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findAllByText('1. Connect data');
  });

  it('reads the real first-run payload (empty configurations object) without erroring', async () => {
    // Exact body returned by GET /api/configurations on a fresh install.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/api/configurations')) {
          return jsonResponse({ success: true, configurations: {} });
        }
        if (url.includes('/api/profiles/load')) return jsonResponse({ found: false });
        return jsonResponse({});
      }),
    );
    render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} />);
    await screen.findAllByText('1. Connect data');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(stepStatus(/1\. Connect data/)).toBe('current');
  });

  it('completes the data and data profile steps from an indexed knowledge-base source', async () => {
    installServer({
      configurations: [{ name: 'docs-config', sources: ['rag:src-1'] }],
      ragSources: [{ id: 'src-1', name: 'Docs' }],
      ragJobs: [{ sourceId: 'src-1', status: 'completed', error: null }],
    });
    render(<SetupChecklist sourceCount={0} ragEnabled onNavigate={vi.fn()} />);
    await screen.findAllByText('1. Connect data');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(stepStatus(/1\. Connect data/)).toBe('done');
    expect(stepStatus(/2\. Create a data profile/)).toBe('done');
    expect(stepStatus(/3\. Create the MCP server/)).toBe('current');
  });

  it('starts as a compact pill on a narrow window so it never covers page actions', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 899px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    installServer({});
    render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} />);
    const reopen = await screen.findByRole('button', { name: 'Reopen the getting-started guide' });
    // Folded: only the current step's name, not the step list.
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByTestId('setup-pill-step').textContent).toBe('1. Connect data');
    // Folding by width is not a user choice: nothing is persisted.
    expect(localStorage.getItem(SETUP_CHECKLIST_COLLAPSED_KEY)).toBeNull();
    fireEvent.click(reopen);
    expect(screen.getAllByText('1. Connect data').length).toBeGreaterThan(0);
  });

  it('folds back to the pill after a step action on a narrow window', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 899px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    installServer({});
    const onNavigate = vi.fn();
    render(<SetupChecklist sourceCount={0} onNavigate={onNavigate} />);
    const pill = await screen.findByRole('button', { name: 'Reopen the getting-started guide' });
    expect(screen.getByTestId('setup-pill-step').textContent).toBe('1. Connect data');
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole('button', { name: 'Add data' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'sources' });
    // The destination page's commands are not left under the open card.
    expect(screen.getByRole('button', { name: 'Reopen the getting-started guide' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add data' })).toBeNull();
  });

  // The guide is laid out with the page (a column or a block above it): it
  // can cover nothing, whatever the page or the scroll position.
  const expectInLayout = (el: HTMLElement) => {
    for (const cls of ['fixed', 'absolute']) expect(el.className.split(/\s+/)).not.toContain(cls);
    expect(el.className).not.toMatch(/(^|\s)(inset-|bottom-|right-|z-)/);
  };

  it('keeps the folded pill in the page layout, above the content', async () => {
    localStorage.setItem(SETUP_CHECKLIST_COLLAPSED_KEY, '1');
    const onLayoutChange = vi.fn();
    installServer({});
    render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} onLayoutChange={onLayoutChange} />);
    const pill = await screen.findByRole('button', { name: 'Reopen the getting-started guide' });
    expectInLayout(pill);
    expectInLayout(screen.getByTestId('setup-checklist-pill-row'));
    expect(onLayoutChange).toHaveBeenLastCalledWith('top');
  });

  it('lays the expanded guide out as a column beside the page on a wide window', async () => {
    installServer({});
    const onLayoutChange = vi.fn();
    render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} onLayoutChange={onLayoutChange} />);
    await screen.findAllByText('1. Connect data');
    const panel = screen.getByTestId('setup-checklist-panel');
    expect(panel.getAttribute('data-layout')).toBe('column');
    expectInLayout(panel);
    // Its own scroll, viewport-high, with a fixed width taken from the content.
    expect(panel.className).toContain('overflow-y-auto');
    expect(panel.className).toContain('flex-none');
    expect(onLayoutChange).toHaveBeenLastCalledWith('column');

    // Folding to the pill gives the width back to the page.
    fireEvent.click(screen.getByRole('button', { name: 'Fold the getting-started guide' }));
    expect(onLayoutChange).toHaveBeenLastCalledWith('top');
  });

  it('opens as a block above the content on a narrow window, never a column', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 899px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    installServer({});
    const onLayoutChange = vi.fn();
    render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} onLayoutChange={onLayoutChange} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Reopen the getting-started guide' }),
    );
    const panel = screen.getByTestId('setup-checklist-panel');
    expect(panel.getAttribute('data-layout')).toBe('top');
    expectInLayout(panel);
    expectInLayout(panel.parentElement as HTMLElement);
    expect(onLayoutChange).not.toHaveBeenCalledWith('column');
    expect(onLayoutChange).toHaveBeenLastCalledWith('top');
  });

  it('gives the layout back when the guide is closed after success', async () => {
    installServer({
      configurations: [salesData],
      profiles: salesMcp,
      entries: [{ profileName: 'sales', result: 'success' }],
    });
    const onLayoutChange = vi.fn();
    render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} onLayoutChange={onLayoutChange} />);
    await screen.findByTestId('setup-success');
    expect(onLayoutChange).toHaveBeenLastCalledWith('column');
    fireEvent.click(screen.getByRole('button', { name: 'Close the guide' }));
    expect(onLayoutChange).toHaveBeenLastCalledWith('none');
  });
});
