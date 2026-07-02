// UsersPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UsersPage from '../UsersPage.js';
import { makeProfile, installFetchMock, flushEffects } from './testUtils.js';

function renderPage(setView = vi.fn()) {
  render(<UsersPage view={{ page: 'users' }} setView={setView} profiles={[makeProfile()]} />);
  return setView;
}

describe('UsersPage', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the users page header and the user management panel', async () => {
    const fetchMock = installFetchMock();
    renderPage();
    expect(screen.getByText('Users & Access')).toBeTruthy();
    await flushEffects();
    // UserManagement loaded its (empty) user list on mount
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/users'))).toBe(true);
  });

  it('navigates back to the dashboard via the breadcrumb', async () => {
    const setView = renderPage();
    fireEvent.click(screen.getByText('Dashboard'));
    expect(setView).toHaveBeenCalledWith({ page: 'dashboard' });
    await flushEffects();
  });
});
