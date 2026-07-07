/**
 * View-based navigation model. A discriminated union over the admin app's
 * top-level pages, replacing the old step wizard. Extracted from `App.tsx`
 * (Phase 3 #13) so the navigation state machine lives outside the god
 * component. Several variants carry a `backTo?: View` so a nested page can
 * return to wherever it was opened from.
 */
export type View =
  | { page: 'dashboard' }
  /**
   * Unified sources page — databases and knowledge bases in one place.
   * `tab` defaults to 'databases' when omitted.
   */
  | { page: 'sources'; tab?: 'databases' | 'knowledge'; backTo?: View; editConnectionName?: string }
  /**
   * Legacy alias for `{ page: 'sources', tab: 'databases' }`.
   * Kept for backwards-compat (existing navigation calls, deep links).
   */
  | { page: 'connections'; backTo?: View; editConnectionName?: string }
  | { page: 'configurations' }
  | { page: 'config-detail'; configName: string; backTo?: View }
  | { page: 'mcp-list' }
  | { page: 'mcp-detail'; profileName: string; activeSection?: string }
  | { page: 'users'; selectedUserId?: string; backTo?: View }
  | { page: 'settings'; backTo?: View; initialTab?: 'ai' | 'email' | 'sso' }
  | { page: 'metrics' }
  /**
   * Tenant administration page — lists every distinct tenant id discovered
   * across tenanted tables and lets the admin hard-delete one.
   */
  | { page: 'tenants' }
  /**
   * Legacy alias for `{ page: 'sources', tab: 'knowledge' }`.
   * Kept for backwards-compat.
   */
  | { page: 'knowledge' }
  /**
   * Write-approval queue — top-level governance page (Lot C). Promoted out
   * of the ServePanel "Pending" tab so the approval loop has a real, linkable
   * entry point (sidebar nav item + badge, notification bell, dashboard tile).
   */
  | { page: 'pending-writes' }
  /** Full audit log of every tool call served by the MCP servers. */
  | { page: 'audit-log' };

/** The set of top-level page identifiers (the `page` discriminant of {@link View}). */
export type Page = View['page'];
