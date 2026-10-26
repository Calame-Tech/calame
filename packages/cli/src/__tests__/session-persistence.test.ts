// Point 01 (desktop tester): the admin had to log in again on every app
// opening because sessions lived in memory and the desktop app restarts its
// server sidecar each time. Sessions are now persisted (hashed) in SQLite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalameDatabase } from '../database.js';
import {
  configureSessionStore,
  createSession,
  destroySession,
  destroyUserSessions,
  renewSession,
  validateSession,
} from '../session.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('persistent sessions', () => {
  let tmpDir: string;
  let db: CalameDatabase;

  /** Simulates closing then reopening the desktop app (new server process). */
  function restartServer(): void {
    configureSessionStore(null);
    db.close();
    db = new CalameDatabase(tmpDir);
    configureSessionStore(db);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-session-test-'));
    db = new CalameDatabase(tmpDir);
    configureSessionStore(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    configureSessionStore(null);
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps a valid session across a server restart', () => {
    const id = createSession('user-a');
    restartServer();
    expect(validateSession(id)?.userId).toBe('user-a');
  });

  it('never stores the raw session ID', () => {
    const id = createSession('user-a');
    const rows = db.raw.prepare('SELECT * FROM auth_sessions').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(id);
  });

  it('rejects and purges an expired session, even after a restart', () => {
    vi.useFakeTimers();
    const id = createSession('user-a');
    vi.setSystemTime(Date.now() + DAY + 1);
    restartServer();
    expect(validateSession(id)).toBeNull();
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 });
  });

  it('logout (destroySession) survives a restart', () => {
    const id = createSession('user-a');
    destroySession(id);
    restartServer();
    expect(validateSession(id)).toBeNull();
  });

  it('revokes every session of one account only', () => {
    const a1 = createSession('user-a');
    const a2 = createSession('user-a');
    const b = createSession('user-b');
    destroyUserSessions('user-a', a1);
    expect(validateSession(a1)?.userId).toBe('user-a');
    expect(validateSession(a2)).toBeNull();
    expect(validateSession(b)?.userId).toBe('user-b');
    destroyUserSessions('user-a');
    expect(validateSession(a1)).toBeNull();
  });

  it('renews a valid session up to its absolute lifetime', () => {
    vi.useFakeTimers();
    const start = Date.now();
    const id = createSession('user-a');

    // Opened every 20 hours: each renewal pushes the expiry a full day out.
    for (let t = 20 * HOUR; t < 6 * DAY; t += 20 * HOUR) {
      vi.setSystemTime(start + t);
      expect(renewSession(id)?.expiresAt).toBe(start + t + DAY);
    }
    // …but never past 7 days after login.
    vi.setSystemTime(start + 6.5 * DAY);
    expect(renewSession(id)?.expiresAt).toBe(start + 7 * DAY);
    vi.setSystemTime(start + 7 * DAY + 1);
    expect(renewSession(id)).toBeNull();
  });

  it('does not renew an unknown or expired session', () => {
    vi.useFakeTimers();
    const id = createSession('user-a');
    vi.setSystemTime(Date.now() + DAY + 1);
    expect(renewSession(id)).toBeNull();
    expect(renewSession('unknown')).toBeNull();
  });
});
