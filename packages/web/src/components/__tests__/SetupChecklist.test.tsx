// SetupChecklist — guided path (source → MCP → client). The state must come
// from the server resources (saved profiles + audit log), so it survives a
// reload, and the client step only completes on an audited call.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import SetupChecklist, { SETUP_CHECKLIST_HIDDEN_KEY } from '../SetupChecklist.js';
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
  profiles?: Record<string, { configurations?: string[]; sources?: unknown[] }>;
  entries?: Array<{ profileName: string; result: 'success' | 'error' }>;
  fail?: boolean;
}

function installServer(server: ServerState) {
  const mock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (server.fail) return jsonResponse({ success: false }, false);
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
  return screen.getByText(title).closest('li')?.getAttribute('data-status') ?? null;
}

describe('SetupChecklist', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.removeItem(SETUP_CHECKLIST_HIDDEN_KEY);
  });

  it('renders nothing before the first answer, then step 1 as the next action', async () => {
    const server = installServer({});
    const { container } = render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} />);

    // No flash of the guide for installations that turn out to be set up.
    expect(container.innerHTML).toBe('');
    await waitFor(() => expect(stepStatus(/1\. Connect a source/)).toBe('current'));
    expect(stepStatus(/2\. Create the MCP server/)).toBe('todo');
    expect(stepStatus(/3\. Use it from a client/)).toBe('todo');
    // Steps that cannot be started yet offer no action.
    expect(screen.queryByRole('button', { name: 'Create the MCP server' })).toBeNull();
    // No MCP yet: the audit log is not queried at all.
    expect(auditUrls(server)).toHaveLength(0);
  });

  it('points to MCP creation right after a source is created', async () => {
    const server = installServer({});
    const onNavigate = vi.fn();
    const { rerender } = render(<SetupChecklist sourceCount={0} onNavigate={onNavigate} />);
    await waitFor(() => expect(stepStatus(/1\. Connect a source/)).toBe('current'));

    // The host page reports the new source (connection or knowledge base).
    const callsBefore = server.mock.calls.length;
    rerender(<SetupChecklist sourceCount={1} onNavigate={onNavigate} />);

    await waitFor(() => expect(stepStatus(/2\. Create the MCP server/)).toBe('current'));
    expect(server.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(screen.getByText(/Next: create an MCP server/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create the MCP server' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'mcp-list' });
  });

  it('keeps step 2 current when only the empty "default" placeholder is saved', async () => {
    // Real server shape after deleting the last MCP: the placeholder is
    // re-persisted and /api/profiles/load backfills sources: ['default'].
    installServer({
      profiles: { default: { sources: ['default'] } },
      entries: [{ profileName: 'default', result: 'success' }],
    });
    render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);

    await waitFor(() => expect(stepStatus(/2\. Create the MCP server/)).toBe('current'));
    expect(stepStatus(/3\. Use it from a client/)).toBe('todo');
    expect(screen.queryByRole('button', { name: 'Connect a client' })).toBeNull();
  });

  it('gives client instructions once the MCP is saved, without marking it used', async () => {
    installServer({
      profiles: { sales: { configurations: ['sales-config'] } },
      // A failed call is not proof that the client works.
      entries: [{ profileName: 'sales', result: 'error' }],
    });
    const onNavigate = vi.fn();
    render(<SetupChecklist sourceCount={1} onNavigate={onNavigate} />);

    await waitFor(() => expect(stepStatus(/3\. Use it from a client/)).toBe('current'));
    expect(stepStatus(/2\. Create the MCP server/)).toBe('done');
    expect(screen.getByText(/first successful call appears in the audit log/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Connect a client' }));
    expect(onNavigate).toHaveBeenCalledWith({
      page: 'mcp-detail',
      profileName: 'sales',
      activeSection: 'connect',
    });
  });

  it('queries the audit log per MCP for one successful call only', async () => {
    const server = installServer({
      profiles: { sales: { configurations: ['sales-config'] } },
      entries: [{ profileName: 'sales', result: 'error' }],
    });
    render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);

    await waitFor(() => expect(stepStatus(/3\. Use it from a client/)).toBe('current'));
    expect(auditUrls(server)).toEqual([
      '/api/audit?profileName=sales&result=success&limit=1&offset=0',
    ]);
  });

  it('hides itself for good once a successful client call is in the audit log', async () => {
    const server = installServer({
      profiles: { sales: { configurations: ['sales-config'] } },
      entries: [
        { profileName: 'sales', result: 'error' },
        { profileName: 'sales', result: 'success' },
      ],
    });
    const { container, unmount } = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);

    await waitFor(() => expect(server).toHaveBeenCalled());
    await waitFor(() => expect(localStorage.getItem(SETUP_CHECKLIST_HIDDEN_KEY)).toBe('1'));
    expect(container.innerHTML).toBe('');
    unmount();

    // An installation with a used MCP does not query or show the guide again.
    server.mockClear();
    const second = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
    expect(second.container.innerHTML).toBe('');
    expect(server).not.toHaveBeenCalled();
  });

  it('can be hidden by the user, persistently', async () => {
    const server = installServer({});
    const { container, unmount } = render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} />);
    await waitFor(() => expect(stepStatus(/1\. Connect a source/)).toBe('current'));

    fireEvent.click(screen.getByRole('button', { name: 'Hide the getting-started guide' }));
    expect(container.innerHTML).toBe('');
    expect(localStorage.getItem(SETUP_CHECKLIST_HIDDEN_KEY)).toBe('1');
    unmount();

    server.mockClear();
    render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} />);
    expect(server).not.toHaveBeenCalled();
  });

  it('does not poll on a timer, but re-checks on window focus and on demand', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state: ServerState = {
      profiles: { sales: { configurations: ['sales-config'] } },
      entries: [],
    };
    const server = installServer(state);
    const { container } = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
    await waitFor(() => expect(stepStatus(/3\. Use it from a client/)).toBe('current'));

    const callsAfterLoad = server.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(server.mock.calls.length).toBe(callsAfterLoad);

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(server.mock.calls.length).toBeGreaterThan(callsAfterLoad));

    // The user comes back from their AI client after a successful call.
    state.entries = [{ profileName: 'sales', result: 'success' }];
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('ignores a stale response that arrives after a newer one', async () => {
    let releaseFirst: (res: Response) => void = () => {};
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/api/profiles/load')) {
          call += 1;
          if (call === 1) {
            // First (older) request: answers last, with an outdated "no MCP".
            return new Promise<Response>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return jsonResponse({
            found: true,
            profiles: { sales: { configurations: ['sales-config'] } },
          });
        }
        return jsonResponse({ entries: [] });
      }),
    );

    const { rerender } = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);
    rerender(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} refreshKey={1} />);
    await waitFor(() => expect(stepStatus(/3\. Use it from a client/)).toBe('current'));

    await act(async () => {
      releaseFirst(jsonResponse({ found: false, profiles: {} }));
    });
    expect(stepStatus(/2\. Create the MCP server/)).toBe('done');
    expect(stepStatus(/3\. Use it from a client/)).toBe('current');
  });

  it('shows an error with a retry action when the state cannot be loaded', async () => {
    const server: ServerState = { fail: true };
    installServer(server);
    render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not check/);

    server.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(stepStatus(/2\. Create the MCP server/)).toBe('current'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
