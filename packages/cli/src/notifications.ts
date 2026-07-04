import crypto from 'crypto';
import type { Database, Statement } from 'better-sqlite3';
import type { CalameDatabase } from './database.js';
import type { SmtpConfig } from './smtp-config.js';
import { EmailService } from './email.js';
import { encryptString, decryptString, deriveKeyFromEnv } from './crypto.js';
import { DEFAULT_TENANT_ID } from './tenancy.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface NotificationSettings {
  webhookUrl?: string;
  webhookSecret?: string;
  webhookFormat: 'json' | 'slack';
  webhookEnabled: boolean;
  emailRecipients: string[];
  emailEnabled: boolean;
}

/** On-disk shape of `notification_settings.value` — the secret is encrypted at rest. */
interface StoredNotificationSettings {
  webhookUrl?: string;
  webhookSecretEncrypted?: string;
  webhookFormat: 'json' | 'slack';
  webhookEnabled: boolean;
  emailRecipients: string[];
  emailEnabled: boolean;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  webhookFormat: 'json',
  webhookEnabled: false,
  emailRecipients: [],
  emailEnabled: false,
};

/**
 * Per-tenant notification settings (webhook + email channels), stored one
 * key/value row PER TENANT — mirrors the `branding` table (migration v13):
 * `key` is the tenant id, `value` is a JSON blob.
 *
 * `webhookSecret` is encrypted at rest with the process encryption key (same
 * AES-256-GCM primitive `rag-runtime.ts` uses for RAG source configs — see
 * `deriveKeyFromEnv()`/`encryptString()` in `crypto.ts`). Note: `SmtpConfigManager`
 * stores its `pass` field in plaintext (only masked for API display), but the
 * webhook secret is a shared HMAC key rather than a login credential, so it is
 * encrypted here for defense-in-depth.
 */
export class NotificationSettingsManager {
  private db: Database;
  private stmtGet: Statement;
  private stmtUpsert: Statement;

  constructor(database: CalameDatabase) {
    this.db = database.raw;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notification_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.stmtGet = this.db.prepare('SELECT value FROM notification_settings WHERE key = ?');
    this.stmtUpsert = this.db.prepare(
      `INSERT INTO notification_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  }

  getSettings(tenantId: string = DEFAULT_TENANT_ID): NotificationSettings {
    const row = this.stmtGet.get(tenantId) as { value: string } | undefined;
    if (!row) return { ...DEFAULT_SETTINGS, emailRecipients: [] };

    let stored: StoredNotificationSettings;
    try {
      stored = JSON.parse(row.value) as StoredNotificationSettings;
    } catch {
      return { ...DEFAULT_SETTINGS, emailRecipients: [] };
    }

    let webhookSecret: string | undefined;
    if (stored.webhookSecretEncrypted) {
      try {
        webhookSecret = decryptString(stored.webhookSecretEncrypted, deriveKeyFromEnv());
      } catch {
        webhookSecret = undefined;
      }
    }

    return {
      webhookUrl: stored.webhookUrl,
      webhookSecret,
      webhookFormat: stored.webhookFormat === 'slack' ? 'slack' : 'json',
      webhookEnabled: !!stored.webhookEnabled,
      emailRecipients: Array.isArray(stored.emailRecipients) ? stored.emailRecipients : [],
      emailEnabled: !!stored.emailEnabled,
    };
  }

  saveSettings(settings: NotificationSettings, tenantId: string = DEFAULT_TENANT_ID): void {
    const stored: StoredNotificationSettings = {
      webhookUrl: settings.webhookUrl,
      webhookSecretEncrypted: settings.webhookSecret
        ? encryptString(settings.webhookSecret, deriveKeyFromEnv())
        : undefined,
      webhookFormat: settings.webhookFormat === 'slack' ? 'slack' : 'json',
      webhookEnabled: !!settings.webhookEnabled,
      emailRecipients: settings.emailRecipients ?? [],
      emailEnabled: !!settings.emailEnabled,
    };
    this.stmtUpsert.run(tenantId, JSON.stringify(stored));
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** A notification-worthy event. Only one type exists today — the write-queue gaining a pending entry. */
export interface NotificationEvent {
  type: 'write_queue.pending';
  tenantId: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
}

export interface ChannelResult {
  ok: boolean;
  error?: string;
}

export interface DispatchResult {
  inApp: ChannelResult;
  webhook?: ChannelResult;
  email?: ChannelResult;
}

type SleepFn = (ms: number) => Promise<void>;

export interface NotificationDispatcherOptions {
  /** Injectable for tests — defaults to the global `fetch` (Node 18+). */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to a real `setTimeout`-based sleep. */
  sleep?: SleepFn;
}

/** Webhook POST timeout per attempt. */
const WEBHOOK_TIMEOUT_MS = 5000;
/** Backoff delays (ms) before each of the up-to-3 retries following the initial attempt. */
const RETRY_DELAYS_MS = [1000, 5000, 25000];

/**
 * Dispatches a notification event across the in-app / webhook / email
 * channels. Each channel is independently try/caught — a failure on one
 * channel (or all of them) NEVER throws back to the caller, since `dispatch`
 * is called from the hot write-request path (see `routes/serve/write-wiring.ts`)
 * and must not block or fail the MCP tool call that triggered it.
 */
export class NotificationDispatcher {
  private db: Database;
  private stmtInsertNotification: Statement;
  private settingsManager: NotificationSettingsManager;
  private getSmtpConfig: () => SmtpConfig | null;
  private fetchImpl: typeof fetch;
  private sleep: SleepFn;

  constructor(
    database: CalameDatabase,
    getSmtpConfig: () => SmtpConfig | null,
    options: NotificationDispatcherOptions = {},
  ) {
    this.db = database.raw;
    this.getSmtpConfig = getSmtpConfig;
    this.settingsManager = new NotificationSettingsManager(database);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    this.stmtInsertNotification = this.db.prepare(
      `INSERT INTO notifications (id, tenant_id, type, title, body, payload, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
  }

  /** Per-tenant webhook/email settings manager — also used directly by the notification-settings routes. */
  get settings(): NotificationSettingsManager {
    return this.settingsManager;
  }

  async dispatch(event: NotificationEvent): Promise<DispatchResult> {
    const settings = this.settingsManager.getSettings(event.tenantId);

    const result: DispatchResult = { inApp: this.dispatchInApp(event) };

    if (settings.webhookEnabled && settings.webhookUrl) {
      result.webhook = await this.dispatchWebhook(event, settings);
    }
    if (settings.emailEnabled && settings.emailRecipients.length > 0) {
      result.email = await this.dispatchEmail(event, settings);
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // In-app (always active)
  // -------------------------------------------------------------------------

  private dispatchInApp(event: NotificationEvent): ChannelResult {
    try {
      const id = crypto.randomUUID();
      this.stmtInsertNotification.run(
        id,
        event.tenantId,
        event.type,
        event.title,
        event.body,
        JSON.stringify(event.payload ?? {}),
        new Date().toISOString(),
      );
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[notifications] in-app dispatch failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  // -------------------------------------------------------------------------
  // Webhook (generic JSON w/ HMAC signature, or Slack incoming-webhook shape)
  // -------------------------------------------------------------------------

  private async dispatchWebhook(
    event: NotificationEvent,
    settings: NotificationSettings,
  ): Promise<ChannelResult> {
    try {
      const bodyStr = this.buildWebhookBody(event, settings);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.webhookFormat === 'json' && settings.webhookSecret) {
        const signature = crypto
          .createHmac('sha256', settings.webhookSecret)
          .update(bodyStr)
          .digest('hex');
        headers['X-Calame-Signature'] = `sha256=${signature}`;
      }

      let lastError = 'Unknown error';
      const maxAttempts = 1 + RETRY_DELAYS_MS.length; // 1 initial attempt + up to 3 retries
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await this.postWebhookOnce(settings.webhookUrl!, headers, bodyStr);
          return { ok: true };
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (attempt < maxAttempts - 1) {
            await this.sleep(RETRY_DELAYS_MS[attempt]);
          }
        }
      }
      console.warn(`[notifications] webhook dispatch failed after retries: ${lastError}`);
      return { ok: false, error: lastError };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[notifications] webhook dispatch failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  private buildWebhookBody(event: NotificationEvent, settings: NotificationSettings): string {
    if (settings.webhookFormat === 'slack') {
      return JSON.stringify({ text: `${event.title}\n${event.body}` });
    }
    return JSON.stringify({
      event: event.type,
      title: event.title,
      body: event.body,
      payload: event.payload,
      timestamp: new Date().toISOString(),
    });
  }

  private async postWebhookOnce(
    url: string,
    headers: Record<string, string>,
    bodyStr: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Webhook responded with status ${res.status}`);
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  // -------------------------------------------------------------------------
  // Email
  // -------------------------------------------------------------------------

  private async dispatchEmail(
    event: NotificationEvent,
    settings: NotificationSettings,
  ): Promise<ChannelResult> {
    try {
      const smtpConfig = this.getSmtpConfig();
      if (!smtpConfig?.host) {
        return { ok: false, error: 'SMTP is not configured.' };
      }
      const service = EmailService.fromSmtpConfig(smtpConfig);
      await service.sendNotification({
        to: settings.emailRecipients.join(', '),
        subject: event.title,
        text: event.body,
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[notifications] email dispatch failed: ${message}`);
      return { ok: false, error: message };
    }
  }
}
