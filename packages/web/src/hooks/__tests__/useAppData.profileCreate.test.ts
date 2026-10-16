import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAppData } from '../useAppData.js';

// Unauthenticated session: the hook's load effects stay idle, so only the
// profile CRUD callbacks are exercised.
vi.mock('../../context/SessionContext.js', () => ({
  useSession: () => ({ authenticated: false, dataVersion: 0, setShowOnboarding: vi.fn() }),
}));

describe('useAppData.handleProfileCreate', () => {
  it('adds a new MCP with the safe defaults', () => {
    const { result } = renderHook(() => useAppData(false));
    act(() => result.current.handleProfileCreate('first', 'First'));
    expect(result.current.profiles.find((p) => p.name === 'first')).toEqual({
      name: 'first',
      label: 'First',
      authMode: 'token',
      responseMode: 'friendly',
      documentWrite: { enabled: false, sources: {} },
    });
  });

  it('persists a new MCP created with a preselected data configuration', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { result } = renderHook(() => useAppData(false));
      act(() => result.current.handleProfileCreate('docs', 'Docs', ['kb']));
      expect(result.current.profiles.find((p) => p.name === 'docs')?.configurations).toEqual([
        'kb',
      ]);
      await act(async () => {});
      const save = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/profiles/save'));
      expect(save).toBeTruthy();
      expect(JSON.parse(String(save?.[1]?.body))).toMatchObject({
        profiles: { docs: { configurations: ['kb'] } },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never overwrites an existing profile with the defaults', () => {
    const { result } = renderHook(() => useAppData(false));
    act(() =>
      result.current.setProfiles([
        { name: 'default', label: 'Default', authMode: 'calame', responseMode: 'raw' },
      ]),
    );
    act(() => result.current.handleProfileCreate('default', 'Default'));
    expect(result.current.profiles).toEqual([
      { name: 'default', label: 'Default', authMode: 'calame', responseMode: 'raw' },
    ]);
    expect(result.current.activeProfileIndex).toBe(0);
  });
});
