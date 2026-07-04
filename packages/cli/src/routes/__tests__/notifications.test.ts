import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { UserManager } from '../../user.js';
import { NotificationDispatcher } from '../../notifications.js';
import { setupAdminAndGetCookie } from './helpers.js';

const SECRET_MASK = '•••';

describe('notifications routes', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let db: CalameDatabase;
  let originalCwd: string;
  let tmpDir: string;
  let cookie: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-notifications-route-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);

    // Replace the auto-initialized dispatcher with one whose webhook fetch/sleep
    // are test doubles — routes read `state.notifications` per-request, so this
    // swap is picked up by every request made after this point.
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    state.notifications = new NotificationDispatcher(
      db,
      () => state.smtpConfigManager?.getConfig() ?? null,
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        sleep: vi.fn().mockResolvedValue(undefined),
      },
    );
  });

  afterEach(async () => {
    state.db?.close();
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function insertNotification(overrides: {
    id: string;
    tenantId?: string;
    title?: string;
    createdAt: string;
    readAt?: string | null;
  }) {
    db.raw
      .prepare(
        `INSERT INTO notifications (id, tenant_id, type, title, body, payload, created_at, read_at)
         VALUES (?, ?, 'write_queue.pending', ?, 'body', '{}', ?, ?)`,
      )
      .run(
        overrides.id,
        overrides.tenantId ?? 'default',
        overrides.title ?? 'Title',
        overrides.createdAt,
        overrides.readAt ?? null,
      );
  }

  describe('GET /api/notifications', () => {
    it('lists notifications newest first with the unread count', async () => {
      insertNotification({ id: 'n1', createdAt: '2026-01-01T00:00:00.000Z' });
      insertNotification({ id: 'n2', createdAt: '2026-01-02T00:00:00.000Z' });
      insertNotification({
        id: 'n3',
        createdAt: '2026-01-03T00:00:00.000Z',
        readAt: '2026-01-03T01:00:00.000Z',
      });

      const res = await request(app).get('/api/notifications').set('Cookie', cookie).expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.notifications.map((n: { id: string }) => n.id)).toEqual(['n3', 'n2', 'n1']);
      expect(res.body.unreadCount).toBe(2);
    });

    it('filters to unread only with ?unread=1', async () => {
      insertNotification({ id: 'n1', createdAt: '2026-01-01T00:00:00.000Z' });
      insertNotification({
        id: 'n2',
        createdAt: '2026-01-02T00:00:00.000Z',
        readAt: '2026-01-02T01:00:00.000Z',
      });

      const res = await request(app)
        .get('/api/notifications?unread=1&limit=10')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.notifications).toHaveLength(1);
      expect(res.body.notifications[0].id).toBe('n1');
    });

    it('respects the limit query param', async () => {
      insertNotification({ id: 'n1', createdAt: '2026-01-01T00:00:00.000Z' });
      insertNotification({ id: 'n2', createdAt: '2026-01-02T00:00:00.000Z' });

      const res = await request(app)
        .get('/api/notifications?limit=1')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.notifications).toHaveLength(1);
      expect(res.body.notifications[0].id).toBe('n2');
    });
  });

  describe('POST /api/notifications/:id/read', () => {
    it('marks a single notification read', async () => {
      insertNotification({ id: 'n1', createdAt: '2026-01-01T00:00:00.000Z' });

      await request(app).post('/api/notifications/n1/read').set('Cookie', cookie).expect(200);

      const res = await request(app).get('/api/notifications').set('Cookie', cookie).expect(200);
      expect(res.body.unreadCount).toBe(0);
      expect(res.body.notifications[0].readAt).toBeDefined();
    });
  });

  describe('POST /api/notifications/read-all', () => {
    it('marks every unread notification read', async () => {
      insertNotification({ id: 'n1', createdAt: '2026-01-01T00:00:00.000Z' });
      insertNotification({ id: 'n2', createdAt: '2026-01-02T00:00:00.000Z' });

      await request(app).post('/api/notifications/read-all').set('Cookie', cookie).expect(200);

      const res = await request(app).get('/api/notifications').set('Cookie', cookie).expect(200);
      expect(res.body.unreadCount).toBe(0);
    });
  });

  describe('GET /api/notification-settings', () => {
    it('returns default settings with no secret when nothing is stored', async () => {
      const res = await request(app)
        .get('/api/notification-settings')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.settings.webhookEnabled).toBe(false);
      expect(res.body.settings.webhookSecret).toBeUndefined();
    });

    it('masks a stored webhook secret with the sentinel', async () => {
      await request(app)
        .post('/api/notification-settings')
        .set('Cookie', cookie)
        .send({
          webhookEnabled: true,
          webhookUrl: 'https://example.com/hook',
          webhookSecret: 'super-secret',
          webhookFormat: 'json',
          emailEnabled: false,
          emailRecipients: [],
        })
        .expect(200);

      const res = await request(app)
        .get('/api/notification-settings')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.settings.webhookSecret).toBe(SECRET_MASK);
      // The real secret is never leaked in the response body.
      expect(JSON.stringify(res.body)).not.toContain('super-secret');
    });
  });

  describe('POST /api/notification-settings', () => {
    it('persists settings that round-trip through the dispatcher', async () => {
      await request(app)
        .post('/api/notification-settings')
        .set('Cookie', cookie)
        .send({
          webhookEnabled: true,
          webhookUrl: 'https://example.com/hook',
          webhookSecret: 'super-secret',
          webhookFormat: 'slack',
          emailEnabled: true,
          emailRecipients: ['a@example.com', 'b@example.com'],
        })
        .expect(200);

      const stored = state.notifications!.settings.getSettings('default');
      expect(stored.webhookSecret).toBe('super-secret');
      expect(stored.webhookFormat).toBe('slack');
      expect(stored.emailRecipients).toEqual(['a@example.com', 'b@example.com']);
    });

    it('rejects a webhook URL with a non-http(s) scheme', async () => {
      await request(app)
        .post('/api/notification-settings')
        .set('Cookie', cookie)
        .send({ webhookEnabled: true, webhookUrl: 'file:///etc/passwd' })
        .expect(400);
    });

    it('rejects a malformed webhook URL', async () => {
      await request(app)
        .post('/api/notification-settings')
        .set('Cookie', cookie)
        .send({ webhookEnabled: true, webhookUrl: 'not a url' })
        .expect(400);
    });

    it('preserves the previous secret when the masked sentinel is sent back', async () => {
      await request(app)
        .post('/api/notification-settings')
        .set('Cookie', cookie)
        .send({
          webhookEnabled: true,
          webhookUrl: 'https://example.com/hook',
          webhookSecret: 'original-secret',
          webhookFormat: 'json',
          emailEnabled: false,
          emailRecipients: [],
        })
        .expect(200);

      // Re-save with the masked sentinel and a changed URL — the secret must survive.
      await request(app)
        .post('/api/notification-settings')
        .set('Cookie', cookie)
        .send({
          webhookEnabled: true,
          webhookUrl: 'https://example.com/hook-v2',
          webhookSecret: SECRET_MASK,
          webhookFormat: 'json',
          emailEnabled: false,
          emailRecipients: [],
        })
        .expect(200);

      const stored = state.notifications!.settings.getSettings('default');
      expect(stored.webhookSecret).toBe('original-secret');
      expect(stored.webhookUrl).toBe('https://example.com/hook-v2');
    });
  });

  describe('POST /api/notification-settings/test', () => {
    it('dispatches a test notification on the enabled channels only', async () => {
      await request(app)
        .post('/api/notification-settings')
        .set('Cookie', cookie)
        .send({
          webhookEnabled: true,
          webhookUrl: 'https://example.com/hook',
          webhookSecret: 'super-secret',
          webhookFormat: 'json',
          emailEnabled: false,
          emailRecipients: [],
        })
        .expect(200);

      const res = await request(app)
        .post('/api/notification-settings/test')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.results.inApp).toEqual({ ok: true });
      expect(res.body.results.webhook).toEqual({ ok: true });
      expect(res.body.results.email).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('only reports the in-app channel when no channel is enabled', async () => {
      const res = await request(app)
        .post('/api/notification-settings/test')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.results).toEqual({ inApp: { ok: true } });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('authentication', () => {
    it('rejects requests without a session cookie', async () => {
      await request(app).get('/api/notifications').expect(401);
    });
  });
});
