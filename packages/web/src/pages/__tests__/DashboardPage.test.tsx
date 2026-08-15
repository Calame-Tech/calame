// DashboardPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DashboardPage from '../DashboardPage.js';
import { useSession } from '../../context/SessionContext.js';
import { makeSession, makeServeStatus, makeProfile, installFetchMock } from './testUtils.js';
import type { AuditLogEntry, Configuration, NamedConnection } from '../../types/schema.js';

vi.mock('../../context/SessionContext.js', () => ({
  useSession: vi.fn(),
}));

const configurations: Configuration[] = [{ name: 'sales', label: 'Sales' }];
const connections: NamedConnection[] = [
  {
    name: 'main',
    label: 'Main DB',
    databaseType: 'postgresql',
    connectionString: 'postgres://localhost/db',
  },
];
const recentActivity: AuditLogEntry[] = [
  {
    id: 'a1',
    timestamp: new Date().toISOString(),
    profileName: 'default',
    toolName: 'query_users',
    toolArgs: {},
    result: 'success',
    durationMs: 12,
  },
];

function renderPage(setView = vi.fn(), pendingWriteCount = 0) {
  render(
    <DashboardPage
      setView={setView}
      profiles={[makeProfile()]}
      configurations={configurations}
      connections={connections}
      connectionSchemas={{}}
      serveStatus={makeServeStatus()}
      recentActivity={recentActivity}
      activeMcpCount={0}
      totalMcpCount={1}
      connectedCount={0}
      pendingWriteCount={pendingWriteCount}
    />,
  );
  return setView;
}

describe('DashboardPage', () => {
  beforeEach(() => {
    installFetchMock();
    vi.mocked(useSession).mockReturnValue(makeSession());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the dashboard overview with pipeline stages and recent activity', () => {
    renderPage();
    expect(screen.getByText('Dashboard')).toBeTruthy();
    // Pipeline stage labels (Sources → Data Configurations → MCP Servers)
    expect(screen.getByText('MCP SERVERS')).toBeTruthy();
    expect(screen.getByText('DATA CONFIGURATIONS')).toBeTruthy();
    expect(screen.getByText('SOURCES')).toBeTruthy();
    expect(screen.getByText('Recent activity')).toBeTruthy();
    expect(screen.getByText('query_users')).toBeTruthy();
    // Profile and configuration entries from the pipeline stage footers
    expect(screen.getByText('Sales')).toBeTruthy();
    expect(screen.getByText('Main DB')).toBeTruthy();
  });

  it('navigates per item from the pipeline stage footers', () => {
    const setView = renderPage();
    // Server item → mcp-detail (label also appears in the bars/servers table,
    // the first occurrence is the pipeline stage footer)
    fireEvent.click(screen.getAllByText('Default')[0]);
    expect(setView).toHaveBeenCalledWith({ page: 'mcp-detail', profileName: 'default' });
    // Configuration item → config-detail
    fireEvent.click(screen.getByText('Sales'));
    expect(setView).toHaveBeenCalledWith({ page: 'config-detail', configName: 'sales' });
  });

  it('navigates to the MCP list when clicking "New MCP server"', () => {
    const setView = renderPage();
    fireEvent.click(screen.getByText('New MCP server'));
    expect(setView).toHaveBeenCalledWith({ page: 'mcp-list' });
  });

  it('opens the onboarding wizard when clicking "Get started"', () => {
    const session = makeSession();
    vi.mocked(useSession).mockReturnValue(session);
    renderPage();
    fireEvent.click(screen.getByText('Get started'));
    expect(session.setShowOnboarding).toHaveBeenCalledWith(true);
  });

  it('navigates to the users page from the governance tile', () => {
    const setView = renderPage();
    fireEvent.click(screen.getByText('USERS'));
    expect(setView).toHaveBeenCalledWith({ page: 'users' });
  });

  it('shows the pending approvals banner when pendingWriteCount > 0 and navigates on click', () => {
    const setView = renderPage(vi.fn(), 3);
    expect(screen.getByText('3 write requests awaiting your approval')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));
    expect(setView).toHaveBeenCalledWith({ page: 'pending-writes' });
  });

  it('hides the pending approvals banner when pendingWriteCount is 0', () => {
    renderPage(vi.fn(), 0);
    expect(screen.queryByText(/awaiting your approval/)).toBeNull();
  });
});
