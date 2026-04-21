import type { Express } from 'express';
import type { AppState } from '../state.js';

export function registerAuditRoute(app: Express, state: AppState): void {
  app.get('/api/audit', async (req, res) => {
    try {
      const auditLog = state.auditLog;
      if (!auditLog) {
        res.status(500).json({ success: false, message: 'Audit log not initialized.' });
        return;
      }

      const profileName = req.query.profileName as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
      const since = req.query.since as string | undefined;

      const result = auditLog.getEntries({ profileName, limit, offset, since });
      res.json({ success: true, ...result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'audit', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  app.get('/api/audit/export', async (req, res) => {
    try {
      const auditLog = state.auditLog;
      if (!auditLog) {
        res.status(500).json({ success: false, message: 'Audit log not initialized.' });
        return;
      }

      const format = (req.query.format as string) || 'json';

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="calame-audit.csv"');
        res.send(auditLog.exportCSV());
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="calame-audit.json"');
        res.send(auditLog.exportJSON());
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Export error', { component: 'audit', error: message });
      res.status(500).json({ success: false, message });
    }
  });
}
