import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SessionProvider, useSession } from '../context/SessionContext.js';
import { clearMcpDrafts, getMcpDraft, mcpDraftKey, setMcpDraft } from './mcp-draft.js';

const DRAFT = { label: 'Docs server', name: 'docs-server', withPrefill: true };

describe('mcp-draft store', () => {
  beforeEach(() => clearMcpDrafts());

  it('restores a draft only for its own account and workspace', () => {
    setMcpDraft(mcpDraftKey('alice@example.com', 'default'), DRAFT);
    expect(getMcpDraft(mcpDraftKey('alice@example.com', 'default'))).toEqual(DRAFT);
    expect(getMcpDraft(mcpDraftKey('bob@example.com', 'default'))).toBeUndefined();
    expect(getMcpDraft(mcpDraftKey('alice@example.com', 'acme'))).toBeUndefined();
  });

  it('ignores a draft started for another data configuration', () => {
    const key = mcpDraftKey('', 'default');
    setMcpDraft(key, { ...DRAFT, prefillConfiguration: 'docs' });
    expect(getMcpDraft(key, 'docs')?.label).toBe('Docs server');
    expect(getMcpDraft(key)?.prefillConfiguration).toBe('docs');
    expect(getMcpDraft(key, 'sales')).toBeUndefined();
  });

  it('discards a draft with null', () => {
    const key = mcpDraftKey('', 'default');
    setMcpDraft(key, DRAFT);
    setMcpDraft(key, null);
    expect(getMcpDraft(key)).toBeUndefined();
  });
});

describe('mcp-draft and the admin session', () => {
  beforeEach(() => {
    clearMcpDrafts();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const body = url.includes('/api/auth/status')
          ? { success: true, authenticated: true, authRequired: true }
          : { success: true, authenticated: false };
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  function LogoutButton() {
    const { authenticated, logout } = useSession();
    return <button onClick={() => void logout()}>{authenticated ? 'logout' : 'signed out'}</button>;
  }

  it('wipes every draft on logout', async () => {
    render(
      <SessionProvider>
        <LogoutButton />
      </SessionProvider>,
    );
    await screen.findByText('logout');
    const key = mcpDraftKey('admin@example.com', 'default');
    setMcpDraft(key, DRAFT);

    await act(async () => {
      fireEvent.click(screen.getByText('logout'));
    });
    await screen.findByText('signed out');
    expect(getMcpDraft(key)).toBeUndefined();
  });
});
