import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateDemoDb } from '../demo-db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CountRow {
  c: number;
}

interface TableRow {
  name: string;
}

function makeTmpDbPath(): { dbPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-demo-db-test-'));
  return {
    dbPath: path.join(tmpDir, 'demo-logistique-v2.db'),
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as CountRow).c;
}

// This generates ~40k rows of seed data with plain (non-transactional) prepared-statement
// inserts, mirroring scripts/generate-demo-db.js — give it real headroom over the default
// vitest timeout.
const GENERATE_TIMEOUT_MS = 30000;

describe('generateDemoDb', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it(
    'creates a SQLite database with the expected logistics schema and seed data',
    () => {
      const tmp = makeTmpDbPath();
      cleanup = tmp.cleanup;

      generateDemoDb(tmp.dbPath);

      expect(fs.existsSync(tmp.dbPath)).toBe(true);

      const db = new Database(tmp.dbPath, { readonly: true });
      try {
        const tables = (
          db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
            .all() as TableRow[]
        ).map((r) => r.name);

        for (const expected of [
          'zone',
          'depot',
          'client',
          'livreur',
          'colis',
          'tournee',
          'tournee_colis',
          'incident',
          'paiement',
          'historique_statut',
          'notification',
        ]) {
          expect(tables).toContain(expected);
        }

        // Row counts match the volumes seeded by scripts/generate-demo-db.js.
        expect(countRows(db, 'zone')).toBe(10);
        expect(countRows(db, 'depot')).toBe(20);
        expect(countRows(db, 'client')).toBe(500);
        expect(countRows(db, 'livreur')).toBe(50);
        expect(countRows(db, 'colis')).toBe(20000);
        expect(countRows(db, 'tournee')).toBe(300);
        expect(countRows(db, 'incident')).toBe(400);
        expect(countRows(db, 'paiement')).toBe(10000);
        expect(countRows(db, 'notification')).toBe(6000);

        // Emma Leroy (3rd client inserted) is boosted: the first 500 colis are always hers,
        // plus a handful more from the random per-colis client pick landing on her by chance
        // (expected ~500 + 19500/500 ≈ 539) — so assert the guaranteed floor, not an exact count.
        const emmaColisCount = (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM colis
               WHERE id_client = (SELECT id FROM client ORDER BY id LIMIT 1 OFFSET 2)`,
            )
            .get() as CountRow
        ).c;
        expect(emmaColisCount).toBeGreaterThanOrEqual(500);
        expect(emmaColisCount).toBeLessThan(600);

        // Referential sanity: every colis.id_client points at a real client row.
        const orphanColis = (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM colis
               WHERE id_client NOT IN (SELECT id FROM client)`,
            )
            .get() as CountRow
        ).c;
        expect(orphanColis).toBe(0);
      } finally {
        db.close();
      }
    },
    GENERATE_TIMEOUT_MS,
  );

  it(
    'overwrites a pre-existing file at the same path',
    () => {
      const tmp = makeTmpDbPath();
      cleanup = tmp.cleanup;

      fs.writeFileSync(tmp.dbPath, 'not a real sqlite file');
      generateDemoDb(tmp.dbPath);

      const db = new Database(tmp.dbPath, { readonly: true });
      try {
        expect(countRows(db, 'zone')).toBe(10);
      } finally {
        db.close();
      }
    },
    GENERATE_TIMEOUT_MS,
  );
});
