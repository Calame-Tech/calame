import type { Express } from 'express';
import type { AppState } from '../state.js';
import { verifyPassword, decrypt, getSecretKey } from '../crypto.js';
import { validateSession } from '../session.js';
import { parseCookies } from '../utils/cookies.js';

export function registerTokensRoute(app: Express, state: AppState): void {
  app.post('/api/tokens/generate', async (req, res) => {
    try {
      const { profileName, label } = req.body as { profileName?: string; label?: string };

      if (!profileName || typeof profileName !== 'string') {
        res.status(400).json({ success: false, message: 'profileName is required.' });
        return;
      }
      if (!label || typeof label !== 'string') {
        res.status(400).json({ success: false, message: 'label is required.' });
        return;
      }

      const tokenManager = state.tokenManager;
      if (!tokenManager) {
        res.status(500).json({ success: false, message: 'Token manager not initialized.' });
        return;
      }

      const entry = tokenManager.generateToken(profileName, label);
      await tokenManager.save();

      // Return the plaintext token ONCE at creation time — it is never retrievable after this
      res.json({
        success: true,
        token: {
          id: entry.id,
          plaintextToken: entry._plaintextToken,
          profileName: entry.profileName,
          label: entry.label,
          createdAt: entry.createdAt,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Generate error', { component: 'tokens', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  app.get('/api/tokens', async (_req, res) => {
    try {
      const tokenManager = state.tokenManager;
      if (!tokenManager) {
        res.status(500).json({ success: false, message: 'Token manager not initialized.' });
        return;
      }

      const tokens = tokenManager.getAllTokens();
      res.json({ success: true, tokens });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('List error', { component: 'tokens', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  app.delete('/api/tokens/:id', async (req, res) => {
    try {
      const tokenManager = state.tokenManager;
      if (!tokenManager) {
        res.status(500).json({ success: false, message: 'Token manager not initialized.' });
        return;
      }

      const { id } = req.params;
      const revoked = tokenManager.revokeToken(id);
      if (!revoked) {
        res.status(404).json({ success: false, message: 'Token not found.' });
        return;
      }

      await tokenManager.save();
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Revoke error', { component: 'tokens', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  app.get('/api/tokens/profile/:profileName', async (req, res) => {
    try {
      const tokenManager = state.tokenManager;
      if (!tokenManager) {
        res.status(500).json({ success: false, message: 'Token manager not initialized.' });
        return;
      }

      const { profileName } = req.params;
      const tokens = tokenManager.getTokensForProfile(profileName).map((t) => ({
        id: t.id,
        tokenHash: t.tokenHash.substring(0, 8) + '...',
        profileName: t.profileName,
        label: t.label,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
      }));
      res.json({ success: true, tokens });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Profile error', { component: 'tokens', error: message });
      res.status(500).json({ success: false, message });
    }
  });

  // POST /api/tokens/:id/reveal — Reveal a token in plaintext (requires admin password re-confirmation)
  app.post('/api/tokens/:id/reveal', async (req, res) => {
    try {
      const { password } = req.body as { password?: string };

      if (!password || typeof password !== 'string') {
        res.status(400).json({ success: false, message: 'Admin password is required.' });
        return;
      }

      const cookies = parseCookies(req.headers.cookie);
      const sessionId = cookies.calame_session as string | undefined;
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

      // Verify admin password against the stored hash
      const userRow = state.db?.raw
        .prepare('SELECT password_hash FROM users WHERE id = ?')
        .get(session.userId) as { password_hash: string | null } | undefined;

      if (!userRow?.password_hash || !verifyPassword(password, userRow.password_hash)) {
        res.status(403).json({ success: false, message: 'Incorrect password.' });
        return;
      }

      const tokenManager = state.tokenManager;
      if (!tokenManager) {
        res.status(500).json({ success: false, message: 'Token manager not initialized.' });
        return;
      }

      const encryptedToken = tokenManager.getEncryptedToken(req.params.id);
      if (!encryptedToken) {
        res.status(404).json({
          success: false,
          message:
            'Token not found or was created before encryption was enabled. Please regenerate it to enable reveal.',
        });
        return;
      }

      const secretKey = getSecretKey();
      if (!secretKey) {
        res.status(500).json({ success: false, message: 'Secret key not available.' });
        return;
      }

      const plaintext = decrypt(encryptedToken, secretKey);
      res.json({ success: true, token: plaintext });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Reveal error', { component: 'tokens', error: message });
      res.status(500).json({ success: false, message });
    }
  });
}
