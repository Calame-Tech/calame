// McpListPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import McpListPage from '../McpListPage.js';
import {
  makeServeStatus,
  makeConfig,
  makeProfile,
  installFetchMock,
  flushEffects,
} from './testUtils.js';

function renderPage(setView = vi.fn()) {
  render(
    <McpListPage
      setView={setView}
      configWithProfileOptions={makeConfig()}
      selectedTables={{}}
      profiles={[makeProfile()]}
      serveStatus={makeServeStatus()}
      fetchServeStatus={vi.fn(async () => {})}
      handleProfileCreate={vi.fn()}
      handleProfileDelete={vi.fn(async () => {})}
      setPreviewProfile={vi.fn()}
    />,
  );
  return setView;
}

describe('McpListPage', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the MCP servers list with the profile card', async () => {
    renderPage();
    await flushEffects();
    // Title appears in the PageHeader and in the ServePanel summary card
    expect(screen.getAllByText('MCP Servers').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Default')).toBeTruthy();
  });

  it('navigates to the MCP detail view when clicking a profile card', async () => {
    const setView = renderPage();
    await flushEffects();
    fireEvent.click(screen.getByText('Default'));
    expect(setView).toHaveBeenCalledWith({ page: 'mcp-detail', profileName: 'default' });
    await flushEffects();
  });

  it('navigates back to the dashboard via the breadcrumb', async () => {
    const setView = renderPage();
    await flushEffects();
    fireEvent.click(screen.getByText('Dashboard'));
    expect(setView).toHaveBeenCalledWith({ page: 'dashboard' });
    await flushEffects();
  });
});
