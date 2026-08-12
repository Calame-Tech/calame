/**
 * Read-only profile lookups for the Claude Desktop integration.
 *
 * `state.serveProfiles` (see `../serve/routing.ts`) is only populated once
 * `/api/serve/start` or `/api/serve/status` has run at least once in this
 * process — a fresh boot of the packaged desktop app has an empty cache
 * even though profiles already exist in SQLite. Falling back to a direct DB
 * read means "does this profile exist" answers correctly regardless of
 * whether the Serve tab has been visited yet in this process's lifetime.
 *
 * "Active", by contrast, has no DB-backed fallback anywhere in the app —
 * `state.activeProfileNames` is a genuine runtime-only flag (see
 * `../serve/routing.ts`'s `isServeProfileActive`) — so callers still need to
 * combine this existence check with that active check.
 */

import type { AppState } from '../../state.js';
import { DEFAULT_TENANT_ID } from '../../tenancy.js';

/** List every profile name known for `tenantId`, DB-backed when the in-memory cache is cold. */
export function listProfileNamesForTenant(state: AppState, tenantId: string): string[] {
  if (tenantId === DEFAULT_TENANT_ID) {
    const cached = Object.keys(state.serveProfiles);
    if (cached.length > 0) return cached;
  }

  if (!state.db) return [];
  try {
    const row = state.db.raw
      .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
      .get(tenantId) as { data: string } | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.data) as { profiles?: Record<string, unknown> };
    return parsed.profiles && typeof parsed.profiles === 'object'
      ? Object.keys(parsed.profiles)
      : [];
  } catch {
    return [];
  }
}

/** Whether `profileName` exists for `tenantId` — DB-backed, see module docstring. */
export function profileExistsForTenant(
  state: AppState,
  tenantId: string,
  profileName: string,
): boolean {
  return listProfileNamesForTenant(state, tenantId).includes(profileName);
}
