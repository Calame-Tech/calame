// SetupChecklist — guided path (source → MCP → client). The state must come
// from the server resources (saved profiles + audit log), so it survives a
// reload, and the client step only completes on an audited call.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import SetupChecklist from '../SetupChecklist.js';
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
      return jsonResponse({
        entries: (server.entries ?? []).map((e, i) => ({
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

function stepStatus(title: RegExp): string | null {
  return screen.getByText(title).closest('li')?.getAttribute('data-status') ?? null;
}

describe('SetupChecklist', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a loading state, then step 1 as the next action when nothing exists', async () => {
    installServer({});
    render(<SetupChecklist sourceCount={0} onNavigate={vi.fn()} />);

    expect(screen.getByRole('status').textContent).toMatch(/Checking your setup/);
    await waitFor(() => expect(stepStatus(/1\. Connect a source/)).toBe('current'));
    expect(stepStatus(/2\. Create the MCP server/)).toBe('todo');
    expect(stepStatus(/3\. Use it from a client/)).toBe('todo');
    // Steps that cannot be started yet offer no action.
    expect(screen.queryByRole('button', { name: 'Create the MCP server' })).toBeNull();
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

  it('hides itself once a successful client call is in the audit log', async () => {
    const server = installServer({
      profiles: { sales: { configurations: ['sales-config'] } },
      entries: [{ profileName: 'sales', result: 'success' }],
    });
    const { container } = render(<SetupChecklist sourceCount={1} onNavigate={vi.fn()} />);

    await waitFor(() => expect(server).toHaveBeenCalled());
    await waitFor(() => expect(container.innerHTML).toBe(''));
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
