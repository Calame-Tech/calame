/**
 * Pure, testable helpers for the admin app's hash-based deep linking.
 * `serializeView` maps a `View` to a canonical hash path (no leading '#');
 * `parseHash` is its inverse. Used both to resolve the initial view from
 * `window.location.hash` and to react to `hashchange` (see useNavigation.ts).
 *
 * Legacy aliases (`connections` -> sources/databases, `knowledge` ->
 * sources/knowledge) serialize to the same URL as their canonical `sources`
 * counterpart; `parseHash` never reconstructs the alias, only the canonical
 * `sources` variant — round-tripping an alias view normalizes it away.
 *
 * Ephemeral fields (`backTo`, `editConnectionName`) are never serialized:
 * they only make sense as in-memory navigation context (e.g. "where do I
 * return to"), not as shareable/durable URL state.
 */
import type { View } from './view.js';

const SETTINGS_TABS = new Set(['ai', 'email', 'sso']);

/** Serialize a `View` to a hash path, without the leading '#'. */
export function serializeView(view: View): string {
  switch (view.page) {
    case 'dashboard':
      return '/';
    case 'sources':
      return `/sources/${view.tab ?? 'databases'}`;
    case 'connections':
      // Legacy alias for { page: 'sources', tab: 'databases' }.
      return '/sources/databases';
    case 'knowledge':
      // Legacy alias for { page: 'sources', tab: 'knowledge' }.
      return '/sources/knowledge';
    case 'configurations':
      return '/configurations';
    case 'config-detail':
      return `/configurations/${encodeURIComponent(view.configName)}`;
    case 'mcp-list':
      return '/mcp';
    case 'mcp-detail': {
      const base = `/mcp/${encodeURIComponent(view.profileName)}`;
      return view.activeSection ? `${base}/${encodeURIComponent(view.activeSection)}` : base;
    }
    case 'users':
      return view.selectedUserId ? `/users/${encodeURIComponent(view.selectedUserId)}` : '/users';
    case 'settings':
      return view.initialTab ? `/settings/${view.initialTab}` : '/settings';
    case 'metrics':
      return '/metrics';
    case 'tenants':
      return '/workspaces';
    default: {
      // Exhaustiveness guard: a compile error here means a `View` variant
      // was added without a matching serialize case.
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

/** Fallback for any hash we don't recognize or can't safely parse. */
const DASHBOARD: View = { page: 'dashboard' };

/**
 * Parse a hash into a `View`. Accepts the hash with or without a leading '#'
 * and with or without a leading '/'; segments are individually
 * `decodeURIComponent`-d. Any unrecognized or malformed input falls back to
 * the dashboard — except where a safe partial fallback exists (e.g. an
 * unknown `/settings/:tab` still resolves to the settings page, just
 * without the invalid tab).
 */
export function parseHash(hash: string): View {
  let h = hash;
  if (h.startsWith('#')) h = h.slice(1);
  if (h.startsWith('/')) h = h.slice(1);
  if (h === '') return DASHBOARD;

  let segments: string[];
  try {
    // Split before decoding: an encoded '/' (%2F) inside a name must stay
    // part of a single segment rather than being treated as a separator.
    segments = h.split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return DASHBOARD;
  }

  const [head, ...rest] = segments;

  switch (head) {
    case 'sources': {
      if (rest.length > 1) return DASHBOARD;
      const [tab] = rest;
      if (tab === undefined || tab === 'databases') return { page: 'sources', tab: 'databases' };
      if (tab === 'knowledge') return { page: 'sources', tab: 'knowledge' };
      return DASHBOARD;
    }
    case 'configurations': {
      if (rest.length === 0) return { page: 'configurations' };
      if (rest.length === 1 && rest[0] !== '')
        return { page: 'config-detail', configName: rest[0] };
      return DASHBOARD;
    }
    case 'mcp': {
      if (rest.length === 0) return { page: 'mcp-list' };
      if (rest.length === 1 && rest[0] !== '') return { page: 'mcp-detail', profileName: rest[0] };
      if (rest.length === 2 && rest[0] !== '' && rest[1] !== '') {
        return { page: 'mcp-detail', profileName: rest[0], activeSection: rest[1] };
      }
      return DASHBOARD;
    }
    case 'users': {
      if (rest.length === 0) return { page: 'users' };
      if (rest.length === 1 && rest[0] !== '') return { page: 'users', selectedUserId: rest[0] };
      return DASHBOARD;
    }
    case 'settings': {
      if (rest.length === 0) return { page: 'settings' };
      if (rest.length === 1) {
        const tab = rest[0];
        return SETTINGS_TABS.has(tab)
          ? { page: 'settings', initialTab: tab as 'ai' | 'email' | 'sso' }
          : { page: 'settings' };
      }
      return DASHBOARD;
    }
    case 'metrics':
      return rest.length === 0 ? { page: 'metrics' } : DASHBOARD;
    case 'workspaces':
      return rest.length === 0 ? { page: 'tenants' } : DASHBOARD;
    default:
      return DASHBOARD;
  }
}
