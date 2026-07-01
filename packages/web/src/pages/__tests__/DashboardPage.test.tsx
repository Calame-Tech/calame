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

function renderPage(setView = vi.fn()) {
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
      hasActiveMcp={false}
      connectedCount={0}
      totalConnCount={1}
      hasConnections={true}
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

  it('renders the dashboard overview with KPI sections and recent activity', () => {
    renderPage();
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(screen.getByText('MCP SERVERS')).toBeTruthy();
    expect(screen.getByText('DATA PROFILES')).toBeTruthy();
    expect(screen.getByText('DATABASES')).toBeTruthy();
    expect(screen.getByText('RECENT ACTIVITY')).toBeTruthy();
    expect(screen.getByText('query_users')).toBeTruthy();
    // Profile and configuration entries from the KPI card footers
    expect(screen.getByText('Sales')).toBeTruthy();
    expect(screen.getByText('Main DB')).toBeTruthy();
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
});
