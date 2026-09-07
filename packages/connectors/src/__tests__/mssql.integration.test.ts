import { describe, it, expect, afterAll } from 'vitest';
import type { DatabaseConnector } from '../types.js';

// ---------------------------------------------------------------------------
// Real-database integration suite for the MSSQL connector.
//
// This suite is SKIPPED (not failed) whenever CALAME_TEST_MSSQL_DSN is
// unset, which is the normal state in CI — no SQL Server instance is
// available there. To run it locally:
//
//   scripts/mssql-test-up.sh
//   export CALAME_TEST_MSSQL_DSN='...'   (printed by the script above)
//   pnpm exec vitest run packages/connectors/src/__tests__/mssql.integration.test.ts
//
// See docs/mssql-testing.md for full instructions.
//
// packages/connectors/src/mssql.ts is being implemented concurrently and may
// not exist yet at any given point in time. The module is therefore resolved
// lazily/dynamically below and the whole suite degrades to "skipped" (never
// "failed") if it can't be found or doesn't export something that looks like
// a DatabaseConnector — this file must never break `pnpm test` regardless of
// whether mssql.ts has landed yet.
// ---------------------------------------------------------------------------

const dsn = process.env.CALAME_TEST_MSSQL_DSN;

// Built from a variable rather than a string literal so TypeScript does not
// attempt (and fail) to statically resolve the module before it exists —
// dynamic `import()` with a non-literal specifier is typed `Promise<any>`
// and skips compile-time resolution, while still resolving correctly at
// runtime relative to this file.
const MSSQL_MODULE_PATH = '../mssql.js';

function isDatabaseConnector(value: unknown): value is DatabaseConnector {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DatabaseConnector>;
  return (
    typeof candidate.introspect === 'function' &&
    typeof candidate.query === 'function' &&
    typeof candidate.testConnection === 'function' &&
    typeof candidate.disconnect === 'function'
  );
}

interface LoadedMssqlModule {
  connector?: DatabaseConnector;
  /** `parseDsn` from mssql.ts, if exported — builds an `mssql` driver `sql.config` from either DSN form. */
  parseDsn?: (dsn: string) => unknown;
}

/**
 * Resolve the MSSQL connector without assuming an exact export name/casing
 * (e.g. `mssqlConnector`, `MSSQLConnector`, `MssqlConnector`, `default`) —
 * whichever the other agent lands with. Accepts either an already-built
 * singleton instance or a zero-arg-constructible class. Also grabs
 * `parseDsn` (used by the read-only-enforcement tests below to build a
 * driver-level pool outside the connector's always-rollback query() path).
 */
async function loadMssqlModule(): Promise<LoadedMssqlModule> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(MSSQL_MODULE_PATH)) as Record<string, unknown>;
  } catch {
    return {};
  }

  let connector: DatabaseConnector | undefined;
  for (const exported of Object.values(mod)) {
    if (isDatabaseConnector(exported)) {
      connector = exported;
      break;
    }
    if (typeof exported === 'function') {
      try {
        const instance: unknown = new (exported as new () => unknown)();
        if (isDatabaseConnector(instance)) {
          connector = instance;
          break;
        }
      } catch {
        // Not a zero-arg constructor (or threw for another reason) — ignore
        // and keep looking at other exports.
      }
    }
  }

  const parseDsn =
    typeof mod.parseDsn === 'function' ? (mod.parseDsn as (dsn: string) => unknown) : undefined;
  return { connector, parseDsn };
}

// ---------------------------------------------------------------------------
// Minimal structural typing for the `mssql` driver package, loaded
// dynamically for the same reason the connector module above is: this file
// must degrade to "skipped" rather than fail if the driver isn't resolvable
// at some intermediate point in time.
// ---------------------------------------------------------------------------

interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest;
  query<T = Record<string, unknown>>(
    sqlText: string,
  ): Promise<{ recordset?: T[]; recordsets?: T[][] }>;
}

interface MssqlPool {
  connect(): Promise<MssqlPool>;
  close(): Promise<void>;
  request(): MssqlRequest;
}

interface MssqlDriver {
  ConnectionPool: new (config: unknown) => MssqlPool;
}

async function loadMssqlDriver(): Promise<MssqlDriver | undefined> {
  try {
    const mod = (await import('mssql')) as Record<string, unknown>;
    const candidate = (mod.default ?? mod) as Partial<MssqlDriver>;
    if (typeof candidate.ConnectionPool === 'function') return candidate as MssqlDriver;
  } catch {
    /* driver not resolvable at this point in time — degrade gracefully */
  }
  return undefined;
}

const { connector, parseDsn } = dsn ? await loadMssqlModule() : {};
// Only needed for the write-path sanity-inverse test below, and only worth
// loading once we know the connector itself resolved.
const mssqlDriver = dsn && connector ? await loadMssqlDriver() : undefined;

if (dsn && !connector) {
  console.warn(
    '[mssql.integration.test] CALAME_TEST_MSSQL_DSN is set but packages/connectors/src/mssql.ts ' +
      "was not found (or doesn't export a DatabaseConnector yet) — skipping the integration suite.",
  );
}

describe.skipIf(!dsn || !connector)('MSSQLConnector (integration)', () => {
  // Non-null assertions below are safe: describe.skipIf guarantees this body
  // only runs when both `dsn` and `connector` are defined.
  const db = dsn as string;
  const client = connector as DatabaseConnector;

  afterAll(async () => {
    await client.disconnect();
  });

  /**
   * Open a brand-new connector instance — its own pool, its own driver
   * connection — rather than reusing `client`. A verification read after a
   * write must go through a genuinely separate handle so it proves the
   * write landed (or didn't) server-side, not just that the same session
   * can see its own in-flight state.
   */
  function freshConnector(): DatabaseConnector {
    const Ctor = client.constructor as new () => DatabaseConnector;
    return new Ctor();
  }

  describe('testConnection()', () => {
    it('resolves against the seeded calame_test database', async () => {
      await expect(client.testConnection(db)).resolves.toBeUndefined();
    });
  });

  describe('introspect()', () => {
    it('returns dbo.clients with its columns and single-column primary key', async () => {
      const schema = await client.introspect(db);
      const clients = schema.tables.find((t) => t.schema === 'dbo' && t.name === 'clients');

      expect(clients).toBeDefined();
      expect(clients?.primaryKeys).toEqual(['client_id']);

      const columnNames = clients?.columns.map((c) => c.name).sort();
      expect(columnNames).toEqual(
        [
          'actif',
          'client_id',
          'date_creation',
          'date_naissance',
          'email',
          'nom',
          'notes',
          'prenom',
          'telephone',
        ].sort(),
      );

      const notes = clients?.columns.find((c) => c.name === 'notes');
      expect(notes?.type.toLowerCase()).toContain('nvarchar');
      expect(notes?.nullable).toBe(true);

      const actif = clients?.columns.find((c) => c.name === 'actif');
      expect(actif?.type.toLowerCase()).toBe('bit');
    });

    it('returns the composite primary key for dbo.order_items', async () => {
      const schema = await client.introspect(db);
      const items = schema.tables.find((t) => t.schema === 'dbo' && t.name === 'order_items');

      expect(items).toBeDefined();
      expect(items?.primaryKeys).toHaveLength(2);
      expect(new Set(items?.primaryKeys)).toEqual(new Set(['order_id', 'line_no']));
    });

    it('includes non-dbo schema tables (ventes.commandes, rh.employes) — required test case', async () => {
      const schema = await client.introspect(db);

      const commandes = schema.tables.find((t) => t.schema === 'ventes' && t.name === 'commandes');
      expect(commandes).toBeDefined();
      expect(commandes?.primaryKeys).toEqual(['commande_id']);
      expect(commandes?.columns.map((c) => c.name)).toEqual(
        expect.arrayContaining(['client_id', 'date_commande', 'montant_total', 'statut', 'region']),
      );

      const employes = schema.tables.find((t) => t.schema === 'rh' && t.name === 'employes');
      expect(employes).toBeDefined();
      expect(employes?.primaryKeys).toEqual(['employe_id']);
      expect(employes?.columns.map((c) => c.name)).toEqual(
        expect.arrayContaining(['salaire', 'poste', 'date_embauche']),
      );
    });

    it('does not confuse dbo.clients with the schema-qualified relations across tables', async () => {
      // dbo tables and non-dbo tables sharing no name should both be present
      // and distinguishable by `schema`, not merged/deduped by `name` alone.
      const schema = await client.introspect(db);
      const dboTableNames = schema.tables.filter((t) => t.schema === 'dbo').map((t) => t.name);
      const nonDboTableNames = schema.tables
        .filter((t) => t.schema !== 'dbo')
        .map((t) => `${t.schema}.${t.name}`);

      expect(dboTableNames).toEqual(
        expect.arrayContaining(['clients', 'products', 'orders', 'order_items']),
      );
      expect(nonDboTableNames).toEqual(expect.arrayContaining(['ventes.commandes', 'rh.employes']));
    });
  });

  describe('query()', () => {
    it('runs a parameterized SELECT with a WHERE filter', async () => {
      const result = await client.query(
        db,
        'SELECT client_id, nom, prenom, actif FROM dbo.clients WHERE actif = @p1 AND nom = @p2',
        { params: [0, 'Bonnet'] },
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ nom: 'Bonnet', prenom: 'Louis' });
    });

    it('paginates beyond page 1 with disjoint, ordered rows', async () => {
      const pageSize = 10;

      const page1 = await client.query(
        db,
        `SELECT client_id FROM dbo.clients ORDER BY client_id OFFSET 0 ROWS FETCH NEXT ${pageSize} ROWS ONLY`,
      );
      const page2 = await client.query(
        db,
        `SELECT client_id FROM dbo.clients ORDER BY client_id OFFSET ${pageSize} ROWS FETCH NEXT ${pageSize} ROWS ONLY`,
      );

      expect(page1.rows).toHaveLength(pageSize);
      expect(page2.rows.length).toBeGreaterThan(0);

      const page1Ids = page1.rows.map((r) => Number(r.client_id));
      const page2Ids = page2.rows.map((r) => Number(r.client_id));

      // Disjoint — no id appears on both pages.
      const overlap = page1Ids.filter((id) => page2Ids.includes(id));
      expect(overlap).toHaveLength(0);

      // Ordered ascending within each page, and page 2 strictly continues
      // after page 1 (proves OFFSET is actually being honoured, not just
      // returning an arbitrary disjoint set).
      expect([...page1Ids].sort((a, b) => a - b)).toEqual(page1Ids);
      expect([...page2Ids].sort((a, b) => a - b)).toEqual(page2Ids);
      expect(Math.min(...page2Ids)).toBeGreaterThan(Math.max(...page1Ids));
    });

    it('round-trips BIT, DATETIME2 and NVARCHAR(MAX) values sanely', async () => {
      const result = await client.query(
        db,
        `SELECT TOP 1 client_id, actif, date_creation, notes
         FROM dbo.clients
         WHERE notes IS NOT NULL
         ORDER BY client_id`,
      );

      expect(result.rows).toHaveLength(1);
      const row = result.rows[0]!;

      // BIT: drivers commonly surface this as a JS boolean, but tolerate 0/1
      // in case the connector passes the raw driver value through.
      expect([true, false, 0, 1]).toContain(row.actif);

      // DATETIME2: either a Date instance or an ISO-ish string is acceptable
      // — the point is it must not come back as an opaque/garbled value.
      const isDateLike =
        row.date_creation instanceof Date ||
        (typeof row.date_creation === 'string' && !Number.isNaN(Date.parse(row.date_creation)));
      expect(isDateLike).toBe(true);

      // NVARCHAR(MAX): full text (including accented French characters)
      // must survive the round trip, not just a truncated prefix.
      expect(typeof row.notes).toBe('string');
      expect(row.notes as string).toContain('é');
      expect((row.notes as string).length).toBeGreaterThan(10);
    });

    it('queries a schema-qualified table ([ventes].[commandes]) — required test case', async () => {
      const result = await client.query(
        db,
        'SELECT commande_id, region, montant_total FROM [ventes].[commandes] WHERE region = @p1',
        { params: ['Île-de-France'] },
      );

      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(row.region).toBe('Île-de-France');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Read-only enforcement — MSSQL has no `SET TRANSACTION READ ONLY`, so
  // query()'s contract (see the docstring on MSSQLConnector.query in
  // mssql.ts) is to always ROLL BACK the wrapping transaction instead: a
  // SELECT is unaffected, while any write that slipped through is discarded.
  // The implementer flagged this design choice as the one most needing
  // confirmation against a real server — these tests exercise it directly.
  // ---------------------------------------------------------------------------
  describe('read-only enforcement', () => {
    it('rolls back an INSERT attempted through the read-only query() path — proven server-side', async () => {
      const marker = 'SKU-ROGUE-ROLLBACK';

      const before = await client.query(db, 'SELECT COUNT(*) AS n FROM dbo.products');
      const countBefore = Number(before.rows[0]!.n);

      // The INSERT completes without throwing (SQL Server has no read-only
      // transaction mode to reject it client-side) but must never persist.
      await client.query(
        db,
        'INSERT INTO dbo.products (sku, nom, prix, en_stock) VALUES (@p1, @p2, @p3, @p4)',
        { params: [marker, 'Ne doit jamais persister', 1.0, true] },
      );

      // Verify via a FRESH connector instance — its own pool/connection —
      // so this proves the rollback committed server-side rather than
      // merely reading back uncommitted state on the same session.
      const verifier = freshConnector();
      try {
        const after = await verifier.query(db, 'SELECT COUNT(*) AS n FROM dbo.products');
        expect(Number(after.rows[0]!.n)).toBe(countBefore);

        const found = await verifier.query(db, 'SELECT * FROM dbo.products WHERE sku = @p1', {
          params: [marker],
        });
        expect(found.rows).toHaveLength(0);
      } finally {
        await verifier.disconnect();
      }
    });

    it.skipIf(!parseDsn || !mssqlDriver)(
      'sanity inverse: a write issued OUTSIDE query() does persist, proving the rollback is not a no-op',
      async () => {
        // packages/cli/src/write-executor.ts is the real "write-allowed"
        // path the serve write tool uses once an admin approves a queued
        // write: it deliberately bypasses DatabaseConnector.query() and
        // issues a bare `pool.request().query(sql)` with NO wrapping
        // transaction, so SQL Server auto-commits. packages/cli depends on
        // packages/connectors (not the other way around), so it isn't an
        // importable dependency from here — this test reproduces that exact
        // bare-request pattern directly against the `mssql` driver, using
        // the connector's own exported `parseDsn` to build the pool config,
        // which is the same function write-executor.ts imports (re-exported
        // as `parseMssqlDsn` from the package index) for this exact purpose.
        const marker = 'SKU-WRITE-TEST';
        const pool = new mssqlDriver!.ConnectionPool(parseDsn!(db));
        await pool.connect();
        try {
          await pool
            .request()
            .input('p1', marker)
            .input('p2', 'Produit créé hors connecteur')
            .input('p3', 2.5)
            .input('p4', true)
            .query(
              'INSERT INTO dbo.products (sku, nom, prix, en_stock) VALUES (@p1, @p2, @p3, @p4)',
            );

          // Read back through the connector's normal (rollback-wrapped)
          // read path — a SELECT is unaffected by that rollback, so it must
          // see the row the bare INSERT above committed.
          const found = await client.query(
            db,
            'SELECT sku, nom FROM dbo.products WHERE sku = @p1',
            { params: [marker] },
          );
          expect(found.rows).toHaveLength(1);
          expect(found.rows[0]).toMatchObject({
            sku: marker,
            nom: 'Produit créé hors connecteur',
          });
        } finally {
          // Clean up unconditionally so the suite stays idempotent across
          // repeated runs, whether or not the assertions above passed.
          await pool
            .request()
            .input('p1', marker)
            .query('DELETE FROM dbo.products WHERE sku = @p1');
          await pool.close();
        }
      },
    );

    it('rolls back a write smuggled into a multi-statement batch the same way as a single statement', async () => {
      const marker = 'SKU-ROGUE-BATCH';
      const before = await client.query(db, 'SELECT COUNT(*) AS n FROM dbo.products');
      const countBefore = Number(before.rows[0]!.n);

      // One query() call, two statements: SQL Server runs both in the same
      // implicit batch, inside the single transaction the connector always
      // rolls back — so the contract holds regardless of how many
      // statements are packed into `sqlText`.
      const result = await client.query(
        db,
        'SELECT 1 AS one; INSERT INTO dbo.products (sku, nom, prix, en_stock) VALUES (@p1, @p2, @p3, @p4)',
        { params: [marker, 'Ne doit jamais persister (batch)', 1.0, true] },
      );

      // The connector surfaces only the first result set as `rows` (mirrors
      // the mssql driver's `recordset` === `recordsets[0]`) — assert that
      // contract explicitly rather than assuming it.
      expect(result.rows).toEqual([{ one: 1 }]);

      const verifier = freshConnector();
      try {
        const after = await verifier.query(db, 'SELECT COUNT(*) AS n FROM dbo.products');
        expect(Number(after.rows[0]!.n)).toBe(countBefore);

        const found = await verifier.query(db, 'SELECT * FROM dbo.products WHERE sku = @p1', {
          params: [marker],
        });
        expect(found.rows).toHaveLength(0);
      } finally {
        await verifier.disconnect();
      }
    });
  });
});
