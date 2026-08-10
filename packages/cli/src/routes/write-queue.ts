import type { Express } from 'express';
import type { AppState } from '../state.js';
import type { PendingWriteQuery } from '@calame/core';
import { callUpstreamTool } from '@calame/connectors';
import { getTenantId } from '../tenancy.js';
import { CORRUPT_ACTION_MESSAGE } from '../write-queue.js';
import {
  resolveWriteTarget,
  executeApprovedWrite,
  resolveMcpWriteTarget,
} from '../write-executor.js';

export function registerWriteQueueRoute(app: Express, state: AppState): void {
  // GET /api/write-queue - List write queue entries (scoped to the caller's tenant)
  app.get('/api/write-queue', async (req, res) => {
    try {
      const writeQueue = state.writeQueue;
      if (!writeQueue) {
        res.json({ success: true, entries: [], total: 0 });
        return;
      }

      const status = req.query.status as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

      const result = writeQueue.getAll({ status, limit, offset, tenantId: getTenantId(req) });
      res.json({ success: true, ...result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'write-queue', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // GET /api/write-queue/count - Get pending count for the caller's tenant (badge)
  app.get('/api/write-queue/count', async (req, res) => {
    try {
      const writeQueue = state.writeQueue;
      if (!writeQueue) {
        res.json({ success: true, pending: 0 });
        return;
      }

      const pending = writeQueue.getPending(getTenantId(req)).length;
      res.json({ success: true, pending });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Count error', { component: 'write-queue', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/write-queue/:id/approve - Approve a pending write
  app.post('/api/write-queue/:id/approve', async (req, res) => {
    try {
      const writeQueue = state.writeQueue;
      if (!writeQueue) {
        res.status(500).json({ success: false, message: 'Write queue not initialized.' });
        return;
      }

      // Tenant guard: an admin can only see/approve entries of the tenant the
      // request targets. Cross-tenant ids get the same 404 as unknown ids so
      // entry existence is not leaked across workspaces.
      const existing = writeQueue.getById(req.params.id);
      if (!existing || (existing.tenantId ?? 'default') !== getTenantId(req)) {
        res.status(404).json({ success: false, message: 'Pending write query not found.' });
        return;
      }

      // A row whose action_json failed to parse is listable (so the admin can
      // see and REJECT it) but never executable — approving would run
      // whatever the flat compat columns hold (an empty sql_text) against
      // some connection.
      if (existing.actionCorrupt) {
        res.status(500).json({ success: false, message: CORRUPT_ACTION_MESSAGE });
        return;
      }

      // Exhaustive dispatch on the action kind. `sql` (or a legacy row with
      // no action) takes the SQL path; `mcp-tool` forwards upstream; any
      // OTHER kind — e.g. a row written by a newer build before a rollback —
      // is refused without mutating the entry, instead of falling through to
      // the SQL executor with an empty sql_text.
      const kind = existing.action?.kind ?? 'sql';
      let entry: PendingWriteQuery | null;
      if (kind === 'mcp-tool' && existing.action?.kind === 'mcp-tool') {
        // Slice 1 (MCP write-approval): the source is resolved by
        // `action.sourceId` AND the entry's tenant — never from config stored
        // on the queue row — the SAME "reference, not config" rule
        // `resolveWriteTarget` applies to SQL writes below. A vanished,
        // soft-deleted, or foreign-tenant source throws BEFORE any queue
        // mutation, so the entry stays 'pending' and nothing executes.
        const { sourceId, toolName, args } = existing.action;
        const upstreamConfig = resolveMcpWriteTarget(
          state,
          sourceId,
          existing.tenantId ?? 'default',
        );

        entry = await writeQueue.approveMcpTool(req.params.id, async () => {
          const result = await callUpstreamTool(upstreamConfig, toolName, args);
          if (result.isError) {
            throw new Error(result.text || 'Upstream MCP tool call failed.');
          }
          return result.text;
        });
      } else if (kind === 'sql') {
        // Resolve the TARGET connection stamped on the entry (legacy rows fall
        // back to the cached connection) and execute via the matching driver —
        // never a hardcoded dialect against whatever connection came last.
        const target = resolveWriteTarget(state, existing);

        entry = await writeQueue.approve(req.params.id, (sql: string, params: unknown[]) =>
          executeApprovedWrite(target.databaseType, target.connectionString, sql, params),
        );
      } else {
        res.status(400).json({
          success: false,
          message: `Unsupported write action kind "${kind}" — this entry may have been written by a newer version.`,
        });
        return;
      }

      if (!entry) {
        res.status(404).json({ success: false, message: 'Pending write query not found.' });
        return;
      }

      await writeQueue.save();
      res.json({ success: true, entry });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Approve error', { component: 'write-queue', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/write-queue/:id/reject - Reject a pending write
  app.post('/api/write-queue/:id/reject', async (req, res) => {
    try {
      const writeQueue = state.writeQueue;
      if (!writeQueue) {
        res.status(500).json({ success: false, message: 'Write queue not initialized.' });
        return;
      }

      const existing = writeQueue.getById(req.params.id);
      if (!existing || (existing.tenantId ?? 'default') !== getTenantId(req)) {
        res.status(404).json({ success: false, message: 'Pending write query not found.' });
        return;
      }

      const entry = writeQueue.reject(req.params.id);
      if (!entry) {
        res.status(404).json({ success: false, message: 'Pending write query not found.' });
        return;
      }

      await writeQueue.save();
      res.json({ success: true, entry });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Reject error', { component: 'write-queue', error: message });
      res.status(500).json({ success: false, message });
    }
  });
}
