import type { Express } from 'express';
import type { AppState } from '../state.js';
import type { NotificationSettings } from '../notifications.js';
import { getTenantId } from '../tenancy.js';

/** Sentinel returned in place of a real webhook secret — never the actual value. */
const SECRET_MASK = '•••';
/** Hard ceiling on `?limit=` regardless of what the client asks for. */
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

/** Row shape returned by better-sqlite3 for `notifications` reads. */
interface NotificationRow {
  id: string;
  tenant_id: string;
  type: string;
  title: string;
  body: string;
  payload: string | null;
  created_at: string;
  read_at: string | null;
}

function rowToNotification(row: NotificationRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    title: row.title,
    body: row.body,
    payload: row.payload ? (JSON.parse(row.payload) as unknown) : null,
    createdAt: row.created_at,
    readAt: row.read_at ?? undefined,
  };
}

/** Never echoes the real secret back — either the mask sentinel, or nothing. */
function maskSettings(settings: NotificationSettings): NotificationSettings {
  return {
    ...settings,
    webhookSecret: settings.webhookSecret ? SECRET_MASK : undefined,
  };
}

export function registerNotificationsRoute(app: Express, state: AppState): void {
  // GET /api/notifications?unread=1&limit=50 — list, most recent first.
  app.get('/api/notifications', (req, res) => {
    try {
      const db = state.db;
      if (!db) {
        res.json({ success: true, notifications: [], unreadCount: 0 });
        return;
      }
      const tenantId = getTenantId(req);
      const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
      const parsedLimit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : DEFAULT_LIST_LIMIT;
      const limit = Math.min(
        Math.max(Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_LIST_LIMIT, 1),
        MAX_LIST_LIMIT,
      );

      const whereClause = unreadOnly ? 'tenant_id = ? AND read_at IS NULL' : 'tenant_id = ?';
      const rows = db.raw
        .prepare(
          `SELECT * FROM notifications WHERE ${whereClause} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(tenantId, limit) as NotificationRow[];

      const unreadCountRow = db.raw
        .prepare(
          `SELECT COUNT(*) AS cnt FROM notifications WHERE tenant_id = ? AND read_at IS NULL`,
        )
        .get(tenantId) as { cnt: number };

      res.json({
        success: true,
        notifications: rows.map(rowToNotification),
        unreadCount: unreadCountRow.cnt,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'notifications', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/notifications/:id/read — mark a single notification read.
  app.post('/api/notifications/:id/read', (req, res) => {
    try {
      const db = state.db;
      if (!db) {
        res.status(500).json({ success: false, message: 'Database not initialized.' });
        return;
      }
      const tenantId = getTenantId(req);
      db.raw
        .prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND tenant_id = ?`)
        .run(new Date().toISOString(), req.params.id, tenantId);
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Read error', { component: 'notifications', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/notifications/read-all — mark every unread notification for the tenant read.
  app.post('/api/notifications/read-all', (req, res) => {
    try {
      const db = state.db;
      if (!db) {
        res.status(500).json({ success: false, message: 'Database not initialized.' });
        return;
      }
      const tenantId = getTenantId(req);
      db.raw
        .prepare(`UPDATE notifications SET read_at = ? WHERE tenant_id = ? AND read_at IS NULL`)
        .run(new Date().toISOString(), tenantId);
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Read-all error', { component: 'notifications', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // GET /api/notification-settings — settings with the webhook secret masked.
  app.get('/api/notification-settings', (req, res) => {
    try {
      const mgr = state.notifications?.settings;
      if (!mgr) {
        res.json({ success: true, settings: null });
        return;
      }
      const tenantId = getTenantId(req);
      res.json({ success: true, settings: maskSettings(mgr.getSettings(tenantId)) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'notification-settings', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/notification-settings — save settings. The masked sentinel preserves
  // the previously stored secret instead of overwriting it with the placeholder.
  app.post('/api/notification-settings', (req, res) => {
    try {
      const mgr = state.notifications?.settings;
      if (!mgr) {
        res
          .status(500)
          .json({ success: false, message: 'Notification settings manager not initialized.' });
        return;
      }

      const tenantId = getTenantId(req);
      const body = req.body as Partial<NotificationSettings> & { webhookSecret?: unknown };

      const existing = mgr.getSettings(tenantId);
      let webhookSecret = existing.webhookSecret;
      if (typeof body.webhookSecret === 'string' && body.webhookSecret !== SECRET_MASK) {
        webhookSecret = body.webhookSecret || undefined;
      }

      // Only http(s) targets — reject file://, data:, custom schemes outright.
      const webhookUrl = typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : undefined;
      if (webhookUrl) {
        let protocol: string;
        try {
          protocol = new URL(webhookUrl).protocol;
        } catch {
          res.status(400).json({ success: false, message: 'Webhook URL is not a valid URL.' });
          return;
        }
        if (protocol !== 'http:' && protocol !== 'https:') {
          res
            .status(400)
            .json({ success: false, message: 'Webhook URL must use http:// or https://.' });
          return;
        }
      }

      const settings: NotificationSettings = {
        webhookUrl: webhookUrl || undefined,
        webhookSecret,
        webhookFormat: body.webhookFormat === 'slack' ? 'slack' : 'json',
        webhookEnabled: !!body.webhookEnabled,
        emailRecipients: Array.isArray(body.emailRecipients)
          ? body.emailRecipients.filter((e): e is string => typeof e === 'string' && e.length > 0)
          : [],
        emailEnabled: !!body.emailEnabled,
      };

      mgr.saveSettings(settings, tenantId);
      res.json({ success: true, settings: maskSettings(settings) });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to save notification settings.';
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/notification-settings/test — dispatch a test notification on enabled channels.
  app.post('/api/notification-settings/test', async (req, res) => {
    try {
      const dispatcher = state.notifications;
      if (!dispatcher) {
        res.status(500).json({ success: false, message: 'Notifications are not initialized.' });
        return;
      }
      const tenantId = getTenantId(req);
      const results = await dispatcher.dispatch({
        type: 'write_queue.pending',
        tenantId,
        title: 'Test notification',
        body: 'This is a test notification from Calame.',
        payload: { test: true },
      });
      res.json({ success: true, results });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Test notification failed.';
      res.status(500).json({ success: false, message });
    }
  });
}
