import type { Express } from 'express';
import type { AppState } from '../state.js';
import { getTenantId } from '../tenancy.js';
import { resolveWriteTarget, executeApprovedWrite } from '../write-executor.js';

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

      // Resolve the TARGET connection stamped on the entry (legacy rows fall
      // back to the cached connection) and execute via the matching driver —
      // never a hardcoded dialect against whatever connection came last.
      const target = resolveWriteTarget(state, existing);

      const entry = await writeQueue.approve(req.params.id, (sql: string, params: unknown[]) =>
        executeApprovedWrite(target.databaseType, target.connectionString, sql, params),
      );

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
