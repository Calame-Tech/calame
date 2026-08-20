import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CalameDatabase } from '../database.js';
import {
  AiSettingsManager,
  ensureBuiltInSettings,
  findBuiltInLocalSetting,
  BUILT_IN_LOCAL_SETTING_NAME,
  BUILT_IN_LOCAL_SETTING_FALLBACK_NAME,
} from '../ai-config.js';

// ---------------------------------------------------------------------------
// Uses a REAL CalameDatabase (temp dir) rather than ai-config.test.ts's
// hand-mocked better-sqlite3 harness — that mock's INSERT handler assumes
// AiSettingsManager.stmtInsert's exact positional-arg shape, which
// seedBuiltInLocalSetting's raw SQL (fewer bound params, several literals)
// doesn't match. A real DB exercises the actual migration path instead —
// see built-in-local-setting-migration.test.ts for the v17-via-runMigrations
// integration test, which is what actually matters for a fresh install.
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: CalameDatabase;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-built-in-local-test-'));
  db = new CalameDatabase(tmpDir); // constructor already ran migrations, including v17
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ensureBuiltInSettings', () => {
  it('creates the built-in local setting with the expected fields', () => {
    const mgr = new AiSettingsManager(db);
    // The CalameDatabase constructor's own runMigrations() already seeded it
    // (v17) — assert on that, then prove the explicit call is a no-op too.
    const before = mgr.getSetting(BUILT_IN_LOCAL_SETTING_NAME);
    expect(before).not.toBeNull();
    expect(before!.provider).toBe('local');
    expect(before!.apiKey).toBe('');
    expect(before!.capabilities).toEqual(['embeddings']);
    expect(before!.embeddingDimensions).toBe(768);

    ensureBuiltInSettings(db);
    const after = mgr.getSetting(BUILT_IN_LOCAL_SETTING_NAME);
    expect(after).toEqual(before); // unchanged — INSERT OR IGNORE, not an upsert
  });

  it('is idempotent across repeated calls (no duplicate row, no throw)', () => {
    expect(() => {
      ensureBuiltInSettings(db);
      ensureBuiltInSettings(db);
      ensureBuiltInSettings(db);
    }).not.toThrow();
    const mgr = new AiSettingsManager(db);
    const localSettings = mgr.listSettings().filter((s) => s.provider === 'local');
    expect(localSettings).toHaveLength(1);
  });

  it('recovers the row after a user deletes it via direct SQL (self-heal)', () => {
    const mgr = new AiSettingsManager(db);
    mgr.deleteSetting(BUILT_IN_LOCAL_SETTING_NAME);
    expect(mgr.getSetting(BUILT_IN_LOCAL_SETTING_NAME)).toBeNull();

    ensureBuiltInSettings(db);
    expect(mgr.getSetting(BUILT_IN_LOCAL_SETTING_NAME)).not.toBeNull();
  });

  it('seeds under the fallback name when a conflicting non-local row already owns "local", without touching it', () => {
    const mgr = new AiSettingsManager(db);
    // Simulate: a user already had a custom setting literally named "local"
    // before this feature existed. Delete the built-in row first (as if this
    // were an upgrade where the user's own "local" row pre-dates v17) and
    // recreate the conflict from scratch.
    mgr.deleteSetting(BUILT_IN_LOCAL_SETTING_NAME);
    mgr.createSetting({
      name: BUILT_IN_LOCAL_SETTING_NAME,
      label: "My Own Setting Called Local",
      provider: 'custom',
      apiKey: 'sk-user',
      baseUrl: 'http://localhost:11434/v1',
    });

    const warn = vi.fn();
    ensureBuiltInSettings(db, { warn });

    // The user's row is untouched.
    const userRow = mgr.getSetting(BUILT_IN_LOCAL_SETTING_NAME);
    expect(userRow!.provider).toBe('custom');
    expect(userRow!.apiKey).toBe('sk-user');

    // The built-in seed landed under the fallback name instead.
    const fallbackRow = mgr.getSetting(BUILT_IN_LOCAL_SETTING_FALLBACK_NAME);
    expect(fallbackRow).not.toBeNull();
    expect(fallbackRow!.provider).toBe('local');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain(BUILT_IN_LOCAL_SETTING_NAME);
  });
});

describe('findBuiltInLocalSetting', () => {
  it('resolves the built-in setting by provider under its default name', () => {
    const mgr = new AiSettingsManager(db);
    const found = findBuiltInLocalSetting(mgr);
    expect(found).not.toBeNull();
    expect(found!.name).toBe(BUILT_IN_LOCAL_SETTING_NAME);
  });

  it('resolves it under the fallback name too — callers must never assume the literal name', () => {
    const mgr = new AiSettingsManager(db);
    mgr.deleteSetting(BUILT_IN_LOCAL_SETTING_NAME);
    mgr.createSetting({
      name: BUILT_IN_LOCAL_SETTING_NAME,
      label: 'User setting',
      provider: 'custom',
      apiKey: 'sk-user',
      baseUrl: 'http://localhost:11434/v1',
    });
    ensureBuiltInSettings(db);

    const found = findBuiltInLocalSetting(mgr);
    expect(found).not.toBeNull();
    expect(found!.name).toBe(BUILT_IN_LOCAL_SETTING_FALLBACK_NAME);
    expect(found!.provider).toBe('local');
  });

  it('returns null when no local-provider setting exists', () => {
    const mgr = new AiSettingsManager(db);
    mgr.deleteSetting(BUILT_IN_LOCAL_SETTING_NAME);
    expect(findBuiltInLocalSetting(mgr)).toBeNull();
  });
});

describe('fresh install: built-in local setting sorts first (becomes the default)', () => {
  it('sorts before a setting created afterwards, by created_at', () => {
    const mgr = new AiSettingsManager(db); // 'local' already seeded by the constructor's migration run
    mgr.createSetting({
      name: 'user-openrouter',
      label: 'User OpenRouter',
      provider: 'openrouter',
      apiKey: 'sk-test',
      capabilities: ['embeddings'],
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 1536,
    });
    // Force created_at strictly later without a real sleep — SQLite's
    // datetime('now') only has 1-second resolution, so two inserts in the
    // same test tick could otherwise tie.
    db.raw
      .prepare(`UPDATE ai_settings SET created_at = datetime('now', '+1 hour') WHERE name = ?`)
      .run('user-openrouter');

    const all = mgr.listSettings(); // ORDER BY created_at ASC, name ASC
    expect(all[0]!.provider).toBe('local');
  });
});
