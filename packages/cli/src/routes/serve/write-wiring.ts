import type { AppState } from '../../state.js';
import type { PendingWriteQuery } from '@calame/core';
import { WriteQueue } from '../../write-queue.js';

/**
 * Builds the `onWriteRequest` callback passed to `registerDynamicTools` so the
 * `write` MCP tool (packages/core/src/serve/tools/write.ts) actually lands
 * proposed writes in the write-queue and triggers an admin notification.
 *
 * Before this helper existed, no caller of `registerDynamicTools` in the CLI
 * passed `onWriteRequest` at all, so `registerWriteGeneric` (dynamic-tools.ts:316)
 * was never invoked — the `write` tool silently never registered, regardless
 * of a table's `enabledTools`. This restores exactly that wiring without
 * touching the tool's own gating/semantics.
 *
 * Lazily creates `state.writeQueue` on first use — mirrors the lazy-init
 * pattern already used in `routes/serve-status.ts` (`new WriteQueue(state.db)`).
 */
export function createOnWriteRequest(
  state: AppState,
  tenantId: string,
  target?: { connectionName: string; databaseType: string },
): (query: Omit<PendingWriteQuery, 'id' | 'timestamp' | 'status'>) => string {
  return (query) => {
    if (!state.writeQueue) {
      if (!state.db) {
        throw new Error('Cannot queue write request: database is not initialized.');
      }
      state.writeQueue = new WriteQueue(state.db);
    }

    // Stamp tenancy + target connection: the admin routes scope on tenantId,
    // and approval resolves connectionName to execute against the SAME
    // database the write was proposed for (never a cached/last connection).
    const id = state.writeQueue.addRequest({
      ...query,
      tenantId,
      connectionName: target?.connectionName,
      databaseType: target?.databaseType,
    });

    // Fire-and-forget: notification dispatch must never block or fail the MCP
    // tool call that queued the write. NotificationDispatcher already swallows
    // per-channel errors internally; the catch here is defense-in-depth for
    // the returned promise itself.
    void state.notifications
      ?.dispatch({
        type: 'write_queue.pending',
        tenantId,
        title: 'Write request pending approval',
        body: `${query.operation.toUpperCase()} on "${query.tableName}" — ${query.description}`,
        payload: { id, ...query },
      })
      .catch(() => {});

    return id;
  };
}
