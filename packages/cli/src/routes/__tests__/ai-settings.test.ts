import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { UserManager } from '../../user.js';
import { CalameDatabase } from '../../database.js';
import { AiSettingsManager } from '../../ai-config.js';
import { setupAdminAndGetCookie } from './helpers.js';

describe('ai-settings routes — local provider + rerank threading', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let originalCwd: string;
  let tmpDir: string;
  let db: CalameDatabase;
  let cookie: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-ai-settings-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    state.aiSettingsManager = new AiSettingsManager(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('POST /api/ai-settings — local provider', () => {
    // Note: a real CalameDatabase runs migrations on construction (see
    // beforeEach above), so the built-in "local" setting (migration v17,
    // Phase 6) already exists by the time every test in this file starts —
    // these tests create a SECOND local-provider setting under a different
    // name to exercise the POST validation path independently of it. See
    // the "built-in local setting" describe block below for the seeded row
    // itself and its DELETE/PUT guards.
    it('creates a local setting with no apiKey, dimensions resolved statically to 768, no network call', async () => {
      const res = await request(app)
        .post('/api/ai-settings')
        .set('Cookie', cookie)
        .send({
          name: 'local-2',
          label: 'Another local setting',
          provider: 'local',
          capabilities: ['embeddings'],
          embeddingModel: 'embeddinggemma-300m-q4',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.setting.provider).toBe('local');
      expect(res.body.setting.embeddingDimensions).toBe(768);
      expect(res.body.setting.configured).toBe(true);
    });

    it('rejects a local setting that also requests the chat capability', async () => {
      const res = await request(app)
        .post('/api/ai-settings')
        .set('Cookie', cookie)
        .send({
          name: 'local-2',
          label: 'Local',
          provider: 'local',
          capabilities: ['embeddings', 'chat'],
          embeddingModel: 'embeddinggemma-300m-q4',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('only supports the "embeddings" capability');
    });

    it('GET the created local setting exposes localModelAvailable as a boolean', async () => {
      await request(app)
        .post('/api/ai-settings')
        .set('Cookie', cookie)
        .send({
          name: 'local-2',
          label: 'Local',
          provider: 'local',
          capabilities: ['embeddings'],
          embeddingModel: 'embeddinggemma-300m-q4',
        })
        .expect(200);

      const res = await request(app)
        .get('/api/ai-settings/local-2')
        .set('Cookie', cookie)
        .expect(200);
      expect(typeof res.body.setting.localModelAvailable).toBe('boolean');
    });

    it('GET a non-local setting does not get a localModelAvailable field', async () => {
      await request(app)
        .post('/api/ai-settings')
        .set('Cookie', cookie)
        .send({
          name: 'openrouter-chat',
          label: 'OpenRouter',
          provider: 'openrouter',
          apiKey: 'sk-test',
          capabilities: ['chat'],
        })
        .expect(200);

      const res = await request(app)
        .get('/api/ai-settings/openrouter-chat')
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body.setting.localModelAvailable).toBeUndefined();
    });
  });

  describe('POST /api/ai-settings — rerank capability (bug fix regression)', () => {
    it('accepts and persists rerankModel — previously silently dropped', async () => {
      const res = await request(app)
        .post('/api/ai-settings')
        .set('Cookie', cookie)
        .send({
          name: 'cohere-rerank',
          label: 'Cohere Rerank',
          provider: 'custom',
          apiKey: 'sk-test',
          baseUrl: 'https://api.cohere.ai/v1',
          capabilities: ['rerank'],
          rerankModel: 'rerank-multilingual-v3.0',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.setting.rerankModel).toBe('rerank-multilingual-v3.0');

      // Re-fetch independently to confirm it round-trips through the DB,
      // not just echoed back from the request body.
      const getRes = await request(app)
        .get('/api/ai-settings/cohere-rerank')
        .set('Cookie', cookie)
        .expect(200);
      expect(getRes.body.setting.rerankModel).toBe('rerank-multilingual-v3.0');
    });

    it('rejects rerank capability without rerankModel', async () => {
      const res = await request(app)
        .post('/api/ai-settings')
        .set('Cookie', cookie)
        .send({
          name: 'cohere-rerank',
          label: 'Cohere Rerank',
          provider: 'custom',
          apiKey: 'sk-test',
          baseUrl: 'https://api.cohere.ai/v1',
          capabilities: ['rerank'],
        })
        .expect(400);
      expect(res.body.message).toContain('rerankModel is required');
    });

    it('PUT persists an updated rerankModel — previously silently dropped', async () => {
      await request(app)
        .post('/api/ai-settings')
        .set('Cookie', cookie)
        .send({
          name: 'cohere-rerank',
          label: 'Cohere Rerank',
          provider: 'custom',
          apiKey: 'sk-test',
          baseUrl: 'https://api.cohere.ai/v1',
          capabilities: ['rerank'],
          rerankModel: 'rerank-multilingual-v3.0',
        })
        .expect(200);

      const putRes = await request(app)
        .put('/api/ai-settings/cohere-rerank')
        .set('Cookie', cookie)
        .send({
          label: 'Cohere Rerank',
          provider: 'custom',
          apiKey: '***',
          baseUrl: 'https://api.cohere.ai/v1',
          capabilities: ['rerank'],
          rerankModel: 'rerank-english-v3.0',
        })
        .expect(200);
      expect(putRes.body.setting.rerankModel).toBe('rerank-english-v3.0');
    });
  });

  describe('built-in local setting (migration v17) — protected from deletion/modification', () => {
    it('already exists on a fresh DB with the expected shape', async () => {
      const res = await request(app)
        .get('/api/ai-settings/local')
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body.setting.provider).toBe('local');
      expect(res.body.setting.embeddingDimensions).toBe(768);
      expect(res.body.setting.configured).toBe(true);
    });

    it('DELETE is rejected with 400', async () => {
      const res = await request(app)
        .delete('/api/ai-settings/local')
        .set('Cookie', cookie)
        .expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('ne peut pas être supprimé');

      // Still there afterwards.
      await request(app).get('/api/ai-settings/local').set('Cookie', cookie).expect(200);
    });

    it('PUT changes only the label — every other field is silently ignored, not erroring', async () => {
      const res = await request(app)
        .put('/api/ai-settings/local')
        .set('Cookie', cookie)
        .send({
          label: 'Mon modèle local',
          provider: 'openrouter', // attempted hijack
          apiKey: 'sk-should-be-ignored',
          capabilities: ['chat'],
          embeddingModel: 'something-else',
        })
        .expect(200);

      expect(res.body.setting.label).toBe('Mon modèle local');
      expect(res.body.setting.provider).toBe('local');
      expect(res.body.setting.apiKey).toBe('');
      expect(res.body.setting.capabilities).toEqual(['embeddings']);
      expect(res.body.setting.embeddingModel).toBe('embeddinggemma-300m-q4');
    });

    it('PUT with no label keeps the existing one', async () => {
      const res = await request(app)
        .put('/api/ai-settings/local')
        .set('Cookie', cookie)
        .send({})
        .expect(200);
      expect(res.body.setting.label).toBe('Embeddings locaux (inclus)');
    });
  });
});
