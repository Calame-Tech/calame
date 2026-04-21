import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { AuditLog } from '../audit.js';
import { CalameDatabase } from '../database.js';

function makeEntry(overrides: Partial<{ profileName: string; toolName: string; result: 'success' | 'error' }> = {}) {
  return {
    profileName: overrides.profileName ?? 'default',
    toolName: overrides.toolName ?? 'query_users',
    toolArgs: {},
    result: overrides.result ?? ('success' as const),
    durationMs: 42,
  };
}

describe('AuditLog', () => {
  let tmpDir: string;
  let db: CalameDatabase;
  let audit: AuditLog;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `calame-audit-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    db = new CalameDatabase(tmpDir);
    audit = new AuditLog(db);
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('addEntry creates entry with id and timestamp', () => {
    const entry = audit.addEntry(makeEntry());
    expect(entry.id).toBeDefined();
    expect(entry.timestamp).toBeDefined();
    expect(entry.profileName).toBe('default');
    expect(entry.toolName).toBe('query_users');
  });

  it('addEntry trims old entries when maxEntries exceeded', () => {
    const smallAudit = new AuditLog(db, 3);
    smallAudit.addEntry(makeEntry({ toolName: 'tool1' }));
    smallAudit.addEntry(makeEntry({ toolName: 'tool2' }));
    smallAudit.addEntry(makeEntry({ toolName: 'tool3' }));
    smallAudit.addEntry(makeEntry({ toolName: 'tool4' }));

    const { entries, total } = smallAudit.getEntries();
    expect(total).toBe(3);
    // The oldest (tool1) should be trimmed; newest first so tool4 is first
    expect(entries[0].toolName).toBe('tool4');
    expect(entries[2].toolName).toBe('tool2');
  });

  it('getEntries returns entries newest first', () => {
    audit.addEntry(makeEntry({ toolName: 'first' }));
    audit.addEntry(makeEntry({ toolName: 'second' }));
    audit.addEntry(makeEntry({ toolName: 'third' }));

    const { entries } = audit.getEntries();
    expect(entries[0].toolName).toBe('third');
    expect(entries[2].toolName).toBe('first');
  });

  it('getEntries filters by profileName', () => {
    audit.addEntry(makeEntry({ profileName: 'alpha' }));
    audit.addEntry(makeEntry({ profileName: 'beta' }));
    audit.addEntry(makeEntry({ profileName: 'alpha' }));

    const { entries, total } = audit.getEntries({ profileName: 'alpha' });
    expect(total).toBe(2);
    expect(entries.every(e => e.profileName === 'alpha')).toBe(true);
  });

  it('getEntries filters by since date', () => {
    const e1 = audit.addEntry(makeEntry({ toolName: 'old' }));
    // Use the timestamp of the first entry as the cutoff
    const sinceDate = e1.timestamp;
    audit.addEntry(makeEntry({ toolName: 'new' }));

    const { entries } = audit.getEntries({ since: sinceDate });
    // Both should match since >= includes the boundary
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.every(e => e.timestamp >= sinceDate)).toBe(true);
  });

  it('getEntries paginates with limit/offset', () => {
    for (let i = 0; i < 10; i++) {
      audit.addEntry(makeEntry({ toolName: `tool${i}` }));
    }

    const { entries, total } = audit.getEntries({ limit: 3, offset: 2 });
    expect(total).toBe(10);
    expect(entries).toHaveLength(3);
    // Newest first, so offset 2 skips the two newest
    expect(entries[0].toolName).toBe('tool7');
  });

  it('exportCSV returns valid CSV', () => {
    audit.addEntry(makeEntry({ toolName: 'query_users', profileName: 'prod' }));
    const csv = audit.exportCSV();
    const lines = csv.split('\n');

    // Header line
    expect(lines[0]).toBe('id,timestamp,profileName,toolName,result,durationMs,resultSummary');
    // Data line
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('prod');
    expect(lines[1]).toContain('query_users');
  });

  it('exportJSON returns valid JSON', () => {
    audit.addEntry(makeEntry({ toolName: 'describe_orders' }));
    const json = audit.exportJSON();
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].toolName).toBe('describe_orders');
  });

  it('load/save are no-ops but data persists via SQLite', async () => {
    audit.addEntry(makeEntry({ toolName: 'persisted_tool' }));
    await audit.save();

    // A second AuditLog backed by the same DB file sees the same data
    const db2 = new CalameDatabase(tmpDir);
    const audit2 = new AuditLog(db2);
    await audit2.load();

    const { entries } = audit2.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].toolName).toBe('persisted_tool');
    db2.close();
  });

  it('load handles missing file gracefully (always empty on fresh DB)', async () => {
    const freshDir = path.join(os.tmpdir(), `calame-audit-fresh-${Date.now()}`);
    await fs.mkdir(freshDir, { recursive: true });
    const freshDb = new CalameDatabase(freshDir);
    const freshAudit = new AuditLog(freshDb);
    await freshAudit.load();
    const { entries } = freshAudit.getEntries();
    expect(entries).toHaveLength(0);
    freshDb.close();
    await fs.rm(freshDir, { recursive: true, force: true }).catch(() => {});
  });

  it('purgeOlderThan removes old entries and returns count', () => {
    // Insert an entry, then purge with 0 days (cutoff = now) — all entries older than "now"
    audit.addEntry(makeEntry({ toolName: 'old_tool' }));
    // Use a negative days value so cutoff is in the future, purging everything
    const deleted = audit.purgeOlderThan(-1);
    expect(deleted).toBe(1);
    const { total } = audit.getEntries();
    expect(total).toBe(0);
  });
});
