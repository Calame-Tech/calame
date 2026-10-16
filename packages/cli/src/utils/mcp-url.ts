/**
 * Helpers for building MCP endpoint URLs in a tenant-aware way.
 *
 * The MCP serve route supports two URL formats:
 *
 *   1. `/mcp/<profileName>`                    — legacy / default tenant
 *   2. `/mcp/<tenantId>/<profileName>`         — tenant-qualified
 *
 * The legacy form is implicitly bound to the `'default'` tenant so existing
 * Claude Desktop / MCP-client configurations keep working unchanged. The new
 * form lets an admin issue a per-tenant URL to external clients that cannot
 * inject the `X-Tenant-Id` header.
 *
 * Ambiguity policy: a single-segment URL is ALWAYS interpreted as legacy
 * (tenant=default, profile=<seg>). If an admin wants to target a non-default
 * tenant they MUST include the profile name as a second segment. There is no
 * heuristic that promotes a single segment to a tenant id.
 */

import { DEFAULT_TENANT_ID } from '../tenancy.js';

/**
 * Build the MCP endpoint path for a (tenant, profile) pair.
 * Returns the legacy form when the tenant is the implicit default so the URLs
 * surfaced to users stay short whenever possible.
 *
 * @param profileName The profile name (will be URL-encoded).
 * @param tenantId    Tenant id; defaults to `DEFAULT_TENANT_ID`.
 * @returns Path starting with `/mcp/`.
 */
export function buildMcpPath(profileName: string, tenantId: string = DEFAULT_TENANT_ID): string {
  const encodedProfile = encodeURIComponent(profileName);
  if (tenantId === DEFAULT_TENANT_ID) {
    return `/mcp/${encodedProfile}`;
  }
  return `/mcp/${encodeURIComponent(tenantId)}/${encodedProfile}`;
}

/**
 * Build a fully qualified MCP URL (with origin) for a (tenant, profile) pair.
 *
 * @param origin     Host origin, e.g. `http://localhost:4567` (no trailing slash).
 * @param profileName Profile name.
 * @param tenantId   Tenant id; defaults to `DEFAULT_TENANT_ID`.
 */
export function buildMcpUrl(
  origin: string,
  profileName: string,
  tenantId: string = DEFAULT_TENANT_ID,
): string {
  const trimmed = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  return `${trimmed}${buildMcpPath(profileName, tenantId)}`;
}

/**
 * Minimal request surface needed to derive the public MCP origin. Kept
 * structural so callers can pass an Express `Request` or a test double.
 */
export interface McpOriginRequest {
  protocol: string;
  get(name: 'host'): string | undefined;
}

/**
 * Single source of truth for the MCP origin (`protocol://host[:port]`) that
 * clients should use to reach this server. MCP routes are mounted at the app
 * root (never under `CALAME_BASE_PATH`), so the origin is all that is needed
 * before appending `buildMcpPath(...)`.
 *
 * Derived from the request the admin UI just made: `req.protocol` and the
 * `Host` header already honour `CALAME_TRUST_PROXY` (X-Forwarded-Proto /
 * X-Forwarded-Host), so a reverse-proxied install reports its public address.
 * Falls back to the configured listening port on localhost when the request
 * carries no Host header. Returns `null` when neither is known — callers must
 * then show an honest "address unavailable" state rather than invent one.
 */
export function resolveMcpOrigin(req: McpOriginRequest, fallbackPort?: number): string | null {
  const protocol = req.protocol === 'https' ? 'https' : 'http';
  const host = req.get('host');
  if (host) return `${protocol}://${host}`;
  if (fallbackPort && fallbackPort > 0) return `${protocol}://localhost:${fallbackPort}`;
  return null;
}
