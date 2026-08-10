import type { CalameDatabase } from './database.js';
import { DEFAULT_TENANT_ID } from './tenancy.js';

/**
 * Single source of truth for resolving a non-relational source row.
 *
 * `rag_sources` is the only "unified sources" table in the codebase, so every
 * non-relational source — document *and* MCP-proxy — stores its type, display
 * name and encrypted config there. Before this module the lookup was copy-
 * pasted in four places (`resolveAdapterForSource` / `resolveAdapterConfig`
 * in `routes/serve/registration.ts`, the document-loop tenant guard there, and
 * `resolveMcpWriteTarget` in `write-executor.ts`) and the copies drifted: the
 * MCP ones omitted BOTH security filters that the rest of the codebase
 * applies to this table.
 *
 * The two filters, and why each is load-bearing:
 *
 *  - `tenant_id = ?` — without it a profile served under tenant A could
 *    resolve a source owned by tenant B and use its decrypted credentials to
 *    reach that tenant's upstream server. Every other reader of this table
 *    binds the tenant (see `ee/rag-core/src/routes/rag-sources.ts`,
 *    `rag-search.ts`, `hybrid-search.ts`).
 *  - `deleted_at IS NULL` — sources are soft-deleted (migration v8). A
 *    soft-deleted source is hidden from every listing, the poll scheduler and
 *    the watch manager, yet it stayed fully resolvable (and therefore
 *    executable) through the MCP paths.
 *
 * The column/value conventions are copied verbatim from the existing readers:
 * `tenant_id TEXT NOT NULL DEFAULT 'default'` (see the v6 RAG migration), so
 * the implicit tenant is {@link DEFAULT_TENANT_ID}, never NULL/undefined.
 */

/** Live (tenant-owned, non-deleted) projection of a `rag_sources` row. */
export interface LiveRagSource {
  /** Adapter type key — e.g. 'local', 's3', 'mcp'. */
  type: string;
  /** Human-readable display name (`rag_sources.name`). */
  name: string;
  /** Encrypted config blob; decrypt via `ragRuntime.decryptConfig`. */
  configEncrypted: string;
  /** Owning tenant — always equal to the tenant the lookup was scoped to. */
  tenantId: string;
}

/**
 * Outcome of a source lookup. The failure arms are distinguished so callers
 * can log/throw something actionable ("deleted" vs "gone") without having to
 * re-query the table themselves.
 */
export type RagSourceLookup =
  | { status: 'ok'; source: LiveRagSource }
  /** No row with that id (or `rag_sources` does not exist at all). */
  | { status: 'missing' }
  /** Row exists but is soft-deleted. */
  | { status: 'deleted' }
  /** Row exists and is live, but belongs to a different tenant. */
  | { status: 'foreign'; tenantId: string };

interface LiveRow {
  type: string;
  name: string;
  config_encrypted: string;
  tenant_id: string | null;
  deleted_at: string | null;
}

interface OwnershipRow {
  tenant_id: string | null;
  deleted_at: string | null;
}

/**
 * Authoritative query: both security filters are applied in SQL, so a row can
 * only come back when it is live AND owned by the requesting tenant.
 */
const SELECT_LIVE_SOURCE = `SELECT type, name, config_encrypted, tenant_id, deleted_at
     FROM rag_sources
    WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    LIMIT 1`;

/**
 * Diagnostic query, run only when {@link SELECT_LIVE_SOURCE} matched nothing:
 * it classifies the miss (deleted / foreign / truly absent) so the caller can
 * produce a precise warning. It is never used to grant access.
 */
const SELECT_SOURCE_OWNERSHIP = `SELECT tenant_id, deleted_at FROM rag_sources WHERE id = ? LIMIT 1`;

/**
 * Look up a source and classify the result. Returns `{ status: 'missing' }`
 * whenever the table cannot be read at all (RAG schema never initialised, EE
 * absent) — that is the same "not resolvable" outcome the previous inline
 * try/catch blocks produced, and it fails closed.
 */
export function lookupLiveRagSource(
  db: CalameDatabase | null | undefined,
  sourceId: string,
  tenantId: string,
): RagSourceLookup {
  if (!db) return { status: 'missing' };

  let row: LiveRow | undefined;
  try {
    row = db.raw.prepare<[string, string], LiveRow>(SELECT_LIVE_SOURCE).get(sourceId, tenantId);
  } catch {
    // Defensive: `rag_sources` may not exist yet (no RAG migration run).
    return { status: 'missing' };
  }

  if (row) {
    // Defence in depth. The SQL above is the real filter; these two checks
    // additionally hold when the row is served by a stub/mock `prepare` that
    // ignores bound parameters, so an isolation bug can never hide behind a
    // permissive test double. A row whose `tenant_id` is absent (legacy shape
    // predating the v6 tenant migration) is treated as the default tenant,
    // matching `lookupSourceTenant`'s `?? DEFAULT_TENANT_ID` convention.
    if (row.deleted_at !== null && row.deleted_at !== undefined) {
      return { status: 'deleted' };
    }
    const rowTenant = row.tenant_id ?? undefined;
    if (rowTenant !== undefined && rowTenant !== tenantId) {
      return { status: 'foreign', tenantId: rowTenant };
    }
    return {
      status: 'ok',
      source: {
        type: row.type,
        name: row.name,
        configEncrypted: row.config_encrypted,
        tenantId: rowTenant ?? DEFAULT_TENANT_ID,
      },
    };
  }

  try {
    const owner = db.raw.prepare<[string], OwnershipRow>(SELECT_SOURCE_OWNERSHIP).get(sourceId);
    if (!owner) return { status: 'missing' };
    if (owner.deleted_at !== null && owner.deleted_at !== undefined) {
      return { status: 'deleted' };
    }
    return { status: 'foreign', tenantId: owner.tenant_id ?? DEFAULT_TENANT_ID };
  } catch {
    return { status: 'missing' };
  }
}

/**
 * Convenience wrapper around {@link lookupLiveRagSource} for callers that do
 * not need to distinguish *why* a source is unavailable: returns the live
 * source, or `null` when it is absent, soft-deleted, or owned by another
 * tenant.
 */
export function loadLiveRagSource(
  db: CalameDatabase | null | undefined,
  sourceId: string,
  tenantId: string,
): LiveRagSource | null {
  const result = lookupLiveRagSource(db, sourceId, tenantId);
  return result.status === 'ok' ? result.source : null;
}
