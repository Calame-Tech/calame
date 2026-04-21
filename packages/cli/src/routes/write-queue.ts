import type { Express } from 'express';
import type { AppState } from '../state.js';

export function registerWriteQueueRoute(app: Express, state: AppState): void {
  // GET /api/write-queue - List write queue entries
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

      const result = writeQueue.getAll({ status, limit, offset });
      res.json({ success: true, ...result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'write-queue', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // GET /api/write-queue/count - Get pending count (for badge)
  app.get('/api/write-queue/count', async (_req, res) => {
    try {
      const writeQueue = state.writeQueue;
      if (!writeQueue) {
        res.json({ success: true, pending: 0 });
        return;
      }

      const pending = writeQueue.getPending().length;
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

      if (!state.cachedConnectionString || !state.cachedDatabaseType) {
        res.status(500).json({ success: false, message: 'No database connection configured.' });
        return;
      }

      const connectionString = state.cachedConnectionString;

      const entry = await writeQueue.approve(req.params.id, async (sql: string, params: unknown[]) => {
        // Execute the write query using pg directly (same pattern as serve.ts)
        const { Client } = await import('pg');
        const client = new Client({ connectionString });
        await client.connect();
        try {
          const result = await client.query(sql, params);
          return { rows: result.rows ?? [] };
        } finally {
          await client.end();
        }
      });

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
