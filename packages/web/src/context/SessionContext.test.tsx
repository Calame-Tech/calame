// Point 01: an unreachable server must not be mistaken for an invalid
// session — the user keeps their (persisted) session and can retry, instead
// of being sent to the login page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SessionProvider, useSession } from './SessionContext.js';

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function Probe() {
  const { authChecked, authCheckFailed, authenticated, retryAuthCheck } = useSession();
  if (!authChecked) return <p>checking</p>;
  return (
    <div>
      <p>{authCheckFailed ? 'unreachable' : authenticated ? 'signed in' : 'signed out'}</p>
      <button onClick={retryAuthCheck}>retry</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
}

describe('SessionProvider auth probe', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('restores a still-valid session on app opening', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes('/api/auth/status')
          ? json({ success: true, authenticated: true, authRequired: true })
          : json({ success: true, authenticated: false }),
      ),
    );
    renderProbe();
    expect(await screen.findByText('signed in')).toBeTruthy();
  });

  it('treats an expired or revoked session as signed out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ success: true, authenticated: false, authRequired: true })),
    );
    renderProbe();
    expect(await screen.findByText('signed out')).toBeTruthy();
  });

  it('reports a network failure as unreachable, then recovers on retry', async () => {
    let online = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (!online) throw new TypeError('Failed to fetch');
        return String(input).includes('/api/auth/status')
          ? json({ success: true, authenticated: true, authRequired: true })
          : json({ success: true, authenticated: false });
      }),
    );
    renderProbe();
    expect(await screen.findByText('unreachable')).toBeTruthy();

    online = true;
    await act(async () => {
      fireEvent.click(screen.getByText('retry'));
    });
    expect(await screen.findByText('signed in')).toBeTruthy();
  });

  it('reports a server error as unreachable, not as signed out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ success: false }, 503)),
    );
    renderProbe();
    expect(await screen.findByText('unreachable')).toBeTruthy();
  });
});
