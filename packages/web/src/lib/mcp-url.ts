/**
 * Frontend mirror of packages/cli/src/utils/mcp-url.ts.
 *
 * The MCP serve route accepts two URL formats:
 *
 *   1. `/mcp/<profileName>`                — legacy / default tenant
 *   2. `/mcp/<tenantId>/<profileName>`     — tenant-qualified
 *
 * The legacy form is implicitly bound to the `'default'` tenant so existing
 * MCP-client configurations keep working unchanged. The new form lets an
 * admin issue a per-tenant URL to external clients that cannot inject the
 * `X-Tenant-Id` header.
 *
 * Single-segment URLs are always interpreted as legacy — see the docstring in
 * the backend module for the rationale.
 */

export const DEFAULT_TENANT_ID = 'default';

/**
 * Build the MCP endpoint path for a (tenant, profile) pair.
 * Returns the legacy form when the tenant is the implicit default so the URLs
 * surfaced to users stay short whenever possible.
 *
 * @param profileName The profile name (will be URL-encoded).
 * @param tenantId    Tenant id; defaults to `DEFAULT_TENANT_ID`.
 * @returns Path starting with `/mcp/`.
 */
export function buildMcpPath(
	profileName: string,
	tenantId: string = DEFAULT_TENANT_ID,
): string {
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
