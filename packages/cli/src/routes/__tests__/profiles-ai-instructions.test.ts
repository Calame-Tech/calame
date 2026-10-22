import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { UserManager } from '../../user.js';
import { CalameDatabase } from '../../database.js';
import { AuditLog } from '../../audit.js';
import { createSession } from '../../session.js';
import {
  AI_INSTRUCTIONS_MAX_LENGTH,
  getProfileAiInstructions,
  validateAiInstructions,
} from '../../profile-ai-instructions.js';
import { setupAdminAndGetCookie } from './helpers.js';

const INSTRUCTIONS =
  "Lis d'abord 00-LISEZ-MOI.md.\nPour ajouter à une note, utilise rag_append_note ; rag_write_document seulement pour remplacer un fichier.";

describe('validateAiInstructions / getProfileAiInstructions', () => {
  it('accepts text up to the limit, trims it, and treats null/undefined as cleared', () => {
    expect(validateAiInstructions('  hello  ')).toEqual({ ok: true, value: 'hello' });
    expect(validateAiInstructions('x'.repeat(AI_INSTRUCTIONS_MAX_LENGTH))).toMatchObject({
      ok: true,
    });
    expect(validateAiInstructions(undefined)).toEqual({ ok: true, value: '' });
    expect(validateAiInstructions(null)).toEqual({ ok: true, value: '' });
  });

  it('rejects non-string values and text over 4000 characters without truncating', () => {
    expect(validateAiInstructions(42)).toMatchObject({
      ok: false,
      code: 'ai_instructions_invalid',
    });
    const tooLong = validateAiInstructions('x'.repeat(AI_INSTRUCTIONS_MAX_LENGTH + 1));
    expect(tooLong).toMatchObject({ ok: false, code: 'ai_instructions_too_long' });
    if (!tooLong.ok) expect(tooLong.message).toContain('4000');
  });

  it('returns undefined for absent, empty or whitespace-only instructions', () => {
    expect(AI_INSTRUCTIONS_MAX_LENGTH).toBe(4000);
    expect(getProfileAiInstructions(undefined)).toBeUndefined();
    expect(getProfileAiInstructions({})).toBeUndefined();
    expect(getProfileAiInstructions({ aiInstructions: '' })).toBeUndefined();
    expect(getProfileAiInstructions({ aiInstructions: ' \n\t ' })).toBeUndefined();
    expect(getProfileAiInstructions({ aiInstructions: 42 })).toBeUndefined();
    expect(getProfileAiInstructions({ aiInstructions: ' a ' })).toBe('a');
  });
});

describe('profile AI instructions routes', () => {
  let app: ReturnType<typeof createApp>;
  let originalCwd: string;
  let tmpDir: string;
  let db: CalameDatabase;
  let state: AppState;
  let cookie: string;

  function readStored(tenantId = 'default'): Record<string, Record<string, unknown>> {
    const row = db.raw
      .prepare("SELECT data FROM profiles WHERE key = 'main' AND tenant_id = ?")
      .get(tenantId) as { data: string } | undefined;
    return (JSON.parse(row!.data) as { profiles: Record<string, Record<string, unknown>> })
      .profiles;
  }

  function seed(profiles: Record<string, unknown>, tenantId = 'default'): void {
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data, tenant_id) VALUES ('main', ?, ?)")
      .run(JSON.stringify({ profiles }), tenantId);
  }

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calame-ai-instructions-test-'));
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    state.auditLog = new AuditLog(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('compatibility', () => {
    it('loads a legacy profile without the field and leaves it without instructions', async () => {
      seed({ legacy: { label: 'Legacy', connections: ['default'], selectedTables: {} } });

      const res = await request(app).get('/api/profiles/load').set('Cookie', cookie).expect(200);
      expect(res.body.found).toBe(true);
      expect(res.body.profiles.legacy.aiInstructions).toBeUndefined();
      expect(getProfileAiInstructions(res.body.profiles.legacy)).toBeUndefined();
    });

    it('saving a legacy profile without the field does not add one nor audit anything', async () => {
      seed({ legacy: { label: 'Legacy', sources: ['default'] } });

      await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send({ profiles: { legacy: { label: 'Legacy v2' } } })
        .expect(200);

      const stored = readStored();
      expect(stored.legacy.label).toBe('Legacy v2');
      expect('aiInstructions' in stored.legacy).toBe(false);
      expect(state.auditLog!.getEntries().entries).toHaveLength(0);
    });
  });

  describe('POST /api/profiles/save', () => {
    it('persists instructions (trimmed) and returns them on load', async () => {
      await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send({ profiles: { docs: { label: 'Docs', aiInstructions: `  ${INSTRUCTIONS}\n` } } })
        .expect(200);

      expect(readStored().docs.aiInstructions).toBe(INSTRUCTIONS);
      const res = await request(app).get('/api/profiles/load').set('Cookie', cookie).expect(200);
      expect(res.body.profiles.docs.aiInstructions).toBe(INSTRUCTIONS);
    });

    it('keeps existing instructions when a save omits the field', async () => {
      seed({ docs: { label: 'Docs', aiInstructions: INSTRUCTIONS } });

      await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send({ profiles: { docs: { label: 'Docs renamed' } } })
        .expect(200);

      expect(readStored().docs.aiInstructions).toBe(INSTRUCTIONS);
    });

    it('stores whitespace-only instructions as an absent field', async () => {
      seed({ docs: { label: 'Docs', aiInstructions: INSTRUCTIONS } });

      await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send({ profiles: { docs: { label: 'Docs', aiInstructions: '   \n ' } } })
        .expect(200);

      expect('aiInstructions' in readStored().docs).toBe(false);
    });

    it('refuses instructions over 4000 characters with an explicit error and saves nothing', async () => {
      seed({ docs: { label: 'Docs', aiInstructions: INSTRUCTIONS } });
      const before = readStored();

      const res = await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send({
          profiles: {
            other: { label: 'Other renamed' },
            docs: { label: 'Changed', aiInstructions: 'y'.repeat(AI_INSTRUCTIONS_MAX_LENGTH + 1) },
          },
        })
        .expect(400);

      expect(res.body).toMatchObject({
        success: false,
        code: 'ai_instructions_too_long',
        field: 'aiInstructions',
        profile: 'docs',
      });
      expect(res.body.message).toContain('4000');
      expect(readStored()).toEqual(before);
      expect(state.auditLog!.getEntries().entries).toHaveLength(0);
    });

    it('refuses a non-string value', async () => {
      const res = await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send({ profiles: { docs: { label: 'Docs', aiInstructions: { evil: true } } } })
        .expect(400);
      expect(res.body.code).toBe('ai_instructions_invalid');
    });

    it('audits the change with the field name but without the instructions text', async () => {
      seed({ docs: { label: 'Docs' }, other: { label: 'Other' } });

      await request(app)
        .post('/api/profiles/save')
        .set('Cookie', cookie)
        .send({ profiles: { docs: { label: 'Docs', aiInstructions: INSTRUCTIONS } } })
        .expect(200);

      const { entries } = state.auditLog!.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        profileName: 'docs',
        toolName: 'profile.updated',
        toolArgs: { field: 'aiInstructions' },
        result: 'success',
      });
      expect(JSON.stringify(entries)).not.toContain('LISEZ-MOI');
    });
  });

  describe('PATCH /api/profiles/:name/ai-instructions', () => {
    it('sets, then clears, the instructions of one profile only', async () => {
      seed({ docs: { label: 'Docs' }, other: { label: 'Other' } });

      const res = await request(app)
        .patch('/api/profiles/docs/ai-instructions')
        .set('Cookie', cookie)
        .send({ aiInstructions: INSTRUCTIONS })
        .expect(200);
      expect(res.body.profile.aiInstructions).toBe(INSTRUCTIONS);
      expect(readStored().docs.aiInstructions).toBe(INSTRUCTIONS);
      expect(readStored().other.aiInstructions).toBeUndefined();

      await request(app)
        .patch('/api/profiles/docs/ai-instructions')
        .set('Cookie', cookie)
        .send({ aiInstructions: '' })
        .expect(200);
      expect('aiInstructions' in readStored().docs).toBe(false);

      const { entries } = state.auditLog!.getEntries();
      expect(entries.map((e) => e.resultSummary)).toEqual([
        'AI instructions cleared for profile "docs"',
        'AI instructions updated for profile "docs"',
      ]);
      expect(JSON.stringify(entries)).not.toContain('LISEZ-MOI');
    });

    it('reflects the change in an already loaded serve profile', async () => {
      seed({ docs: { label: 'Docs' } });
      state.serveProfiles.docs = { name: 'docs', label: 'Docs' };

      await request(app)
        .patch('/api/profiles/docs/ai-instructions')
        .set('Cookie', cookie)
        .send({ aiInstructions: INSTRUCTIONS })
        .expect(200);
      expect(state.serveProfiles.docs.aiInstructions).toBe(INSTRUCTIONS);
    });

    it('refuses over-limit text without touching the stored profile', async () => {
      seed({ docs: { label: 'Docs', aiInstructions: INSTRUCTIONS } });

      const res = await request(app)
        .patch('/api/profiles/docs/ai-instructions')
        .set('Cookie', cookie)
        .send({ aiInstructions: 'z'.repeat(AI_INSTRUCTIONS_MAX_LENGTH + 1) })
        .expect(400);
      expect(res.body.code).toBe('ai_instructions_too_long');
      expect(readStored().docs.aiInstructions).toBe(INSTRUCTIONS);
    });

    it('returns 400 when the field is missing and 404 for an unknown profile', async () => {
      seed({ docs: { label: 'Docs' } });
      await request(app)
        .patch('/api/profiles/docs/ai-instructions')
        .set('Cookie', cookie)
        .send({})
        .expect(400);
      await request(app)
        .patch('/api/profiles/nope/ai-instructions')
        .set('Cookie', cookie)
        .send({ aiInstructions: 'x' })
        .expect(404);
    });

    it("does not reach another tenant's profiles", async () => {
      seed({ docs: { label: 'Docs' } }, 'acme-corp');

      await request(app)
        .patch('/api/profiles/docs/ai-instructions')
        .set('Cookie', cookie)
        .send({ aiInstructions: INSTRUCTIONS })
        .expect(404);
      expect(readStored('acme-corp').docs.aiInstructions).toBeUndefined();
    });
  });

  describe('authorization', () => {
    it('refuses unauthenticated requests on both write paths', async () => {
      seed({ docs: { label: 'Docs' } });

      await request(app)
        .patch('/api/profiles/docs/ai-instructions')
        .send({ aiInstructions: INSTRUCTIONS })
        .expect(401);
      await request(app)
        .post('/api/profiles/save')
        .send({ profiles: { docs: { label: 'Docs', aiInstructions: INSTRUCTIONS } } })
        .expect(401);
      expect(readStored().docs.aiInstructions).toBeUndefined();
    });

    it('refuses a non-admin user session', async () => {
      seed({ docs: { label: 'Docs' } });
      const user = state.userManager!.createUser({
        name: 'Throwaway Member',
        email: 'member-ai-instructions@example.test',
        role: 'user',
        profiles: [
          { profileName: 'docs', allowedTables: null, allowedTools: null, accessMode: 'mcp' },
        ],
      });
      const userCookie = `calame_session=${createSession(user.id)}`;

      await request(app)
        .patch('/api/profiles/docs/ai-instructions')
        .set('Cookie', userCookie)
        .send({ aiInstructions: INSTRUCTIONS })
        .expect(403);
      await request(app)
        .post('/api/profiles/save')
        .set('Cookie', userCookie)
        .send({ profiles: { docs: { label: 'Docs', aiInstructions: INSTRUCTIONS } } })
        .expect(403);
      expect(readStored().docs.aiInstructions).toBeUndefined();
      expect(state.auditLog!.getEntries().entries).toHaveLength(0);
    });
  });
});
