// AuditLogPage component tests (Lot C — governance UX overhaul).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AuditLogPage from '../AuditLogPage.js';
import { installFetchMock, flushEffects, makeProfile } from './testUtils.js';

describe('AuditLogPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the page header and the audit log viewer for every profile', async () => {
    installFetchMock();
    render(
      <AuditLogPage
        setView={vi.fn()}
        profiles={[makeProfile(), makeProfile({ name: 'analytics', label: 'Analytics' })]}
      />,
    );
    expect(screen.getAllByText('Audit Log').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Every tool call served by your MCP servers.')).toBeTruthy();
    await flushEffects();
    // Filter dropdown only renders when more than one profile is passed in —
    // confirms `profiles` (all profiles) was forwarded, not a single one.
    expect(screen.getByText('All profiles')).toBeTruthy();
  });

  it('navigates back to the dashboard via the breadcrumb', async () => {
    installFetchMock();
    const setView = vi.fn();
    render(<AuditLogPage setView={setView} profiles={[makeProfile()]} />);
    fireEvent.click(screen.getByText('Dashboard'));
    expect(setView).toHaveBeenCalledWith({ page: 'dashboard' });
    await flushEffects();
  });
});
