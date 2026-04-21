import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { AuditLog } from '../../audit.js';
import { CalameDatabase } from '../../database.js';
import { UserManager } from '../../user.js';
import { setupAdminAndGetCookie } from './helpers.js';

describe('audit routes', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let auditLog: AuditLog;
  let originalCwd: string;
  let tmpDir: string;
  let cookie: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-audit-route-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    const db = new CalameDatabase(tmpDir);
    state.db = db;
    auditLog = new AuditLog(db);
    state.auditLog = auditLog;
    state.userManager = new UserManager(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
  });

  afterEach(async () => {
    state.db?.close();
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('GET /api/audit', () => {
    it('returns entries', async () => {
      auditLog.addEntry({
        profileName: 'prod',
        toolName: 'query_users',
        toolArgs: {},
        result: 'success',
        durationMs: 10,
      });

      const res = await request(app)
        .get('/api/audit')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].toolName).toBe('query_users');
      expect(res.body.total).toBe(1);
    });

    it('filters by profileName', async () => {
      auditLog.addEntry({
        profileName: 'prod',
        toolName: 'query_users',
        toolArgs: {},
        result: 'success',
        durationMs: 10,
      });
      auditLog.addEntry({
        profileName: 'dev',
        toolName: 'query_orders',
        toolArgs: {},
        result: 'success',
        durationMs: 5,
      });

      const res = await request(app)
        .get('/api/audit?profileName=prod')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].profileName).toBe('prod');
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /api/audit/export', () => {
    beforeEach(() => {
      auditLog.addEntry({
        profileName: 'prod',
        toolName: 'describe_users',
        toolArgs: {},
        result: 'success',
        durationMs: 15,
      });
    });

    it('returns JSON', async () => {
      const res = await request(app)
        .get('/api/audit/export?format=json')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.headers['content-type']).toContain('application/json');
      const data = JSON.parse(res.text);
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(1);
      expect(data[0].toolName).toBe('describe_users');
    });

    it('returns CSV', async () => {
      const res = await request(app)
        .get('/api/audit/export?format=csv')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.text.split('\n');
      expect(lines[0]).toBe('id,timestamp,profileName,toolName,result,durationMs,resultSummary');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('describe_users');
    });
  });
});
