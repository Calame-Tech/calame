/**
 * Multi-tenancy helpers — Phase A (foundation only).
 *
 * The host database carries a `tenant_id TEXT NOT NULL DEFAULT 'default'`
 * column on every per-tenant table from migration v12 onwards. The
 * companion RAG migration (`ee/rag-core/src/storage/schema.ts` v6) adds
 * the same column to every `rag_*` table.
 *
 * This module exists for two reasons:
 *
 *   1. Centralise the literal `'default'` so every INSERT site can ask
 *      `getTenantId(req)` instead of hardcoding the string. Phase B will
 *      flip this single helper to read from `req.auth.tenantId` (or an
 *      `X-Tenant-Id` header for service-to-service calls) without any
 *      call-site changes.
 *
 *   2. Provide a single grep target — `getTenantId(` — so future audits
 *      (and the eventual route middleware) can find every tenant boundary
 *      in seconds.
 *
 * Phase A is strictly additive: no route filters by tenant, every fresh
 * INSERT lands under `'default'`, every SELECT continues to return every
 * row. The migration is rollbackable by dropping the column on each table.
 *
 * Phase B (auth-integrated) will:
 *   - Read the tenant from the authenticated request.
 *   - Wire `WHERE tenant_id = ?` into every read path.
 *   - Promote the `(tenant_id, name)` indexes added in migration v12 to
 *     UNIQUE so names can collide across tenant boundaries.
 *
 * Phase C (UI workspace switcher) will surface the tenant selector and
 * keep the active tenant in the session.
 */

/** The single literal tenant id used during Phase A. */
export const DEFAULT_TENANT_ID = 'default';

/**
 * Minimal duck-typed shape of an Express `Request` — covers just the
 * fields we plan to read in Phase B without forcing this module to depend
 * on Express at the type level. Phase A ignores the argument entirely.
 */
export interface TenantRequestLike {
	headers?: Record<string, string | string[] | undefined>;
	/** Populated by the auth middleware in Phase B. */
	auth?: { tenantId?: string };
}

/**
 * Resolve the tenant id for the supplied request. Phase A always returns
 * `'default'`; the argument is accepted (and ignored) so call sites can
 * adopt the helper today without churn when Phase B lands.
 *
 * Future implementations will:
 *   1. Prefer `req.auth.tenantId` (populated by the session/auth layer).
 *   2. Fall back to the `X-Tenant-Id` header for service-to-service calls.
 *   3. Default to `DEFAULT_TENANT_ID` for unauthenticated paths that still
 *      need to write somewhere (e.g. onboarding bootstrap).
 */
export function getTenantId(_req?: TenantRequestLike): string {
	// Phase A: always 'default'. Phase B will read req.auth.tenantId or
	// req.headers['x-tenant-id']. Keep the underscore prefix so eslint's
	// no-unused-vars rule is happy until then.
	return DEFAULT_TENANT_ID;
}

/**
 * Returns `true` when the supplied tenant id is the Phase A default. Used
 * by code paths that need to behave differently outside of single-tenant
 * mode (e.g. hide the tenant column in the UI until at least one
 * non-default tenant exists).
 */
export function isDefaultTenant(tenantId: string): boolean {
	return tenantId === DEFAULT_TENANT_ID;
}
