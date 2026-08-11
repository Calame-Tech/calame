import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { TokenManager } from '../../token.js';
import { UserManager } from '../../user.js';
import { loadConfig } from '../../config.js';
import { setupAdminAndGetCookie } from './helpers.js';

describe('claude-desktop integration routes', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let originalCwd: string;
  let tmpDir: string;
  let claudeConfigDir: string;
  let cookie: string;
  let db: CalameDatabase;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-claude-desktop-test-${Date.now()}-${Math.random()}`);
    claudeConfigDir = path.join(tmpDir, 'fake-claude-config-dir');
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.tokenManager = new TokenManager(db);
    state.userManager = new UserManager(db);

    const config = loadConfig();
    // Never touch the real per-user Claude Desktop config while testing —
    // point the integration at a throwaway temp directory instead (see
    // AppConfig.claudeDesktopConfigDir / CALAME_CLAUDE_DESKTOP_CONFIG_DIR).
    config.claudeDesktopConfigDir = claudeConfigDir;
    config.port = 4567;
    config.packaged = false;
    state.config = config;

    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function seedActiveProfile(name: string): void {
    // Mirrors how other route tests (e.g. serve-empty-profile.test.ts) mark a
    // profile active without going through the full /api/serve/start flow
    // (which requires a live DB connection or knowledge source neither of
    // which this test needs).
    state.serveProfiles = { ...state.serveProfiles, [name]: { name } as never };
    state.activeProfileNames.add(name);
  }

  // ---------------------------------------------------------------------------
  // GET /api/integrations/claude-desktop/status
  // ---------------------------------------------------------------------------

  describe('GET /api/integrations/claude-desktop/status', () => {
    it('requires admin auth', async () => {
      await request(app).get('/api/integrations/claude-desktop/status').expect(401);
    });

    it('reports not detected and no entries when the Claude config dir does not exist', async () => {
      const res = await request(app)
        .get('/api/integrations/claude-desktop/status')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body).toMatchObject({
        success: true,
        supported: true,
        detected: false,
        entries: [],
      });
      expect(res.body.configPath).toBe(path.join(claudeConfigDir, 'claude_desktop_config.json'));
    });

    it('reports detected once the config dir exists, and resolves profileName for our own entries', async () => {
      seedActiveProfile('prod');
      await fs.mkdir(claudeConfigDir, { recursive: true });
      const configPath = path.join(claudeConfigDir, 'claude_desktop_config.json');
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            'calame-prod': { command: 'node', args: ['x'] },
            'some-other-tool': { command: 'npx', args: ['-y', 'other-mcp'] },
          },
        }),
      );

      const res = await request(app)
        .get('/api/integrations/claude-desktop/status')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.detected).toBe(true);
      const byKey = Object.fromEntries(
        (res.body.entries as Array<{ key: string; profileName: string | null }>).map((e) => [
          e.key,
          e.profileName,
        ]),
      );
      expect(byKey['calame-prod']).toBe('prod');
      expect(byKey['some-other-tool']).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/integrations/claude-desktop/connect
  // ---------------------------------------------------------------------------

  describe('POST /api/integrations/claude-desktop/connect', () => {
    it('requires admin auth', async () => {
      await request(app)
        .post('/api/integrations/claude-desktop/connect')
        .send({ profileName: 'prod' })
        .expect(401);
    });

    it('requires profileName', async () => {
      const res = await request(app)
        .post('/api/integrations/claude-desktop/connect')
        .set('Cookie', cookie)
        .send({})
        .expect(400);
      expect(res.body.success).toBe(false);
    });

    it('404s when the profile does not exist', async () => {
      const res = await request(app)
        .post('/api/integrations/claude-desktop/connect')
        .set('Cookie', cookie)
        .send({ profileName: 'ghost' })
        .expect(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('ghost');
    });

    it('400s when the profile exists but is not active', async () => {
      db.raw
        .prepare(`INSERT INTO profiles (key, data, tenant_id) VALUES ('main', ?, 'default')`)
        .run(JSON.stringify({ profiles: { inactive: {} } }));

      const res = await request(app)
        .post('/api/integrations/claude-desktop/connect')
        .set('Cookie', cookie)
        .send({ profileName: 'inactive' })
        .expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('not active');
    });

    it('mints a token, writes the merged config, and is reflected in /api/tokens', async () => {
      seedActiveProfile('prod');

      const res = await request(app)
        .post('/api/integrations/claude-desktop/connect')
        .set('Cookie', cookie)
        .send({ profileName: 'prod' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.serverKey).toBe('calame-prod');
      const expectedConfigPath = path.join(claudeConfigDir, 'claude_desktop_config.json');
      expect(res.body.configPath).toBe(expectedConfigPath);

      const written = JSON.parse(await fs.readFile(expectedConfigPath, 'utf-8'));
      const entry = written.mcpServers['calame-prod'];
      expect(entry.command).toBe(process.execPath);
      expect(entry.args[0]).toContain('mcp-remote');
      expect(entry.args[1]).toBe('http://127.0.0.1:4567/mcp/prod');
      expect(entry.args[2]).toBe('--header');
      expect(entry.args[3]).toMatch(/^Authorization: Bearer fmcp_[0-9a-f]+$/);

      // The minted token must show up through the existing tokens API, so
      // it stays revocable exactly like any other token.
      const tokensRes = await request(app).get('/api/tokens').set('Cookie', cookie).expect(200);
      const labels = tokensRes.body.tokens.map((t: { label: string }) => t.label);
      expect(labels).toContain('claude-desktop:prod');
    });

    it('merges without clobbering an existing unrelated entry, and writes a .bak', async () => {
      seedActiveProfile('prod');
      await fs.mkdir(claudeConfigDir, { recursive: true });
      const configPath = path.join(claudeConfigDir, 'claude_desktop_config.json');
      await fs.writeFile(
        configPath,
        JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', 'x'] } } }),
      );

      await request(app)
        .post('/api/integrations/claude-desktop/connect')
        .set('Cookie', cookie)
        .send({ profileName: 'prod' })
        .expect(200);

      const written = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      expect(written.mcpServers.filesystem).toEqual({ command: 'npx', args: ['-y', 'x'] });
      expect(written.mcpServers['calame-prod']).toBeDefined();

      const siblings = await fs.readdir(claudeConfigDir);
      expect(siblings.some((f) => f.endsWith('.bak'))).toBe(true);
    });

    it('400s on a corrupt existing config file and does not overwrite it', async () => {
      seedActiveProfile('prod');
      await fs.mkdir(claudeConfigDir, { recursive: true });
      const configPath = path.join(claudeConfigDir, 'claude_desktop_config.json');
      await fs.writeFile(configPath, '{ not valid json');

      const res = await request(app)
        .post('/api/integrations/claude-desktop/connect')
        .set('Cookie', cookie)
        .send({ profileName: 'prod' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('not valid JSON');
      expect(await fs.readFile(configPath, 'utf-8')).toBe('{ not valid json');
      const siblings = await fs.readdir(claudeConfigDir);
      expect(siblings.some((f) => f.endsWith('.bak'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/integrations/claude-desktop/snippet
  // ---------------------------------------------------------------------------

  describe('GET /api/integrations/claude-desktop/snippet', () => {
    it('requires admin auth', async () => {
      await request(app)
        .get('/api/integrations/claude-desktop/snippet')
        .query({ profileName: 'prod' })
        .expect(401);
    });

    it('requires profileName', async () => {
      const res = await request(app)
        .get('/api/integrations/claude-desktop/snippet')
        .set('Cookie', cookie)
        .expect(400);
      expect(res.body.success).toBe(false);
    });

    it('returns an npx-based snippet with placeholders and does not mint a token', async () => {
      const res = await request(app)
        .get('/api/integrations/claude-desktop/snippet')
        .set('Cookie', cookie)
        .query({ profileName: 'prod' })
        .expect(200);

      expect(res.body.success).toBe(true);
      const snippet = JSON.parse(res.body.snippet);
      const entry = snippet.mcpServers['calame-prod'];
      expect(entry.command).toBe('npx');
      expect(entry.args).toEqual([
        '-y',
        'mcp-remote',
        'http://<YOUR-CALAME-HOST>/mcp/prod',
        '--header',
        'Authorization: Bearer <TOKEN>',
      ]);

      const tokensRes = await request(app).get('/api/tokens').set('Cookie', cookie).expect(200);
      expect(tokensRes.body.tokens).toHaveLength(0);
    });

    it('qualifies the URL and server key with tenantId when provided', async () => {
      const res = await request(app)
        .get('/api/integrations/claude-desktop/snippet')
        .set('Cookie', cookie)
        .query({ profileName: 'prod', tenantId: 'acme-corp' })
        .expect(200);

      const snippet = JSON.parse(res.body.snippet);
      expect(snippet.mcpServers['calame-acme-corp-prod'].args[2]).toBe(
        'http://<YOUR-CALAME-HOST>/mcp/acme-corp/prod',
      );
    });

    it('rejects a malformed tenantId', async () => {
      const res = await request(app)
        .get('/api/integrations/claude-desktop/snippet')
        .set('Cookie', cookie)
        .query({ profileName: 'prod', tenantId: 'has a space' })
        .expect(400);
      expect(res.body.success).toBe(false);
    });
  });
});
