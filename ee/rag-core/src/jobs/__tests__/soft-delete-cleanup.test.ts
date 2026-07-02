// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';

import { runRagMigrations } from '../../storage/schema.js';
import { runSoftDeleteCleanup, type SoftDeleteCleanupAuditEntry } from '../soft-delete-cleanup.js';
import type { VectorStore } from '../../types.js';

function makeDb(): BetterSqlite3Database {
  const db = new Database(':memory:');
  runRagMigrations({ raw: db });
  return db;
}

function makeVectorStore(): VectorStore & {
  deleteByDocument: ReturnType<typeof vi.fn>;
} {
  return {
    upsert: vi.fn(),
    search: vi.fn(() => []),
    delete: vi.fn(),
    deleteByDocument: vi.fn(),
  };
}

interface SeedOpts {
  id: string;
  deletedAt: string | null;
  withChildren?: boolean;
}

/**
 * Seed a source row, optionally with a folder/document/chunk/job hanging
 * off of it. Used to assert that the cleanup cascade reaches every table.
 */
function seedSource(db: BetterSqlite3Database, opts: SeedOpts): void {
  db.prepare(
    `INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
		  embedding_dimensions, polling_interval_seconds, tenant_id,
		  created_at, updated_at, deleted_at)
		 VALUES (?, ?, 'local', '{}', 'test', 'mock-1', 16, NULL, 'default', ?, ?, ?)`,
  ).run(
    opts.id,
    `name-${opts.id}`,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    opts.deletedAt,
  );

  if (opts.withChildren) {
    db.prepare(
      `INSERT INTO rag_folders (id, source_id, parent_id, path, name) VALUES (?, ?, NULL, '/sub', 'sub')`,
    ).run(`f-${opts.id}`, opts.id);
    db.prepare(
      `INSERT INTO rag_documents (id, source_id, folder_id, path, name, mime_type, size, hash)
			 VALUES (?, ?, ?, ?, 'a.txt', 'text/plain', 10, 'h')`,
    ).run(`d-${opts.id}`, opts.id, `f-${opts.id}`, `/sub/${opts.id}.txt`);
    db.prepare(
      `INSERT INTO rag_chunks (id, document_id, position, text, token_count, embedding_dimensions)
			 VALUES (?, ?, 0, 'hi', 1, 16)`,
    ).run(`c-${opts.id}`, `d-${opts.id}`);
    db.prepare(
      `INSERT INTO rag_jobs (id, source_id, status, started_at) VALUES (?, ?, 'completed', '2026-01-01T00:00:00.000Z')`,
    ).run(`j-${opts.id}`, opts.id);
  }
}

const NOW = new Date('2026-05-10T12:00:00.000Z');
const EIGHT_DAYS_AGO = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
const FIVE_DAYS_AGO = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();

describe('runSoftDeleteCleanup', () => {
  it('no-op when no sources are eligible', () => {
    const db = makeDb();
    seedSource(db, { id: 's1', deletedAt: null }); // active, not soft-deleted
    seedSource(db, { id: 's2', deletedAt: FIVE_DAYS_AGO }); // soft-deleted but within window

    const audit: SoftDeleteCleanupAuditEntry[] = [];
    const result = runSoftDeleteCleanup({
      db,
      vectorStore: makeVectorStore(),
      retentionDays: 7,
      now: () => NOW,
      onAudit: (e) => audit.push(e),
    });

    expect(result.hardDeletedSources).toBe(0);
    expect(result.wipedDocuments).toBe(0);
    expect(result.wipedChunks).toBe(0);
    // No audit summary when nothing happened.
    expect(audit).toHaveLength(0);

    // Both rows still in DB.
    expect((db.prepare(`SELECT COUNT(*) AS c FROM rag_sources`).get() as { c: number }).c).toBe(2);
  });

  it('hard-deletes every expired source and cascades through children', () => {
    const db = makeDb();
    seedSource(db, { id: 'exp1', deletedAt: EIGHT_DAYS_AGO, withChildren: true });
    seedSource(db, { id: 'exp2', deletedAt: EIGHT_DAYS_AGO, withChildren: true });
    seedSource(db, { id: 'active', deletedAt: null, withChildren: true });

    const vectorStore = makeVectorStore();
    const audit: SoftDeleteCleanupAuditEntry[] = [];
    const result = runSoftDeleteCleanup({
      db,
      vectorStore,
      retentionDays: 7,
      now: () => NOW,
      onAudit: (e) => audit.push(e),
    });

    expect(result.hardDeletedSources).toBe(2);
    expect(result.wipedDocuments).toBe(2);
    expect(result.wipedChunks).toBe(2);
    expect(result.wipedFolders).toBe(2);
    expect(result.wipedJobs).toBe(2);

    // Per-source audit + summary.
    const hardDeletedEvents = audit.filter((e) => e.type === 'rag.sources.hard_deleted');
    expect(hardDeletedEvents).toHaveLength(2);
    expect(audit.some((e) => e.type === 'rag.cleanup.completed')).toBe(true);

    // vectorStore.deleteByDocument called for both expired sources' docs.
    expect(vectorStore.deleteByDocument).toHaveBeenCalledWith('d-exp1');
    expect(vectorStore.deleteByDocument).toHaveBeenCalledWith('d-exp2');
    expect(vectorStore.deleteByDocument).not.toHaveBeenCalledWith('d-active');

    // Active source survives with all its children.
    expect((db.prepare(`SELECT COUNT(*) AS c FROM rag_sources`).get() as { c: number }).c).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM rag_chunks`).get() as { c: number }).c).toBe(1);
  });

  it('hard-deletes only the expired source when a within-window one exists', () => {
    const db = makeDb();
    seedSource(db, { id: 'expired', deletedAt: EIGHT_DAYS_AGO, withChildren: true });
    seedSource(db, { id: 'recent', deletedAt: FIVE_DAYS_AGO, withChildren: true });

    const result = runSoftDeleteCleanup({
      db,
      vectorStore: makeVectorStore(),
      retentionDays: 7,
      now: () => NOW,
    });

    expect(result.hardDeletedSources).toBe(1);
    // Only the recent one survives.
    const remaining = db.prepare(`SELECT id FROM rag_sources`).all() as Array<{ id: string }>;
    expect(remaining.map((r) => r.id)).toEqual(['recent']);
  });

  it('continues when vectorStore.deleteByDocument throws', () => {
    const db = makeDb();
    seedSource(db, { id: 'exp', deletedAt: EIGHT_DAYS_AGO, withChildren: true });

    const vectorStore = makeVectorStore();
    vectorStore.deleteByDocument.mockImplementation(() => {
      throw new Error('vec-fail');
    });

    const audit: SoftDeleteCleanupAuditEntry[] = [];
    const result = runSoftDeleteCleanup({
      db,
      vectorStore,
      retentionDays: 7,
      now: () => NOW,
      onAudit: (e) => audit.push(e),
    });

    // Source still hard-deleted despite the vec wipe failure.
    expect(result.hardDeletedSources).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM rag_sources`).get() as { c: number }).c).toBe(0);
    // Audit captured the vector failure.
    expect(audit.some((e) => e.type === 'rag.cleanup.vector_wipe.failed')).toBe(true);
  });

  it('respects a custom retentionDays', () => {
    const db = makeDb();
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    seedSource(db, { id: 's', deletedAt: twoDaysAgo, withChildren: true });

    // retentionDays=1 → 2 days old qualifies.
    const result = runSoftDeleteCleanup({
      db,
      vectorStore: makeVectorStore(),
      retentionDays: 1,
      now: () => NOW,
    });
    expect(result.hardDeletedSources).toBe(1);
  });

  it('tolerates a pre-v8 DB without the deleted_at column (no-op)', () => {
    // Build a minimal v7-shape DB by hand.
    const db = new Database(':memory:');
    db.exec(`
			CREATE TABLE rag_sources (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				type TEXT NOT NULL,
				config_encrypted TEXT NOT NULL,
				embedding_setting_name TEXT NOT NULL,
				embedding_model_version TEXT NOT NULL,
				embedding_dimensions INTEGER NOT NULL DEFAULT 0,
				polling_interval_seconds INTEGER,
				tenant_id TEXT NOT NULL DEFAULT 'default',
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now')),
				last_sync_at TEXT
			);
		`);

    const result = runSoftDeleteCleanup({
      db,
      vectorStore: makeVectorStore(),
      retentionDays: 7,
      now: () => NOW,
    });

    expect(result.hardDeletedSources).toBe(0);
  });
});
