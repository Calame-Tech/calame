import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CalameDatabase } from '../database.js';
import {
  NotificationDispatcher,
  NotificationSettingsManager,
  type NotificationSettings,
} from '../notifications.js';
import type { SmtpConfig } from '../smtp-config.js';

// Stub nodemailer so the email channel never opens a real socket.
const sendMailMock = vi.fn().mockResolvedValue({});
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: sendMailMock,
      verify: vi.fn().mockResolvedValue(true),
    })),
  },
}));

function makeFreshDb(): { db: CalameDatabase; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-notifications-test-'));
  const db = new CalameDatabase(tmpDir);
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/** Fetch mock builder: `responses` is a queue consumed in order across attempts. */
function makeFetchQueue(responses: Array<'ok' | 'reject' | { status: number }>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next === 'reject') throw new Error('network error');
    if (next === 'ok') return { ok: true, status: 200 } as Response;
    return { ok: false, status: next.status } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function noSmtp(): SmtpConfig | null {
  return null;
}

describe('NotificationDispatcher', () => {
  let db: CalameDatabase;
  let cleanup: () => void;

  beforeEach(() => {
    const fresh = makeFreshDb();
    db = fresh.db;
    cleanup = fresh.cleanup;
    sendMailMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('always inserts an in-app notification, even with no channels configured', async () => {
    const dispatcher = new NotificationDispatcher(db, noSmtp);
    const result = await dispatcher.dispatch({
      type: 'write_queue.pending',
      tenantId: 'default',
      title: 'New write request',
      body: 'INSERT on users',
      payload: { id: 'w1' },
    });

    expect(result.inApp.ok).toBe(true);
    expect(result.webhook).toBeUndefined();
    expect(result.email).toBeUndefined();

    const row = db.raw.prepare('SELECT * FROM notifications WHERE tenant_id = ?').get('default') as
      | { title: string; body: string; type: string; payload: string; read_at: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.title).toBe('New write request');
    expect(row!.body).toBe('INSERT on users');
    expect(row!.type).toBe('write_queue.pending');
    expect(row!.read_at).toBeNull();
    expect(JSON.parse(row!.payload)).toEqual({ id: 'w1' });
  });

  it('sends a webhook in generic JSON format with a correct HMAC signature', async () => {
    const settingsMgr = new NotificationSettingsManager(db);
    settingsMgr.saveSettings({
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'shh-secret',
      webhookFormat: 'json',
      webhookEnabled: true,
      emailRecipients: [],
      emailEnabled: false,
    });

    const { fetchImpl, calls } = makeFetchQueue(['ok']);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new NotificationDispatcher(db, noSmtp, { fetchImpl, sleep });

    const result = await dispatcher.dispatch({
      type: 'write_queue.pending',
      tenantId: 'default',
      title: 'Write pending',
      body: 'UPDATE on orders',
      payload: { id: 'w2' },
    });

    expect(result.webhook).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/hook');

    const sentBody = calls[0].init.body as string;
    const parsed = JSON.parse(sentBody);
    expect(parsed.event).toBe('write_queue.pending');
    expect(parsed.title).toBe('Write pending');
    expect(parsed.body).toBe('UPDATE on orders');
    expect(parsed.payload).toEqual({ id: 'w2' });

    const expectedSignature = crypto
      .createHmac('sha256', 'shh-secret')
      .update(sentBody)
      .digest('hex');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Calame-Signature']).toBe(`sha256=${expectedSignature}`);
  });

  it('sends a Slack-shaped payload with no signature header when format is slack', async () => {
    const settingsMgr = new NotificationSettingsManager(db);
    settingsMgr.saveSettings({
      webhookUrl: 'https://hooks.slack.com/services/xyz',
      webhookSecret: 'shh-secret',
      webhookFormat: 'slack',
      webhookEnabled: true,
      emailRecipients: [],
      emailEnabled: false,
    });

    const { fetchImpl, calls } = makeFetchQueue(['ok']);
    const dispatcher = new NotificationDispatcher(db, noSmtp, {
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    const result = await dispatcher.dispatch({
      type: 'write_queue.pending',
      tenantId: 'default',
      title: 'Write pending',
      body: 'DELETE on sessions',
      payload: {},
    });

    expect(result.webhook).toEqual({ ok: true });
    const sentBody = calls[0].init.body as string;
    expect(JSON.parse(sentBody)).toEqual({ text: 'Write pending\nDELETE on sessions' });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Calame-Signature']).toBeUndefined();
  });

  it('retries a failing webhook with backoff and succeeds on the 3rd attempt', async () => {
    const settingsMgr = new NotificationSettingsManager(db);
    settingsMgr.saveSettings({
      webhookUrl: 'https://example.com/hook',
      webhookFormat: 'json',
      webhookEnabled: true,
      emailRecipients: [],
      emailEnabled: false,
    });

    const { fetchImpl, calls } = makeFetchQueue(['reject', 'reject', 'ok']);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new NotificationDispatcher(db, noSmtp, { fetchImpl, sleep });

    const result = await dispatcher.dispatch({
      type: 'write_queue.pending',
      tenantId: 'default',
      title: 'Write pending',
      body: 'INSERT on orders',
      payload: {},
    });

    expect(result.webhook).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 5000);
  });

  it('never throws when the webhook fails on every attempt', async () => {
    const settingsMgr = new NotificationSettingsManager(db);
    settingsMgr.saveSettings({
      webhookUrl: 'https://example.com/hook',
      webhookFormat: 'json',
      webhookEnabled: true,
      emailRecipients: [],
      emailEnabled: false,
    });

    const { fetchImpl } = makeFetchQueue(['reject', 'reject', 'reject', 'reject']);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new NotificationDispatcher(db, noSmtp, { fetchImpl, sleep });

    await expect(
      dispatcher.dispatch({
        type: 'write_queue.pending',
        tenantId: 'default',
        title: 'Write pending',
        body: 'INSERT on orders',
        payload: {},
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        inApp: { ok: true },
        webhook: expect.objectContaining({ ok: false }),
      }),
    );
  });

  it('does nothing on disabled channels beyond the always-on in-app insert', async () => {
    const settingsMgr = new NotificationSettingsManager(db);
    settingsMgr.saveSettings({
      webhookUrl: 'https://example.com/hook',
      webhookFormat: 'json',
      webhookEnabled: false,
      emailRecipients: ['ops@example.com'],
      emailEnabled: false,
    });

    const { fetchImpl } = makeFetchQueue(['ok']);
    const dispatcher = new NotificationDispatcher(db, noSmtp, { fetchImpl });

    const result = await dispatcher.dispatch({
      type: 'write_queue.pending',
      tenantId: 'default',
      title: 'Write pending',
      body: 'INSERT on orders',
      payload: {},
    });

    expect(result).toEqual({ inApp: { ok: true } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('sends an email when the email channel is enabled and SMTP is configured', async () => {
    const settingsMgr = new NotificationSettingsManager(db);
    settingsMgr.saveSettings({
      webhookEnabled: false,
      webhookFormat: 'json',
      emailEnabled: true,
      emailRecipients: ['alice@example.com', 'bob@example.com'],
    });

    const smtpConfig: SmtpConfig = {
      host: 'smtp.example.com',
      port: 587,
      user: 'user',
      pass: 'pass',
      from: 'Calame <noreply@example.com>',
      configured: true,
    };
    const dispatcher = new NotificationDispatcher(db, () => smtpConfig);

    const result = await dispatcher.dispatch({
      type: 'write_queue.pending',
      tenantId: 'default',
      title: 'Write pending',
      body: 'INSERT on orders',
      payload: {},
    });

    expect(result.email).toEqual({ ok: true });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com, bob@example.com',
        subject: 'Write pending',
        text: 'INSERT on orders',
      }),
    );
  });

  it('reports an error (never throws) when email is enabled but SMTP is not configured', async () => {
    const settingsMgr = new NotificationSettingsManager(db);
    settingsMgr.saveSettings({
      webhookEnabled: false,
      webhookFormat: 'json',
      emailEnabled: true,
      emailRecipients: ['alice@example.com'],
    });

    const dispatcher = new NotificationDispatcher(db, noSmtp);
    const result = await dispatcher.dispatch({
      type: 'write_queue.pending',
      tenantId: 'default',
      title: 'Write pending',
      body: 'INSERT on orders',
      payload: {},
    });

    expect(result.email).toEqual(expect.objectContaining({ ok: false }));
  });
});

describe('NotificationSettingsManager', () => {
  let db: CalameDatabase;
  let cleanup: () => void;

  beforeEach(() => {
    const fresh = makeFreshDb();
    db = fresh.db;
    cleanup = fresh.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('returns default settings for a tenant with no stored row', () => {
    const mgr = new NotificationSettingsManager(db);
    const settings = mgr.getSettings('nobody');
    expect(settings).toEqual({
      webhookUrl: undefined,
      webhookSecret: undefined,
      webhookFormat: 'json',
      webhookEnabled: false,
      emailRecipients: [],
      emailEnabled: false,
    });
  });

  it('round-trips settings including the webhook secret', () => {
    const mgr = new NotificationSettingsManager(db);
    const settings: NotificationSettings = {
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'topsecret-value',
      webhookFormat: 'slack',
      webhookEnabled: true,
      emailRecipients: ['a@example.com'],
      emailEnabled: true,
    };
    mgr.saveSettings(settings, 'tenant-a');

    const loaded = mgr.getSettings('tenant-a');
    expect(loaded).toEqual(settings);
  });

  it('encrypts the webhook secret at rest', () => {
    const mgr = new NotificationSettingsManager(db);
    mgr.saveSettings(
      {
        webhookUrl: 'https://example.com/hook',
        webhookSecret: 'topsecret-value',
        webhookFormat: 'json',
        webhookEnabled: true,
        emailRecipients: [],
        emailEnabled: false,
      },
      'tenant-b',
    );

    const row = db.raw
      .prepare('SELECT value FROM notification_settings WHERE key = ?')
      .get('tenant-b') as { value: string };
    const stored = JSON.parse(row.value) as { webhookSecretEncrypted?: string };
    expect(stored.webhookSecretEncrypted).toBeDefined();
    expect(stored.webhookSecretEncrypted).not.toBe('topsecret-value');
    expect(row.value).not.toContain('topsecret-value');
  });

  it('keeps per-tenant settings isolated', () => {
    const mgr = new NotificationSettingsManager(db);
    mgr.saveSettings(
      {
        webhookFormat: 'json',
        webhookEnabled: true,
        webhookUrl: 'https://a.example.com',
        emailRecipients: [],
        emailEnabled: false,
      },
      'tenant-a',
    );
    mgr.saveSettings(
      {
        webhookFormat: 'json',
        webhookEnabled: false,
        webhookUrl: 'https://b.example.com',
        emailRecipients: [],
        emailEnabled: false,
      },
      'tenant-b',
    );

    expect(mgr.getSettings('tenant-a').webhookUrl).toBe('https://a.example.com');
    expect(mgr.getSettings('tenant-b').webhookUrl).toBe('https://b.example.com');
  });
});
