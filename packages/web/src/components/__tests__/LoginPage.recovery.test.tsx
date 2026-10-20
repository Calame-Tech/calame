// LoginPage — "forgotten admin account" help. The help is reachable without
// signing in, is purely informational (only ever GETs the read-only
// /api/auth/recovery-help, never a mutating request), shows the real data
// folder only when the server reports the packaged desktop app, and keeps
// calame.db and .calame-secret together in its instructions.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import LoginPage from '../LoginPage.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

function mockRecoveryHelp(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => body }) as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([input, init]) => ({
    url: String(input),
    method: ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('LoginPage — forgotten admin account help', () => {
  it('offers a visible link and makes no request until it is opened', () => {
    const fetchMock = mockRecoveryHelp({});
    render(<LoginPage onAdminLogin={() => {}} onUserLogin={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'Forgot the administrator account?' }),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('desktop: shows the real data folder, backup steps and the db + secret pair', async () => {
    localStorage.setItem('calame-locale', 'fr');
    const fetchMock = mockRecoveryHelp({
      success: true,
      desktop: true,
      dataDirLabel: '%APPDATA%\\Calame',
    });
    render(<LoginPage onAdminLogin={() => {}} onUserLogin={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Compte administrateur oublié ?' }));

    expect(await screen.findByText('%APPDATA%\\Calame')).toBeInTheDocument();
    const help = screen.getByRole('region', { name: 'Compte administrateur oublié' });
    expect(help).toHaveTextContent('« Réinitialiser le compte administrateur… »');
    expect(help).toHaveTextContent('rien n’est effacé');
    expect(help).toHaveTextContent('Quittez complètement Calame');
    expect(help).toHaveTextContent('copiez le dossier entier');
    expect(help).toHaveTextContent('calame.db et .calame-secret ensemble');
    expect(help).toHaveTextContent('Repartir de zéro fait perdre le compte administrateur');
    expect(requests(fetchMock)).toEqual([{ url: '/api/auth/recovery-help', method: 'GET' }]);
  });

  it('desktop with a custom CALAME_DATA_DIR: points at the variable, invents no path', async () => {
    mockRecoveryHelp({ success: true, desktop: true, dataDirLabel: null });
    render(<LoginPage onAdminLogin={() => {}} onUserLogin={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Forgot the administrator account?' }));

    expect(
      await screen.findByText(/in the folder set by the CALAME_DATA_DIR variable/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/%APPDATA%/)).not.toBeInTheDocument();
    // The tray reset never moves a custom folder, so it is not offered here.
    expect(screen.queryByText(/Réinitialiser le compte administrateur/)).not.toBeInTheDocument();
  });

  it('browser / server: generic help with no local path and no reset action', async () => {
    const fetchMock = mockRecoveryHelp({ success: true, desktop: false, dataDirLabel: null });
    render(<LoginPage onAdminLogin={() => {}} onUserLogin={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Forgot the administrator account?' }));

    const help = await screen.findByRole('region', { name: 'Administrator account forgotten' });
    await waitFor(() => expect(help).toHaveTextContent('Ask the person who administers it'));
    expect(help).not.toHaveTextContent('%APPDATA%');
    expect(help).not.toHaveTextContent('Application Support');
    expect(help).not.toHaveTextContent('Réinitialiser le compte administrateur');
    // The only action in the help is closing it.
    expect(Array.from(help.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Close the help',
    ]);
    expect(requests(fetchMock).every((r) => r.method === 'GET')).toBe(true);
  });

  it('falls back to the generic help when the help endpoint is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    render(<LoginPage onAdminLogin={() => {}} onUserLogin={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Forgot the administrator account?' }));

    expect(await screen.findByText(/Ask the person who administers it/)).toBeInTheDocument();
  });

  it('closes back to the link', async () => {
    mockRecoveryHelp({ success: true, desktop: false, dataDirLabel: null });
    render(<LoginPage onAdminLogin={() => {}} onUserLogin={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Forgot the administrator account?' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close the help' }));

    expect(
      screen.getByRole('button', { name: 'Forgot the administrator account?' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
