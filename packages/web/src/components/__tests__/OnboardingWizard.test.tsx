// OnboardingWizard component tests (Lot D1).
//
// Focus: the wizard must create a real Data Configuration (POST
// /api/configurations) *before* saving the profile (POST /api/profiles/save)
// referencing it by name. This is what makes a profile created through
// onboarding show up under "Data Profiles" and gives the user a UI path to
// enable the write tool / column masking afterwards (TableOptionsCard only
// mounts on the configuration detail page). A regression here would silently
// go back to posting inline sources/scopes on /api/profiles/save, producing
// an orphaned profile with no backing configuration.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OnboardingWizard from '../OnboardingWizard.js';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

interface Call {
  method: string;
  url: string;
  body: string | undefined;
}

/** Stubs fetch for a full happy-path wizard run and records call order. */
function installFetchMock(): Call[] {
  const calls: Call[] = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body as string | undefined });

    if (url.includes('/api/connections/demo')) {
      return jsonResponse({ success: true, name: 'demo-logistique' });
    }
    if (url.includes('/api/schema/')) {
      return jsonResponse({
        success: true,
        schema: {
          tables: [{ name: 'orders', columns: [{ name: 'id' }, { name: 'total' }] }],
        },
      });
    }
    if (url.includes('/api/configurations')) {
      return jsonResponse({
        success: true,
        name: 'my-first-mcp-server-config',
        overwritten: false,
      });
    }
    if (url.includes('/api/profiles/save')) {
      return jsonResponse({ success: true });
    }
    if (url.includes('/api/serve/start')) {
      return jsonResponse({ success: true });
    }
    return jsonResponse({ success: true });
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

/** Drives the wizard from step 1 through the profile-creation submit. */
async function runToSubmit(): Promise<void> {
  fireEvent.click(screen.getByText('Use demo database (SQLite)'));
  await waitFor(() => expect(screen.getByText(/tables selected/)).toBeTruthy());
  fireEvent.click(screen.getByText('Continue'));
  fireEvent.click(screen.getByText('Create MCP server & activate'));
}

describe('OnboardingWizard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs /api/configurations before /api/profiles/save and lands on step 4', async () => {
    const calls = installFetchMock();
    render(<OnboardingWizard onComplete={vi.fn()} onSkip={vi.fn()} />);

    await runToSubmit();
    await waitFor(() => expect(screen.getByText("You're all set!")).toBeTruthy());

    const configIndex = calls.findIndex(
      (c) => c.method === 'POST' && c.url.includes('/api/configurations'),
    );
    const profileIndex = calls.findIndex(
      (c) => c.method === 'POST' && c.url.includes('/api/profiles/save'),
    );
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(profileIndex).toBeGreaterThan(configIndex);

    // The profile save references the configuration by name (modern shape) —
    // no inline sources/scopes duplicated onto the profile.
    const profileBody = JSON.parse(calls[profileIndex].body ?? '{}');
    const savedProfile = profileBody.profiles['my-first-mcp-server'];
    expect(savedProfile.configurations).toEqual(['my-first-mcp-server-config']);
    expect(savedProfile.sources).toBeUndefined();
    expect(savedProfile.scopes).toBeUndefined();

    // The configuration itself carries the real sources/scopes.
    const configBody = JSON.parse(calls[configIndex].body ?? '{}');
    expect(configBody.name).toBe('my-first-mcp-server-config');
    expect(configBody.sources).toEqual(['demo-logistique']);
  });

  it('does not save the profile when configuration creation fails', async () => {
    const mock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('/api/connections/demo')) {
        return jsonResponse({ success: true, name: 'demo-logistique' });
      }
      if (url.includes('/api/schema/')) {
        return jsonResponse({
          success: true,
          schema: { tables: [{ name: 'orders', columns: [{ name: 'id' }] }] },
        });
      }
      if (url.includes('/api/configurations')) {
        return jsonResponse({ success: false, message: 'boom' });
      }
      return jsonResponse({ success: true });
    });
    vi.stubGlobal('fetch', mock);

    render(<OnboardingWizard onComplete={vi.fn()} onSkip={vi.fn()} />);
    await runToSubmit();

    expect(await screen.findByText('boom')).toBeTruthy();
    const calledProfilesSave = mock.mock.calls.some(([input]) =>
      requestUrl(input as string | URL | Request).includes('/api/profiles/save'),
    );
    expect(calledProfilesSave).toBe(false);
  });

  it('links to the created configuration and calls onNavigateToConfig with its name', async () => {
    installFetchMock();
    const onNavigateToConfig = vi.fn();
    render(
      <OnboardingWizard
        onComplete={vi.fn()}
        onSkip={vi.fn()}
        onNavigateToConfig={onNavigateToConfig}
      />,
    );

    await runToSubmit();
    await waitFor(() => expect(screen.getByText("You're all set!")).toBeTruthy());

    fireEvent.click(screen.getByText(/Fine-tune tables, tools/));
    expect(onNavigateToConfig).toHaveBeenCalledWith('my-first-mcp-server-config');
  });

  it('omits the fine-tune link when onNavigateToConfig is not provided', async () => {
    installFetchMock();
    render(<OnboardingWizard onComplete={vi.fn()} onSkip={vi.fn()} />);

    await runToSubmit();
    await waitFor(() => expect(screen.getByText("You're all set!")).toBeTruthy());

    expect(screen.queryByText(/Fine-tune tables, tools/)).toBeNull();
  });
});
