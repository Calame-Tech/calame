// TenantsPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TenantsPage from '../TenantsPage.js';
import { installFetchMock, flushEffects } from './testUtils.js';

describe('TenantsPage', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the workspaces header and loads the tenant list', async () => {
    const fetchMock = installFetchMock();
    render(<TenantsPage setView={vi.fn()} />);
    expect(screen.getAllByText('Workspaces').length).toBeGreaterThanOrEqual(1);
    await flushEffects();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/tenants'))).toBe(true);
  });

  it('navigates back to the dashboard via the breadcrumb', async () => {
    const setView = vi.fn();
    render(<TenantsPage setView={setView} />);
    fireEvent.click(screen.getByText('Dashboard'));
    expect(setView).toHaveBeenCalledWith({ page: 'dashboard' });
    await flushEffects();
  });
});
