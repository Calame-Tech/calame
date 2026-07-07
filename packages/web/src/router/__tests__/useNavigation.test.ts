// Tests for the URL-synced navigation hook (feat/ux-overhaul). Verifies:
// (a) init from a pre-existing hash, (b) setView pushes the hash, (c) a
// hashchange event (Back/Forward, manual edit, links) updates the view, and
// (d) a no-op hash change (only an ephemeral field differs) doesn't rewrite
// the hash. Also covers listener cleanup and React 18 StrictMode
// double-mounting.
//
// Kept as a plain .ts file (no JSX) per the router module's test-file
// naming; the one test needing a StrictMode wrapper uses
// `React.createElement` instead of JSX.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useNavigation } from '../useNavigation.js';

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  window.location.hash = '';
});

describe('useNavigation', () => {
  it('initializes from an empty hash as the dashboard', () => {
    const { result } = renderHook(() => useNavigation());
    expect(result.current.view).toEqual({ page: 'dashboard' });
  });

  it('initializes from a pre-existing location.hash (deep link)', () => {
    window.location.hash = '#/mcp/foo';
    const { result } = renderHook(() => useNavigation());
    expect(result.current.view).toEqual({ page: 'mcp-detail', profileName: 'foo' });
  });

  it('setView updates both the view and location.hash', () => {
    const { result } = renderHook(() => useNavigation());

    act(() => {
      result.current.setView({ page: 'metrics' });
    });

    expect(result.current.view).toEqual({ page: 'metrics' });
    expect(window.location.hash).toBe('#/metrics');
  });

  it('setView with a functional updater is applied and reflected in the hash', () => {
    const { result } = renderHook(() => useNavigation({ page: 'mcp-detail', profileName: 'a' }));

    act(() => {
      result.current.setView((prev) =>
        prev.page === 'mcp-detail' ? { ...prev, activeSection: 'general' } : prev,
      );
    });

    expect(result.current.view).toEqual({
      page: 'mcp-detail',
      profileName: 'a',
      activeSection: 'general',
    });
    expect(window.location.hash).toBe('#/mcp/a/general');
  });

  it('updates the view when a hashchange event fires (Back/Forward, manual address bar edit)', () => {
    const { result } = renderHook(() => useNavigation());

    act(() => {
      window.location.hash = '#/users/42';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(result.current.view).toEqual({ page: 'users', selectedUserId: '42' });
  });

  it('falls back to the dashboard when hashchange fires with a malformed hash', () => {
    const { result } = renderHook(() => useNavigation());

    act(() => {
      result.current.setView({ page: 'metrics' });
    });

    act(() => {
      window.location.hash = '#garbage';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(result.current.view).toEqual({ page: 'dashboard' });
  });

  it('does not rewrite location.hash when only an ephemeral field (backTo) changes', () => {
    const { result } = renderHook(() => useNavigation({ page: 'sources', tab: 'knowledge' }));

    act(() => {
      result.current.setView({ page: 'sources', tab: 'knowledge' });
    });
    const hashAfterFirstSet = window.location.hash;

    act(() => {
      result.current.setView({
        page: 'sources',
        tab: 'knowledge',
        backTo: { page: 'dashboard' },
      });
    });

    // State updates (backTo is now set)...
    expect(result.current.view).toEqual({
      page: 'sources',
      tab: 'knowledge',
      backTo: { page: 'dashboard' },
    });
    // ...but the hash itself, which never encodes backTo, is unchanged —
    // no duplicate history entry was pushed.
    expect(window.location.hash).toBe(hashAfterFirstSet);
  });

  it('removes the hashchange listener on unmount', () => {
    const { unmount } = renderHook(() => useNavigation());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    unmount();
    act(() => {
      window.location.hash = '#/metrics';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    // No "state update on an unmounted component" warning: the listener was
    // properly detached.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('behaves correctly under React StrictMode double-mounting', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.StrictMode, null, children);

    const { result } = renderHook(() => useNavigation(), { wrapper });

    act(() => {
      result.current.setView({ page: 'metrics' });
    });
    expect(window.location.hash).toBe('#/metrics');

    // Exactly one active listener: a single hashchange updates the view once,
    // to the expected value (a leaked duplicate listener would still produce
    // the same single state, so we also check no console.error was logged).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      window.location.hash = '#/users/7';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(result.current.view).toEqual({ page: 'users', selectedUserId: '7' });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
