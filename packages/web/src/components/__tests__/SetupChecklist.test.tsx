// SetupChecklist — floating guided path (data → data profile → MCP → client).
// The state must come from the server resources (data profiles, saved MCPs,
// audit log), so it survives a reload, and the client step only completes on
// an audited call.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import SetupChecklist, {
  SETUP_CHECKLIST_COLLAPSED_KEY,
  SETUP_CHECKLIST_HIDDEN_KEY,
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
    vi.unstubAllGlobals();
    localStorage.removeItem(SETUP_CHECKLIST_HIDDEN_KEY);
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

  it('queries the audit log per attached MCP for one successful call only', async () => {
    const server = installServer({ configurations: [salesData], profiles: salesMcp });
    render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
    await screen.findAllByText('1. Connect data');
    expect(auditUrls(server)).toEqual([
      '/api/audit?profileName=sales&result=success&limit=1&offset=0',
    ]);
  });

  it('disappears for good once the first MCP has been used by a client', async () => {
    installServer({
      configurations: [salesData],
      profiles: salesMcp,
      entries: [{ profileName: 'sales', result: 'success' }],
    });
    const { container } = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
    await waitFor(() => expect(localStorage.getItem(SETUP_CHECKLIST_HIDDEN_KEY)).toBe('1'));
    expect(container.innerHTML).toBe('');
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
        matches: query === '(max-width: 1023px)',
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
        matches: query === '(max-width: 1023px)',
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

  it('reserves room at the bottom of the page for the floating card', async () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ height: 40 } as DOMRect);
    try {
      installServer({});
      render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} />);
      await screen.findAllByText('1. Connect data');
      const spacer = screen.getByTestId('setup-checklist-spacer');
      expect(spacer.style.height).toBe('64px');
      expect(spacer.getAttribute('aria-hidden')).toBe('true');
    } finally {
      rect.mockRestore();
    }
  });
});
