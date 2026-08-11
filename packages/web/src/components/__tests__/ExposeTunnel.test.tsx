// ExposeTunnel component tests.
//
// Covers the "Remote access — Copilot & ChatGPT" section on the MCP detail
// page: the unavailable note, the start flow (spinner → running state with a
// copyable URL), error surfacing, the stop flow, and the two collapsed
// step-by-step guides.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ExposeTunnel from '../ExposeTunnel.js';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface StatusOverrides {
  running?: boolean;
  url?: string | null;
  available?: boolean;
  unavailableReason?: string | null;
}

interface StartStopResponse {
  success: boolean;
  url?: string;
  message?: string;
}

/**
 * Stateful fetch stub: /api/tunnel/start and /stop flip an internal
 * running/url flag that the subsequent /api/tunnel/status refetch reflects —
 * mirrors the real backend's start-then-poll contract instead of returning a
 * fixed status regardless of what was called.
 */
function installFetchMock(
  initial: StatusOverrides = {},
  {
    startResponse,
    stopResponse,
  }: { startResponse?: StartStopResponse; stopResponse?: StartStopResponse } = {},
) {
  let running = initial.running ?? false;
  let tunnelUrl = initial.url ?? null;
  const available = initial.available ?? true;
  const unavailableReason = initial.unavailableReason ?? null;

  const mock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/tunnel/status')) {
      return jsonResponse({
        success: true,
        running,
        url: running ? tunnelUrl : null,
        startedAt: running ? '2026-01-01T00:00:00.000Z' : null,
        available,
        unavailableReason,
      });
    }
    if (url.includes('/api/tunnel/start')) {
      const response: StartStopResponse = startResponse ?? {
        success: true,
        url: 'https://random-name.trycloudflare.com',
      };
      if (response.success) {
        running = true;
        tunnelUrl = response.url ?? 'https://random-name.trycloudflare.com';
      }
      return jsonResponse(response);
    }
    if (url.includes('/api/tunnel/stop')) {
      const response: StartStopResponse = stopResponse ?? { success: true };
      if (response.success) {
        running = false;
      }
      return jsonResponse(response);
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

describe('ExposeTunnel', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a muted note with the reason when unavailable', async () => {
    installFetchMock({ available: false, unavailableReason: 'cloudflared binary not found.' });
    render(<ExposeTunnel profileName="default" />);
    await flushEffects();

    expect(screen.getByText('cloudflared binary not found.')).toBeTruthy();
    expect(screen.queryByText('Expose this server')).toBeNull();
  });

  it('starts the tunnel and shows the running state with a copyable URL', async () => {
    installFetchMock(
      {},
      { startResponse: { success: true, url: 'https://random-name.trycloudflare.com' } },
    );
    render(<ExposeTunnel profileName="default" />);
    await flushEffects();

    expect(screen.getByText('Expose this server')).toBeTruthy();

    fireEvent.click(screen.getByText('Expose this server'));
    expect(screen.getByText(/Opening secure tunnel/)).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Tunnel active')).toBeTruthy();
    });
    expect(screen.getByText('https://random-name.trycloudflare.com/mcp/default')).toBeTruthy();

    fireEvent.click(screen.getAllByText('Copy')[0]);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://random-name.trycloudflare.com/mcp/default',
      );
    });
    expect(await screen.findByText('Copied!')).toBeTruthy();
  });

  it('surfaces the error message when starting fails', async () => {
    installFetchMock(
      {},
      { startResponse: { success: false, message: 'Could not start cloudflared.' } },
    );
    render(<ExposeTunnel profileName="default" />);
    await flushEffects();

    fireEvent.click(screen.getByText('Expose this server'));

    await waitFor(() => {
      expect(screen.getByText('Could not start cloudflared.')).toBeTruthy();
    });
    expect(screen.queryByText('Tunnel active')).toBeNull();
  });

  it('stops the tunnel from the running state', async () => {
    installFetchMock({ running: true, url: 'https://already-running.trycloudflare.com' });
    render(<ExposeTunnel profileName="default" />);
    await flushEffects();

    expect(screen.getByText('Tunnel active')).toBeTruthy();

    fireEvent.click(screen.getByText('Stop tunnel'));

    await waitFor(() => {
      expect(screen.getByText('Expose this server')).toBeTruthy();
    });
    expect(screen.queryByText('Tunnel active')).toBeNull();
  });

  it('expands both step-by-step guides', async () => {
    installFetchMock({});
    render(<ExposeTunnel profileName="default" />);
    await flushEffects();

    const copilotToggle = screen.getByText('Microsoft Copilot (Copilot Studio)');
    expect(copilotToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(copilotToggle);
    expect(copilotToggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByText(
        'In Copilot Studio: Tools → Add a tool → New tool → Model Context Protocol.',
      ),
    ).toBeTruthy();

    const chatGptToggle = screen.getByText('ChatGPT (developer mode connectors)');
    expect(chatGptToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chatGptToggle);
    expect(chatGptToggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByText('In ChatGPT: Settings → Connectors → Add custom connector.'),
    ).toBeTruthy();
  });
});
