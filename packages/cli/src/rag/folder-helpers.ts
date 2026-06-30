// Pure folder-argument helpers shared by the document storage layer and the
// MCP tool handlers. Extracted from `rag-runtime.ts` so they can be unit-tested
// without a real Database (see __tests__/rag-storage-helpers.test.ts). The
// orchestrator re-exports these to preserve the historical import path.

/**
 * Normalise a folder argument coming from an MCP tool or the UI layer.
 *
 * Rules:
 *  - `undefined` → `undefined` (no constraint: all folders / all documents)
 *  - blank after trim + strip leading/trailing slashes → `""` (root-level)
 *  - everything else → trimmed + stripped value (id or path to resolve)
 */
export function normaliseFolderArg(arg: string | undefined): string | undefined {
  if (arg === undefined) return undefined;
  return arg.trim().replace(/^\/+|\/+$/g, '');
}

/**
 * Minimal DB surface needed to resolve a folder id from an id-or-path value.
 * Extracted so the helper can be called from tests without a real Database.
 * Uses `any` in the prepare signature to remain assignable to the
 * better-sqlite3 generic Statement shape without re-exporting its type.
 */
export interface FolderResolverDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prepare: (sql: string) => { get: (...params: any[]) => { id: string } | undefined };
}

/**
 * Resolve a non-empty normalised folder argument to a folder id.
 *
 * Accepts either a real folder id or a folder path (MCP tools pass paths,
 * the UI may pass ids). Returns `null` when no matching folder is found.
 */
export function resolveFolderId(
  db: FolderResolverDb,
  sourceId: string,
  normalised: string,
): string | null {
  const row = db
    .prepare('SELECT id FROM rag_folders WHERE source_id = ? AND (id = ? OR path = ?) LIMIT 1')
    .get(sourceId, normalised, normalised);
  return row ? row.id : null;
}
