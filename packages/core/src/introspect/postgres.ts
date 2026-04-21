import { Client } from 'pg';
import { DatabaseSchema, TableInfo, ColumnInfo, Relation } from './types.js';

/**
 * Introspect a PostgreSQL database and return its schema.
 *
 * This function is the canonical backwards-compatible entry-point used by
 * consumers that import directly from `@calame/core`.  The same logic is
 * also available through `PostgreSQLConnector` in `@calame/connectors`
 * (which keeps `core` free of a circular dependency on `connectors`).
 */
export async function introspectDatabase(connectionString: string): Promise<DatabaseSchema> {
  const client = new Client({ connectionString });

  try {
    await client.connect();

    // Fetch tables
    const tablesResult = await client.query<{ table_name: string; table_schema: string }>(
      `SELECT table_name, table_schema
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       AND table_type = 'BASE TABLE'`,
    );

    // Fetch columns
    const columnsResult = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      table_name: string;
      table_schema: string;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default, table_name, table_schema
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );

    // Fetch primary keys
    const pksResult = await client.query<{ column_name: string; table_name: string }>(
      `SELECT kcu.column_name, tc.table_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );

    // Fetch foreign keys
    const fksResult = await client.query<{
      column_name: string;
      from_table: string;
      to_table: string;
      to_column: string;
    }>(
      `SELECT
         kcu.column_name,
         kcu.table_name AS from_table,
         ccu.table_name AS to_table,
         ccu.column_name AS to_column
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.constraint_column_usage ccu
         ON kcu.constraint_name = ccu.constraint_name
       JOIN information_schema.table_constraints tc
         ON kcu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );

    // Build primary keys map
    const pkMap = new Map<string, string[]>();
    for (const row of pksResult.rows) {
      const existing = pkMap.get(row.table_name) ?? [];
      existing.push(row.column_name);
      pkMap.set(row.table_name, existing);
    }

    // Build columns map
    const colMap = new Map<string, ColumnInfo[]>();
    for (const row of columnsResult.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const existing = colMap.get(key) ?? [];
      existing.push({
        name: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable === 'YES',
        defaultValue: row.column_default,
      });
      colMap.set(key, existing);
    }

    // Assemble tables
    const tables: TableInfo[] = tablesResult.rows.map((row) => ({
      name: row.table_name,
      schema: row.table_schema,
      columns: colMap.get(`${row.table_schema}.${row.table_name}`) ?? [],
      primaryKeys: pkMap.get(row.table_name) ?? [],
    }));

    // Assemble relations
    const relations: Relation[] = fksResult.rows.map((row) => ({
      fromTable: row.from_table,
      fromColumn: row.column_name,
      toTable: row.to_table,
      toColumn: row.to_column,
    }));

    return { tables, relations };
  } finally {
    await client.end();
  }
}
