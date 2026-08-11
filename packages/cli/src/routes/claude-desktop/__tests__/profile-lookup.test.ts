import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { AppState } from '../../../state.js';
import { CalameDatabase } from '../../../database.js';
import { listProfileNamesForTenant, profileExistsForTenant } from '../profile-lookup.js';

describe('profile-lookup', () => {
  let tmpDir: string;
  let db: CalameDatabase;
  let state: AppState;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `calame-profile-lookup-test-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    db = new CalameDatabase(tmpDir);
    state = new AppState();
    state.db = db;
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns [] / false when nothing is loaded and the DB has no profiles row', () => {
    expect(listProfileNamesForTenant(state, 'default')).toEqual([]);
    expect(profileExistsForTenant(state, 'default', 'prod')).toBe(false);
  });

  it('falls back to a direct DB read for the default tenant when the in-memory cache is cold', () => {
    // Simulates a fresh boot: profiles exist in SQLite, but nothing has
    // called /api/serve/start or /api/serve/status yet in this process, so
    // state.serveProfiles is still empty.
    db.raw
      .prepare(`INSERT INTO profiles (key, data, tenant_id) VALUES ('main', ?, 'default')`)
      .run(JSON.stringify({ profiles: { prod: {}, staging: {} } }));

    expect(listProfileNamesForTenant(state, 'default').sort()).toEqual(['prod', 'staging']);
    expect(profileExistsForTenant(state, 'default', 'prod')).toBe(true);
    expect(profileExistsForTenant(state, 'default', 'nope')).toBe(false);
  });

  it('prefers the in-memory cache over the DB for the default tenant when warm', () => {
    // Cache says only "cached-profile" exists — even though the DB row (if
    // any) might say otherwise, the warm in-memory cache wins (matches the
    // rest of the app's existing default-tenant fast path, see
    // ../../serve/routing.ts).
    state.serveProfiles = { 'cached-profile': {} as never };
    db.raw
      .prepare(`INSERT INTO profiles (key, data, tenant_id) VALUES ('main', ?, 'default')`)
      .run(JSON.stringify({ profiles: { 'db-only-profile': {} } }));

    expect(listProfileNamesForTenant(state, 'default')).toEqual(['cached-profile']);
    expect(profileExistsForTenant(state, 'default', 'db-only-profile')).toBe(false);
  });

  it('reads fresh from the DB for a non-default tenant, ignoring the default-tenant cache', () => {
    state.serveProfiles = { 'default-tenant-profile': {} as never };
    db.raw
      .prepare(`INSERT INTO profiles (key, data, tenant_id) VALUES ('main', ?, 'acme-corp')`)
      .run(JSON.stringify({ profiles: { 'acme-profile': {} } }));

    expect(listProfileNamesForTenant(state, 'acme-corp')).toEqual(['acme-profile']);
    expect(profileExistsForTenant(state, 'acme-corp', 'acme-profile')).toBe(true);
    expect(profileExistsForTenant(state, 'acme-corp', 'default-tenant-profile')).toBe(false);
  });

  it('returns [] when state.db is not initialised', () => {
    const bareState = new AppState();
    expect(listProfileNamesForTenant(bareState, 'default')).toEqual([]);
  });
});
