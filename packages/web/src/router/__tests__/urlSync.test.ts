// Tests for the pure hash (de)serialization helpers behind the admin app's
// URL sync (feat/ux-overhaul). See router/urlSync.ts for the design.

import { describe, it, expect } from 'vitest';
import { serializeView, parseHash } from '../urlSync.js';
import type { View } from '../view.js';

describe('serializeView', () => {
  it('serializes the dashboard as the root', () => {
    expect(serializeView({ page: 'dashboard' })).toBe('/');
  });

  it('serializes sources with an explicit tab', () => {
    expect(serializeView({ page: 'sources', tab: 'knowledge' })).toBe('/sources/knowledge');
    expect(serializeView({ page: 'sources', tab: 'databases' })).toBe('/sources/databases');
  });

  it('defaults the sources tab to databases when omitted', () => {
    expect(serializeView({ page: 'sources' })).toBe('/sources/databases');
  });

  it('serializes legacy aliases as their canonical sources URL', () => {
    expect(serializeView({ page: 'connections' })).toBe('/sources/databases');
    expect(serializeView({ page: 'knowledge' })).toBe('/sources/knowledge');
  });

  it('does not serialize ephemeral fields (backTo, editConnectionName)', () => {
    expect(
      serializeView({
        page: 'sources',
        tab: 'databases',
        backTo: { page: 'dashboard' },
        editConnectionName: 'main',
      }),
    ).toBe('/sources/databases');
    expect(serializeView({ page: 'connections', backTo: { page: 'metrics' } })).toBe(
      '/sources/databases',
    );
  });

  it('serializes configurations and config-detail', () => {
    expect(serializeView({ page: 'configurations' })).toBe('/configurations');
    expect(serializeView({ page: 'config-detail', configName: 'sales' })).toBe(
      '/configurations/sales',
    );
  });

  it('percent-encodes special characters in configName', () => {
    expect(serializeView({ page: 'config-detail', configName: 'my config' })).toBe(
      '/configurations/my%20config',
    );
    expect(serializeView({ page: 'config-detail', configName: 'a/b' })).toBe(
      '/configurations/a%2Fb',
    );
    expect(serializeView({ page: 'config-detail', configName: 'café éàü' })).toBe(
      `/configurations/${encodeURIComponent('café éàü')}`,
    );
  });

  it('serializes mcp-list and mcp-detail (with and without activeSection)', () => {
    expect(serializeView({ page: 'mcp-list' })).toBe('/mcp');
    expect(serializeView({ page: 'mcp-detail', profileName: 'default' })).toBe('/mcp/default');
    expect(
      serializeView({ page: 'mcp-detail', profileName: 'my profile', activeSection: 'general' }),
    ).toBe('/mcp/my%20profile/general');
    expect(
      serializeView({
        page: 'mcp-detail',
        profileName: 'profil éàü/x',
        activeSection: 'sécurité',
      }),
    ).toBe(`/mcp/${encodeURIComponent('profil éàü/x')}/${encodeURIComponent('sécurité')}`);
  });

  it('serializes users (with and without selectedUserId)', () => {
    expect(serializeView({ page: 'users' })).toBe('/users');
    expect(serializeView({ page: 'users', selectedUserId: 'user-1' })).toBe('/users/user-1');
    expect(serializeView({ page: 'users', selectedUserId: 'user with space/é' })).toBe(
      `/users/${encodeURIComponent('user with space/é')}`,
    );
  });

  it('serializes settings (with and without initialTab)', () => {
    expect(serializeView({ page: 'settings' })).toBe('/settings');
    expect(serializeView({ page: 'settings', initialTab: 'ai' })).toBe('/settings/ai');
    expect(serializeView({ page: 'settings', initialTab: 'email' })).toBe('/settings/email');
    expect(serializeView({ page: 'settings', initialTab: 'sso' })).toBe('/settings/sso');
  });

  it('serializes metrics and tenants', () => {
    expect(serializeView({ page: 'metrics' })).toBe('/metrics');
    expect(serializeView({ page: 'tenants' })).toBe('/workspaces');
  });

  it('serializes pending-writes and audit-log', () => {
    expect(serializeView({ page: 'pending-writes' })).toBe('/pending-writes');
    expect(serializeView({ page: 'audit-log' })).toBe('/audit-log');
  });
});

describe('parseHash', () => {
  it('falls back to dashboard for empty/garbage/unknown input', () => {
    expect(parseHash('')).toEqual({ page: 'dashboard' });
    expect(parseHash('#')).toEqual({ page: 'dashboard' });
    expect(parseHash('#garbage')).toEqual({ page: 'dashboard' });
    expect(parseHash('#/nonexistent/page')).toEqual({ page: 'dashboard' });
  });

  it('treats a trailing empty segment as malformed (falls back safely)', () => {
    expect(parseHash('#/mcp/')).toEqual({ page: 'dashboard' });
    expect(parseHash('#/configurations/')).toEqual({ page: 'dashboard' });
    expect(parseHash('#/users/')).toEqual({ page: 'dashboard' });
  });

  it('falls back safely for an unknown settings tab, without losing the page', () => {
    const result = parseHash('#/settings/invalid-tab');
    expect(result.page === 'dashboard' || result.page === 'settings').toBe(true);
    if (result.page === 'settings') {
      expect(result.initialTab).toBeUndefined();
    }
  });

  it('accepts hashes with or without a leading "#" and leading "/"', () => {
    expect(parseHash('#/mcp')).toEqual({ page: 'mcp-list' });
    expect(parseHash('/mcp')).toEqual({ page: 'mcp-list' });
    expect(parseHash('mcp')).toEqual({ page: 'mcp-list' });
  });

  it('falls back to dashboard on a malformed percent-encoding', () => {
    expect(parseHash('#/users/%E0%A4%A')).toEqual({ page: 'dashboard' });
  });

  it('normalizes /sources routes, including the bare /sources fallback', () => {
    expect(parseHash('#/sources/databases')).toEqual({ page: 'sources', tab: 'databases' });
    expect(parseHash('#/sources/knowledge')).toEqual({ page: 'sources', tab: 'knowledge' });
    expect(parseHash('#/sources')).toEqual({ page: 'sources', tab: 'databases' });
  });

  it('normalizes /workspaces to the tenants page', () => {
    expect(parseHash('#/workspaces')).toEqual({ page: 'tenants' });
  });

  it('parses /pending-writes and /audit-log', () => {
    expect(parseHash('#/pending-writes')).toEqual({ page: 'pending-writes' });
    expect(parseHash('#/audit-log')).toEqual({ page: 'audit-log' });
  });
});

describe('round-trip: parseHash(serializeView(v)) for every View variant', () => {
  const cases: Array<{ name: string; view: View; expected: View }> = [
    { name: 'dashboard', view: { page: 'dashboard' }, expected: { page: 'dashboard' } },
    {
      name: 'sources (no tab -> defaults to databases)',
      view: { page: 'sources' },
      expected: { page: 'sources', tab: 'databases' },
    },
    {
      name: 'sources/databases',
      view: { page: 'sources', tab: 'databases' },
      expected: { page: 'sources', tab: 'databases' },
    },
    {
      name: 'sources/knowledge',
      view: { page: 'sources', tab: 'knowledge' },
      expected: { page: 'sources', tab: 'knowledge' },
    },
    {
      name: 'sources with ephemeral fields (dropped by round-trip)',
      view: { page: 'sources', tab: 'knowledge', backTo: { page: 'dashboard' } },
      expected: { page: 'sources', tab: 'knowledge' },
    },
    {
      name: 'connections (legacy alias -> normalizes to sources/databases)',
      view: { page: 'connections' },
      expected: { page: 'sources', tab: 'databases' },
    },
    {
      name: 'knowledge (legacy alias -> normalizes to sources/knowledge)',
      view: { page: 'knowledge' },
      expected: { page: 'sources', tab: 'knowledge' },
    },
    {
      name: 'configurations',
      view: { page: 'configurations' },
      expected: { page: 'configurations' },
    },
    {
      name: 'config-detail (plain name)',
      view: { page: 'config-detail', configName: 'sales' },
      expected: { page: 'config-detail', configName: 'sales' },
    },
    {
      name: 'config-detail (spaces)',
      view: { page: 'config-detail', configName: 'my config with spaces' },
      expected: { page: 'config-detail', configName: 'my config with spaces' },
    },
    {
      name: 'config-detail (embedded slash)',
      view: { page: 'config-detail', configName: 'a/b/c' },
      expected: { page: 'config-detail', configName: 'a/b/c' },
    },
    {
      name: 'config-detail (accents)',
      view: { page: 'config-detail', configName: 'café éàü configuration' },
      expected: { page: 'config-detail', configName: 'café éàü configuration' },
    },
    { name: 'mcp-list', view: { page: 'mcp-list' }, expected: { page: 'mcp-list' } },
    {
      name: 'mcp-detail (no section)',
      view: { page: 'mcp-detail', profileName: 'default' },
      expected: { page: 'mcp-detail', profileName: 'default' },
    },
    {
      name: 'mcp-detail (with section, spaces)',
      view: { page: 'mcp-detail', profileName: 'my profile', activeSection: 'general settings' },
      expected: {
        page: 'mcp-detail',
        profileName: 'my profile',
        activeSection: 'general settings',
      },
    },
    {
      name: 'mcp-detail (slash + accents in both segments)',
      view: {
        page: 'mcp-detail',
        profileName: 'profil éàü/x',
        activeSection: 'sécurité/accès',
      },
      expected: {
        page: 'mcp-detail',
        profileName: 'profil éàü/x',
        activeSection: 'sécurité/accès',
      },
    },
    { name: 'users', view: { page: 'users' }, expected: { page: 'users' } },
    {
      name: 'users (selectedUserId)',
      view: { page: 'users', selectedUserId: 'user-1' },
      expected: { page: 'users', selectedUserId: 'user-1' },
    },
    {
      name: 'users (selectedUserId with space + slash + accent)',
      view: { page: 'users', selectedUserId: 'user with space/é' },
      expected: { page: 'users', selectedUserId: 'user with space/é' },
    },
    { name: 'settings', view: { page: 'settings' }, expected: { page: 'settings' } },
    {
      name: 'settings (initialTab: ai)',
      view: { page: 'settings', initialTab: 'ai' },
      expected: { page: 'settings', initialTab: 'ai' },
    },
    {
      name: 'settings (initialTab: email)',
      view: { page: 'settings', initialTab: 'email' },
      expected: { page: 'settings', initialTab: 'email' },
    },
    {
      name: 'settings (initialTab: sso)',
      view: { page: 'settings', initialTab: 'sso' },
      expected: { page: 'settings', initialTab: 'sso' },
    },
    { name: 'metrics', view: { page: 'metrics' }, expected: { page: 'metrics' } },
    { name: 'tenants', view: { page: 'tenants' }, expected: { page: 'tenants' } },
    {
      name: 'pending-writes',
      view: { page: 'pending-writes' },
      expected: { page: 'pending-writes' },
    },
    { name: 'audit-log', view: { page: 'audit-log' }, expected: { page: 'audit-log' } },
  ];

  for (const { name, view, expected } of cases) {
    it(`round-trips: ${name}`, () => {
      const hash = serializeView(view);
      expect(parseHash(hash)).toEqual(expected);
      // Also round-trips with a leading '#', as it comes from window.location.hash.
      expect(parseHash(`#${hash}`)).toEqual(expected);
    });
  }
});
