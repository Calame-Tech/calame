// SettingsPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SettingsPage from '../SettingsPage.js';
import { installFetchMock, flushEffects } from './testUtils.js';

// The SSO tab lazily imports OidcSettings from the EE package — mock the
// module so the license boundary is never crossed.
vi.mock('@calame-ee/sso/web', () => ({
  OidcSettings: () => <div>OIDC settings (mock)</div>,
  ProfileSsoNotice: () => <></>,
  DataScopingSection: () => <div>Scoping (mock)</div>,
}));

function renderPage({
  initialTab,
  onNavigateDashboard = vi.fn(),
}: {
  initialTab?: 'ai' | 'email' | 'sso';
  onNavigateDashboard?: () => void;
} = {}) {
  render(
    <SettingsPage
      allProfileNames={['default']}
      onNavigateDashboard={onNavigateDashboard}
      initialTab={initialTab}
    />,
  );
  return { onNavigateDashboard };
}

describe('SettingsPage', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the settings tabs with AI Provider active by default', async () => {
    renderPage();
    expect(screen.getAllByText('Settings').length).toBeGreaterThanOrEqual(1);
    // Tabs are rendered twice (mobile bar + desktop sidebar)
    const aiTabs = screen.getAllByRole('button', { name: /AI Provider/ });
    expect(aiTabs.length).toBeGreaterThanOrEqual(2);
    expect(aiTabs.some((b) => b.getAttribute('aria-current') === 'page')).toBe(true);
    await flushEffects();
  });

  it('switches to the Email (SMTP) tab on click', async () => {
    renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: /Email \(SMTP\)/ })[0]);
    await flushEffects();
    const emailTabs = screen.getAllByRole('button', { name: /Email \(SMTP\)/ });
    expect(emailTabs.every((b) => b.getAttribute('aria-current') === 'page')).toBe(true);
    const aiTabs = screen.getAllByRole('button', { name: /AI Provider/ });
    expect(aiTabs.every((b) => b.getAttribute('aria-current') === null)).toBe(true);
  });

  it('renders the lazy (mocked) OidcSettings when opened on the SSO tab', async () => {
    renderPage({ initialTab: 'sso' });
    const oidc = await screen.findAllByText('OIDC settings (mock)');
    expect(oidc.length).toBeGreaterThanOrEqual(1);
    await flushEffects();
  });
});
