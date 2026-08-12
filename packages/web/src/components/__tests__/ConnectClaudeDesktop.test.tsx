// ConnectClaudeDesktop component tests (Phase D).
//
// Covers the "Connect your AI" section on the MCP detail page: the
// detected/not-detected/not-supported status renders, the successful
// connect flow, error surfacing, and the manual-snippet copy fallback.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ConnectClaudeDesktop from '../ConnectClaudeDesktop.js';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface StatusOverrides {
  supported?: boolean;
  detected?: boolean;
  configPath?: string | null;
  entries?: Array<{ key: string; profileName: string | null }>;
}

function installFetchMock(
  statusOverrides: StatusOverrides = {},
  {
    connectResponse,
    snippetResponse,
  }: { connectResponse?: unknown; snippetResponse?: unknown } = {},
) {
  const status = {
    success: true,
    supported: true,
    detected: true,
    configPath: '/Users/dev/Library/Application Support/Claude/claude_desktop_config.json',
    entries: [],
    ...statusOverrides,
  };
  const mock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/integrations/claude-desktop/status')) {
      return jsonResponse(status);
    }
    if (url.includes('/api/integrations/claude-desktop/connect')) {
      return jsonResponse(
        connectResponse ?? {
          success: true,
          serverKey: 'calame-default',
          configPath: status.configPath,
        },
      );
    }
    if (url.includes('/api/integrations/claude-desktop/snippet')) {
      return jsonResponse(
        snippetResponse ?? {
          success: true,
          snippet: JSON.stringify(
            {
              mcpServers: {
                'calame-default': {
                  command: 'npx',
                  args: ['-y', 'calame-mcp-bridge', '<YOUR-CALAME-HOST>', '<TOKEN>'],
                },
              },
            },
            null,
            2,
          ),
        },
      );
    }
    return jsonResponse({ success: true });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ConnectClaudeDesktop', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the primary connect button when detected and not yet connected', async () => {
    installFetchMock({ detected: true, entries: [] });
    render(<ConnectClaudeDesktop profileName="default" />);
    await flushEffects();

    expect(screen.getByText('Connect to Claude Desktop')).toBeTruthy();
    expect(screen.queryByText('Already connected to Claude Desktop')).toBeNull();
  });

  it('shows a subdued confirmation with a Reconfigure action when already connected', async () => {
    installFetchMock({
      detected: true,
      entries: [{ key: 'calame-default', profileName: 'default' }],
    });
    render(<ConnectClaudeDesktop profileName="default" />);
    await flushEffects();

    expect(screen.getByText('Already connected to Claude Desktop')).toBeTruthy();
    expect(screen.getByText('Reconfigure')).toBeTruthy();
    expect(screen.queryByText('Connect to Claude Desktop')).toBeNull();
  });

  it('shows an explanatory empty-state when supported but not detected', async () => {
    installFetchMock({ supported: true, detected: false });
    render(<ConnectClaudeDesktop profileName="default" />);
    await flushEffects();

    expect(screen.getByText("Claude Desktop wasn't found on this machine.")).toBeTruthy();
    expect(screen.queryByText('Connect to Claude Desktop')).toBeNull();
    // The manual fallback toggle is still available.
    expect(screen.getByText('Other clients / another machine')).toBeTruthy();
  });

  it('shows only the manual-snippet fallback when not supported', async () => {
    installFetchMock({ supported: false, detected: false });
    render(<ConnectClaudeDesktop profileName="default" />);
    await flushEffects();

    expect(screen.queryByText('Connect to Claude Desktop')).toBeNull();
    expect(screen.queryByText("Claude Desktop wasn't found on this machine.")).toBeNull();
    expect(screen.queryByText('Already connected to Claude Desktop')).toBeNull();
    expect(screen.getByText('Other clients / another machine')).toBeTruthy();
  });

  it('connects successfully and shows the success state with the config path', async () => {
    installFetchMock({ detected: true, entries: [] });
    render(<ConnectClaudeDesktop profileName="default" />);
    await flushEffects();

    fireEvent.click(screen.getByText('Connect to Claude Desktop'));

    await waitFor(() => {
      expect(
        screen.getByText('Connected — restart Claude Desktop to see your tools.'),
      ).toBeTruthy();
    });
    expect(
      screen.getByText('/Users/dev/Library/Application Support/Claude/claude_desktop_config.json'),
    ).toBeTruthy();
  });

  it('surfaces the error message when the connect call fails', async () => {
    installFetchMock(
      { detected: true, entries: [] },
      { connectResponse: { success: false, message: 'Could not write the config file.' } },
    );
    render(<ConnectClaudeDesktop profileName="default" />);
    await flushEffects();

    fireEvent.click(screen.getByText('Connect to Claude Desktop'));

    await waitFor(() => {
      expect(screen.getByText('Could not write the config file.')).toBeTruthy();
    });
    // No success state was shown.
    expect(screen.queryByText('Connected — restart Claude Desktop to see your tools.')).toBeNull();
  });

  it('lazily fetches and displays the manual snippet, and copies it on click', async () => {
    const fetchMock = installFetchMock({ detected: true, entries: [] });
    render(<ConnectClaudeDesktop profileName="default" />);
    await flushEffects();

    // Snippet endpoint not called until the fallback is expanded.
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/claude-desktop/snippet')),
    ).toBe(false);

    fireEvent.click(screen.getByText('Other clients / another machine'));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('/claude-desktop/snippet')),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/calame-mcp-bridge/)).toBeTruthy();
    });
    expect(screen.getAllByText(/YOUR-CALAME-HOST/).length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByText('Copy'));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('calame-mcp-bridge'),
      );
    });
    expect(await screen.findByText('Copied!')).toBeTruthy();
  });

  it('surfaces an error when the snippet fetch fails', async () => {
    installFetchMock(
      { detected: true, entries: [] },
      { snippetResponse: { success: false, message: 'Failed to build the snippet.' } },
    );
    render(<ConnectClaudeDesktop profileName="default" />);
    await flushEffects();

    fireEvent.click(screen.getByText('Other clients / another machine'));

    await waitFor(() => {
      expect(screen.getByText('Failed to build the snippet.')).toBeTruthy();
    });
  });
});
