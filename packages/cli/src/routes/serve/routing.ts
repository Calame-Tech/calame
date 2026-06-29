import type { AppState } from '../../state.js';
import type { ColumnMasking } from '@calame/core';
import { upgradeProfileShape } from '@calame/core';
import type { ServeProfile } from '@calame/core';
import { DEFAULT_TENANT_ID } from '../../tenancy.js';

/**
 * Tenant id alphabet — kept in sync with `TENANT_ID_RE` in tenancy.ts.
 * Letters, digits, underscore, hyphen; 1 to 64 chars.
 *
 * Defined locally because the MCP routes need to reject malformed tenant
 * segments with a 400 — `getTenantId` cannot do this because it falls back
 * silently to `'default'` for forward compatibility.
 */
const MCP_TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Resolve the (tenantId, profileName) pair for an MCP URL.
 *
 * Two URL formats are supported:
 *   - `/mcp/<profileName>`              — legacy, implicitly tenant='default'
 *   - `/mcp/<tenantId>/<profileName>`   — tenant-qualified
 *
 * Ambiguity policy: a single segment is ALWAYS interpreted as legacy
 * (tenant=default, profile=<seg>). An admin who wants to target a non-default
 * tenant MUST include the profile name as a second segment — there is no
 * heuristic that promotes a single segment to a tenant id, even when that
 * segment happens to match a known tenant.
 *
 * Returns `null` when the first segment looks like a tenant-qualified URL but
 * the tenant id fails the alphabet check — the route handler turns this into
 * a 400.
 */
export function resolveMcpRoute(
  firstSeg: string,
  secondSeg: string | undefined,
): { tenantId: string; profileName: string } | { error: 'invalid_tenant_id' } {
  if (secondSeg) {
    // Tenant-qualified form: validate the tenant alphabet.
    if (!MCP_TENANT_ID_RE.test(firstSeg)) {
      return { error: 'invalid_tenant_id' };
    }
    return { tenantId: firstSeg, profileName: secondSeg };
  }
  // Legacy form: always the default tenant.
  return { tenantId: DEFAULT_TENANT_ID, profileName: firstSeg };
}

/**
 * Load a single `ServeProfile` from the DB for the supplied tenant.
 * Returns `null` when no `profiles` row exists for that tenant, or when the
 * row exists but does not carry a profile with the requested name.
 *
 * For backward compat the AppState in-memory cache (`state.serveProfiles`)
 * is preferred for the default tenant — that path keeps the existing fast
 * path unchanged and ensures the legacy URL `/mcp/<profile>` continues to
 * behave exactly as before Phase B introduced multi-tenancy.
 */
export function loadServeProfileForTenant(
  state: AppState,
  tenantId: string,
  profileName: string,
): ServeProfile | null {
  // Fast path: default tenant uses the in-memory cache populated by
  // `serve/start` and `serve/refresh`. This preserves all current behaviour
  // (including the "active" check based on `state.activeProfileNames`).
  if (tenantId === DEFAULT_TENANT_ID) {
    return state.serveProfiles[profileName] ?? null;
  }

  // Non-default tenant: load fresh from the DB. The `profiles` row holds
  // every profile for that tenant in a single JSON blob.
  if (!state.db) return null;
  try {
    const row = state.db.raw
      .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
      .get(tenantId) as { data: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.data) as { profiles?: Record<string, unknown> };
    const raw = parsed.profiles?.[profileName];
    if (!raw || typeof raw !== 'object') return null;
    return upgradeProfileShape({ ...(raw as Record<string, unknown>), name: profileName });
  } catch {
    return null;
  }
}

/**
 * Returns `true` when the (tenantId, profileName) pair is currently active.
 *
 * For the default tenant we honour the in-memory `state.activeProfileNames`
 * set (the current single-tenant behaviour). For non-default tenants we
 * treat every profile that exists in the DB as implicitly active — there is
 * no per-tenant activation toggle today, and the alternative would be to
 * silently refuse every cross-tenant MCP request.
 */
export function isServeProfileActive(
  state: AppState,
  tenantId: string,
  profileName: string,
): boolean {
  if (tenantId === DEFAULT_TENANT_ID) {
    return state.activeProfileNames.has(profileName);
  }
  // Non-default tenants: existence in the DB implies active.
  return true;
}

// Distinct-values cache. Keyed by `profile|connection|selectedTables-hash|masking-hash`.
// Built lazily on first MCP request per (profile, config) tuple; reused across
// requests so we don't run ~50 SELECT DISTINCT queries on every tools/list call.
// Flushed when the user reconfigures (the cache key encodes the relevant inputs).
export const distinctValuesCache = new Map<string, Record<string, Record<string, unknown[]>>>();

export function distinctValuesCacheKey(
  profileName: string,
  connectionString: string,
  selectedTables: Record<string, string[]>,
  columnMasking: Record<string, Record<string, ColumnMasking>> | undefined,
): string {
  // Stable JSON: sort keys at the top level.
  const stTable = Object.keys(selectedTables).sort()
    .map((k) => `${k}:${[...selectedTables[k]].sort().join(',')}`)
    .join(';');
  const cmTable = columnMasking
    ? Object.keys(columnMasking).sort()
        .map((k) => `${k}:${JSON.stringify(columnMasking[k])}`)
        .join(';')
    : '';
  return `${profileName}|${connectionString}|${stTable}|${cmTable}`;
}

/** Read the global query timeout from environment (default 10000ms). */
export function getQueryTimeoutMs(): number {
  return parseInt(process.env.CALAME_QUERY_TIMEOUT_MS ?? '10000', 10) || 10000;
}
