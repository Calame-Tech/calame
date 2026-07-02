import type { Express } from 'express';
import type { AppState } from '../state.js';
import { EmailService } from '../email.js';
import { verifyPassword } from '../crypto.js';
import { validateSession } from '../session.js';
import { parseCookies } from '../utils/cookies.js';

export function registerSmtpSettingsRoute(app: Express, state: AppState): void {
  /** GET /api/smtp-settings — Return the current SMTP config (password masked). */
  app.get('/api/smtp-settings', (_req, res) => {
    const mgr = state.smtpConfigManager;
    if (!mgr) {
      res.json({ success: true, config: null });
      return;
    }
    res.json({ success: true, config: mgr.getMaskedConfig() });
  });

  /** POST /api/smtp-settings — Save SMTP config. */
  app.post('/api/smtp-settings', (req, res) => {
    const mgr = state.smtpConfigManager;
    if (!mgr) {
      res.status(500).json({ success: false, message: 'SMTP config manager not initialized.' });
      return;
    }

    const { host, port, user, pass, from } = req.body as {
      host?: unknown;
      port?: unknown;
      user?: unknown;
      pass?: unknown;
      from?: unknown;
    };

    if (!host || typeof host !== 'string') {
      res.status(400).json({ success: false, message: 'host is required.' });
      return;
    }

    const parsedPort = typeof port === 'number' ? port : parseInt(String(port), 10);
    if (!port || isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      res
        .status(400)
        .json({ success: false, message: 'port must be a valid port number (1-65535).' });
      return;
    }

    try {
      mgr.setConfig({
        host,
        port: parsedPort,
        user: typeof user === 'string' ? user : '',
        pass: typeof pass === 'string' ? pass : '',
        from: typeof from === 'string' ? from : '',
      });

      // Refresh the email service on state with the updated config
      const updatedConfig = mgr.getConfig();
      if (updatedConfig) {
        state.emailService = EmailService.fromSmtpConfig(updatedConfig);
      }

      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to save SMTP config.';
      res.status(500).json({ success: false, message });
    }
  });

  /** POST /api/smtp-settings/test — Test SMTP connection using transporter.verify(). */
  app.post('/api/smtp-settings/test', async (_req, res) => {
    const mgr = state.smtpConfigManager;
    if (!mgr || !mgr.isConfigured()) {
      res.status(400).json({ success: false, message: 'SMTP is not configured.' });
      return;
    }

    const config = mgr.getConfig()!;

    try {
      const service = EmailService.fromSmtpConfig(config);
      const ok = await service.testConnection();
      if (ok) {
        res.json({ success: true, message: 'SMTP connection verified successfully.' });
      } else {
        res
          .status(502)
          .json({ success: false, message: 'SMTP connection failed. Check your settings.' });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Connection test failed.';
      res.status(502).json({ success: false, message });
    }
  });

  /** POST /api/smtp-settings/reveal — Reveal SMTP password (requires admin password). */
  app.post('/api/smtp-settings/reveal', (req, res) => {
    const { password } = req.body as { password?: string };

    if (!password || typeof password !== 'string') {
      res.status(400).json({ success: false, message: 'Admin password is required.' });
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies.calame_session;
    if (!sessionId) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }
    const session = validateSession(sessionId);
    if (!session?.userId) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }

    const userManager = state.userManager;
    if (!userManager) {
      res.status(500).json({ success: false, message: 'User manager not initialized.' });
      return;
    }

    const user = userManager.getUserById(session.userId);
    if (!user || user.role !== 'admin') {
      res.status(403).json({ success: false, message: 'Admin access required.' });
      return;
    }

    const userRow = state.db?.raw
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(session.userId) as { password_hash: string | null } | undefined;

    if (!userRow?.password_hash || !verifyPassword(password, userRow.password_hash)) {
      res.status(403).json({ success: false, message: 'Incorrect password.' });
      return;
    }

    const mgr = state.smtpConfigManager;
    if (!mgr) {
      res.status(500).json({ success: false, message: 'SMTP config manager not initialized.' });
      return;
    }

    const config = mgr.getConfig();
    if (!config) {
      res.status(404).json({ success: false, message: 'No SMTP config found.' });
      return;
    }

    res.json({ success: true, pass: config.pass });
  });
}
