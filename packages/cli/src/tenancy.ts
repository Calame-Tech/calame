/**
 * Multi-tenancy helpers — Phase B (enforcement layer).
 *
 * The host database carries a `tenant_id TEXT NOT NULL DEFAULT 'default'`
 * column on every per-tenant table from migration v12 onwards. The
 * companion RAG migration (`ee/rag-core/src/storage/schema.ts` v6) adds
 * the same column to every `rag_*` table.
 *
 * Phase A (commit 402219b) was strictly additive: every fresh INSERT
 * lands under `'default'`, every SELECT continues to return every row.
 *
 * Phase B (this module) flips reads to honour the tenant:
 *
 *   1. `getTenantId(req)` resolves the tenant from the `X-Tenant-Id`
 *      request header (falling back to `'default'` when absent / malformed).
 *      The shape `req.auth.tenantId` is also honoured to keep the door
 *      open for a future auth integration (Phase C).
 *
 *   2. Every route that previously read rows unconditionally now binds
 *      the resolved tenant into a `WHERE tenant_id = ?` clause. Cross-
 *      tenant lookups land as `404 Not Found` rather than leaking the
 *      foreign row's existence.
 *
 * Backward compatibility is critical:
 *   - Any caller that does NOT send `X-Tenant-Id` continues to behave
 *     exactly as in Phase A — the helper returns `'default'`, every
 *     existing row is tagged `'default'`, and every SELECT matches.
 *   - The header value is validated against the strict `[A-Za-z0-9_-]+`
 *     alphabet (max 64 chars). Malformed headers fall back to the
 *     default — they never cause a 400, they never reach SQL unescaped.
 *
 * Phase C (UI workspace switcher + auth-integrated tenant) will:
 *   - Read the tenant from the authenticated session/JWT rather than
 *     a forgeable header.
 *   - Surface a workspace dropdown in the React shell.
 *   - Re-evaluate the MCP serve endpoint, which today is pinned to
 *     `'default'` because external MCP clients (Claude Desktop, …)
 *     cannot easily inject a per-request header.
 */

/** The single literal tenant id used as the implicit default. */
export const DEFAULT_TENANT_ID = 'default';

/**
 * Regex pinning the accepted tenant id alphabet. Intentionally narrow:
 *   - lowercase / uppercase letters, digits, underscore and hyphen,
 *   - 1 to 64 characters,
 *   - no whitespace, no separators that could land in a `LIKE` /
 *     parameterised binding and break a downstream `IN` clause.
 *
 * Tenant ids are bound via parameterised statements everywhere, so the
 * regex exists for defence-in-depth — it stops a forged header from
 * being persisted (and later echoed back to other tenants in audit
 * logs).
 */
const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Minimal duck-typed shape of an Express `Request` — covers just the
 * fields we read in Phase B without forcing this module to depend on
 * Express at the type level. The `auth` field is forward-compat: Phase
 * C will populate it from the session layer and we will prefer it over
 * the header.
 */
export interface TenantRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  /** Populated by the auth middleware in Phase C. */
  auth?: { tenantId?: string };
}

/**
 * Return the first non-empty string in a header value, accepting both
 * the canonical `string` shape and Express's `string[]` for repeated
 * headers. Returns `null` when nothing usable is present.
 *
 * Express lower-cases header names before exposing them on
 * `req.headers`, so callers can use `'x-tenant-id'` regardless of the
 * case the client sent.
 */
function readHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') {
    return value.length > 0 ? value : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

/**
 * Resolve the tenant id for the supplied request. The resolution order
 * mirrors what Phase C will need:
 *
 *   1. Prefer `req.auth.tenantId` when populated (auth layer wins).
 *   2. Fall back to the `X-Tenant-Id` request header.
 *   3. Default to `DEFAULT_TENANT_ID` when neither is present.
 *
 * Any value that fails the {@link TENANT_ID_RE} validation falls back to
 * the default — we never bind a malformed value into SQL, even though
 * the binding itself is parameterised.
 *
 * Callers should always pass the request when one is available;
 * background workers and schedulers call this without an argument to
 * obtain the default explicitly (rather than hard-coding the literal).
 */
export function getTenantId(req?: TenantRequestLike): string {
  // 1. Auth-derived tenant (Phase C). Surfaced today so the call sites
  // already pass `req` — once the auth middleware lands the value will
  // flow through without further refactor.
  const authTenant = req?.auth?.tenantId;
  if (typeof authTenant === 'string' && TENANT_ID_RE.test(authTenant)) {
    return authTenant;
  }

  // 2. Header-derived tenant. Express lower-cases header keys, so we
  // look up the canonical lowercased form.
  const headerValue = readHeader(req?.headers?.['x-tenant-id']);
  if (headerValue !== null && TENANT_ID_RE.test(headerValue)) {
    return headerValue;
  }

  // 3. Default — preserves the Phase A behaviour for every caller that
  // does not yet send the header.
  return DEFAULT_TENANT_ID;
}

/**
 * Fail-closed variant of {@link getTenantId}. Resolves the tenant from
 * the auth context / `X-Tenant-Id` header using the exact same rules,
 * but returns `null` instead of falling back to {@link DEFAULT_TENANT_ID}
 * when neither source yields a valid tenant.
 *
 * Routes that expose tenant-scoped, security-sensitive resources (e.g.
 * the user-admin endpoints, some of which return plaintext tokens) use
 * this and translate a `null` result into a `403 Forbidden`, so an
 * untenanted request can never silently operate on the default tenant.
 */
export function getTenantIdStrict(req?: TenantRequestLike): string | null {
  const authTenant = req?.auth?.tenantId;
  if (typeof authTenant === 'string' && TENANT_ID_RE.test(authTenant)) {
    return authTenant;
  }

  const headerValue = readHeader(req?.headers?.['x-tenant-id']);
  if (headerValue !== null && TENANT_ID_RE.test(headerValue)) {
    return headerValue;
  }

  return null;
}

/**
 * Returns `true` when the supplied tenant id is the implicit default.
 * Used by code paths that need to behave differently outside of single-
 * tenant mode (e.g. hide the tenant column in the UI until at least one
 * non-default tenant exists).
 */
export function isDefaultTenant(tenantId: string): boolean {
  return tenantId === DEFAULT_TENANT_ID;
}
