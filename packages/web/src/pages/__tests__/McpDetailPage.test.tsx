// McpDetailPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import McpDetailPage from '../McpDetailPage.js';
import {
  makeServeStatus,
  makeConfig,
  makeProfile,
  installFetchMock,
  flushEffects,
} from './testUtils.js';

// The page lazily imports ProfileSsoNotice / DataScopingSection from the EE
// SSO package — mock the module so the license boundary is never crossed.
vi.mock('@calame-ee/sso/web', () => ({
  ProfileSsoNotice: () => <></>,
  DataScopingSection: () => <div>Scoping (mock)</div>,
  OidcSettings: () => <div>OIDC settings (mock)</div>,
}));

function renderPage({ profileName = 'default', setView = vi.fn() } = {}) {
  render(
    <McpDetailPage
      view={{ page: 'mcp-detail', profileName }}
      setView={setView}
      profiles={[makeProfile()]}
      setProfiles={vi.fn()}
      serveStatus={makeServeStatus()}
      configWithProfileOptions={makeConfig()}
      configurations={[]}
      setConfigurations={vi.fn()}
      activeProfileIndex={0}
      setActiveProfileIndex={vi.fn()}
      handleProfileDelete={vi.fn(async () => {})}
      handleConfigurationSave={vi.fn(async () => true)}
    />,
  );
  return setView;
}

describe('McpDetailPage', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the profile detail with its section tabs', async () => {
    renderPage();
    // Label appears in the breadcrumb and the heading
    expect(screen.getAllByText('Default').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Exposed Data')).toBeTruthy();
    expect(screen.getByText('API Keys')).toBeTruthy();
    expect(screen.getByText('Audit Log')).toBeTruthy();
    await flushEffects();
  });

  it('shows a not-found message for an unknown profile', async () => {
    renderPage({ profileName: 'ghost' });
    expect(screen.getByText('Profile "ghost" not found.')).toBeTruthy();
    await flushEffects();
  });

  it('navigates back to the MCP list via the breadcrumb', async () => {
    const setView = renderPage();
    fireEvent.click(screen.getByText('MCP Servers'));
    expect(setView).toHaveBeenCalledWith({ page: 'mcp-list' });
    await flushEffects();
  });
});
