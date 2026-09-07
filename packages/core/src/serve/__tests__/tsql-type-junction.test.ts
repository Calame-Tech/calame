import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerDynamicTools } from '../dynamic-tools.js';
import { computeDistinctValues } from '../distinct-values.js';
import { pgTypeToZod, isNumericType, isTextType, friendlyTypeLabel } from '../tool-context.js';
import { friendlyType } from '../response-formatter.js';
import type { TableInfo } from '../../introspect/types.js';

// ---------------------------------------------------------------------------
// REGRESSION CLASS: type-name → tool-surface junction.
//
// The unit tests for the dialect and the connector-integration tests both
// passed while every MSSQL filter was silently ignored, because the bug lived
// between them: introspection emits T-SQL type names, `pgTypeToZod` knew only
// PostgreSQL ones, so `filterableCols` was empty and the filter builder
// dropped every filter without a word.
//
// These tests drive the real `registerDynamicTools` with a TableInfo whose
// columns carry the type names SQL Server's INFORMATION_SCHEMA actually
// reports (verified against a live SQL Server 2022 container: lowercase and
// bare — "nvarchar", not "nvarchar(255)"), and assert a filter reaches the
// generated WHERE clause.
// ---------------------------------------------------------------------------

/** Exactly what `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` reports on SQL Server. */
const tsqlTable: TableInfo = {
  name: 'clients',
  schema: 'dbo',
  columns: [
    { name: 'client_id', type: 'int', nullable: false, defaultValue: null },
    { name: 'nom', type: 'nvarchar', nullable: false, defaultValue: null },
    { name: 'code', type: 'nchar', nullable: true, defaultValue: null },
    { name: 'notes', type: 'ntext', nullable: true, defaultValue: null },
    { name: 'actif', type: 'bit', nullable: false, defaultValue: null },
    { name: 'date_creation', type: 'datetime2', nullable: true, defaultValue: null },
    { name: 'date_naissance', type: 'date', nullable: true, defaultValue: null },
    { name: 'solde', type: 'money', nullable: true, defaultValue: null },
    { name: 'remise', type: 'decimal', nullable: true, defaultValue: null },
    { name: 'ref', type: 'uniqueidentifier', nullable: true, defaultValue: null },
  ],
  primaryKeys: ['client_id'],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (...args: any[]) => any;

function createMockServer() {
  const tools = new Map<string, { description: string; schema: unknown; handler: ToolHandler }>();
  return {
    tool: vi.fn((name: string, description: string, schema: unknown, handler: ToolHandler) => {
      tools.set(name, { description, schema, handler });
    }),
    getRegisteredTools: () => tools,
  };
}

const ALL_COLUMNS = tsqlTable.columns.map((c) => c.name);

// ---------------------------------------------------------------------------
// Type classification
// ---------------------------------------------------------------------------

describe('T-SQL type names are classified, not dropped', () => {
  const filterable: [string, string][] = [
    ['nvarchar', 'string'],
    ['nchar', 'string'],
    ['ntext', 'string'],
    ['sysname', 'string'],
    ['uniqueidentifier', 'string'],
    ['datetime2', 'string'],
    ['smalldatetime', 'string'],
    ['datetimeoffset', 'string'],
    ['date', 'string'],
    ['time', 'string'],
    ['int', 'number'],
    ['tinyint', 'number'],
    ['smallint', 'number'],
    ['decimal', 'number'],
    ['numeric', 'number'],
    ['money', 'number'],
    ['smallmoney', 'number'],
    ['real', 'number'],
    ['float', 'number'],
    ['bigint', 'string'],
    ['bit', 'boolean'],
  ];

  for (const [type, expected] of filterable) {
    it(`maps ${type} to ${expected}`, () => {
      expect(pgTypeToZod(type)).toBe(expected);
    });
  }

  // Binary / structured types stay unfilterable, mirroring PostgreSQL bytea.
  for (const type of ['binary', 'varbinary', 'image', 'rowversion', 'bytea', 'json', 'jsonb']) {
    it(`leaves ${type} unfilterable`, () => {
      expect(pgTypeToZod(type)).toBeNull();
    });
  }

  // Documented tradeoff: SQL Server reports a ROWVERSION column's DATA_TYPE as
  // the literal string 'timestamp' (they are server-side synonyms — the string
  // 'rowversion' never comes out of INFORMATION_SCHEMA). 'timestamp' is a real
  // date type on PostgreSQL/MySQL, and these classifiers only see the bare type
  // name, so a SQL Server rowversion column classifies as a filterable
  // date-ish string. A filter against it surfaces a SQL type-conversion error
  // rather than wrong data. Disambiguating would require threading the dialect
  // through every classifier — deliberately not done (see sql-types.ts).
  it(`classifies 'timestamp' as filterable (also SQL Server's rowversion spelling — known ambiguity)`, () => {
    expect(pgTypeToZod('timestamp')).not.toBeNull();
  });

  it('treats T-SQL numeric types as aggregation targets', () => {
    for (const type of ['int', 'tinyint', 'money', 'smallmoney', 'decimal', 'real', 'float']) {
      expect(isNumericType(type)).toBe(true);
    }
    expect(isNumericType('nvarchar')).toBe(false);
    expect(isNumericType('bit')).toBe(false);
  });

  it('treats T-SQL string and date types as text for zero-result hints', () => {
    expect(isTextType('nvarchar')).toBe(true);
    expect(isTextType('datetime2')).toBe(true);
    expect(isTextType('int')).toBe(false);
  });

  it('labels T-SQL types for the catalogue', () => {
    expect(friendlyTypeLabel('nvarchar')).toBe('string');
    expect(friendlyTypeLabel('datetime2')).toBe('date');
    expect(friendlyTypeLabel('bit')).toBe('bool');
    expect(friendlyTypeLabel('money')).toBe('number');
  });

  it('labels T-SQL types in friendly response mode', () => {
    expect(friendlyType('datetime2')).toBe('Date');
    expect(friendlyType('bit')).toBe('Oui/Non');
    expect(friendlyType('money')).toBe('Nombre');
    expect(friendlyType('nvarchar')).toBe('Texte');
  });

  // MySQL and SQLite had the same gap for these names.
  it('classifies the MySQL / SQLite type names that were also missing', () => {
    expect(pgTypeToZod('datetime')).toBe('string');
    expect(pgTypeToZod('double')).toBe('number');
    expect(pgTypeToZod('float')).toBe('number');
    expect(pgTypeToZod('tinyint')).toBe('number');
    expect(pgTypeToZod('longtext')).toBe('string');
    expect(pgTypeToZod('enum')).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// The junction itself: registered tools must actually filter
// ---------------------------------------------------------------------------

describe('MCP tools filter on T-SQL-typed columns', () => {
  let executeQuery: ReturnType<typeof vi.fn>;

  function register(databaseType: 'mssql' | 'postgresql' = 'mssql') {
    const server = createMockServer();
    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [tsqlTable],
      relations: [],
      selectedTables: { clients: ALL_COLUMNS },
      executeQuery,
      profileName: 'test',
      databaseType,
    });
    return server.getRegisteredTools();
  }

  beforeEach(() => {
    executeQuery = vi.fn().mockResolvedValue({ rows: [], fields: [] });
  });

  it('query applies a contains filter on an nvarchar column', async () => {
    const tools = register();
    await tools.get('query')!.handler({
      table: 'clients',
      filters: { nom: { op: 'contains', value: 'zzz' } },
      limit: 5,
    });

    const [sql, params] = executeQuery.mock.calls[0];
    expect(sql).toContain('WHERE');
    expect(sql).toContain('LOWER([nom]) LIKE');
    // The bracket escape from the earlier T-SQL LIKE fix still applies.
    expect(params[0]).toBe('zzz');
  });

  it('query applies an eq filter on an nvarchar column', async () => {
    const tools = register();
    await tools.get('query')!.handler({
      table: 'clients',
      filters: { nom: { op: 'eq', value: 'Acme' } },
      limit: 5,
    });

    const [sql, params] = executeQuery.mock.calls[0];
    expect(sql).toContain('[nom] = @p1');
    expect(params[0]).toBe('Acme');
  });

  it('query applies a bit filter, coerced to 0/1', async () => {
    const tools = register();
    await tools.get('query')!.handler({
      table: 'clients',
      filters: { actif: { op: 'eq', value: true } },
      limit: 5,
    });

    const [sql, params] = executeQuery.mock.calls[0];
    expect(sql).toContain('[actif] = @p1');
    expect(params[0]).toBe(1);
  });

  it('query applies a datetime2 between filter', async () => {
    const tools = register();
    await tools.get('query')!.handler({
      table: 'clients',
      filters: { date_creation: { op: 'between', value: ['2026-01-01', '2026-02-01'] } },
      limit: 5,
    });

    const sql = String(executeQuery.mock.calls[0][0]);
    expect(sql).toContain('[date_creation] >= @p1');
    expect(sql).toContain('[date_creation] <= @p2');
  });

  it('aggregate applies a filter and groups by an nvarchar column', async () => {
    const tools = register();
    await tools.get('aggregate')!.handler({
      table: 'clients',
      aggregation: 'count',
      group_by: 'nom',
      filters: { actif: { op: 'eq', value: true } },
    });

    const sql = String(executeQuery.mock.calls[0][0]);
    expect(sql).toContain('WHERE');
    expect(sql).toContain('[actif] = @p1');
    expect(sql).toContain('GROUP BY [nom]');
  });

  it('aggregate offers non-numeric columns as group_by targets', () => {
    const tools = register();
    // The regression showed only int/decimal columns in group_by; every
    // visible column should be groupable.
    const desc = tools.get('aggregate')!.description;
    for (const col of ['nom', 'actif', 'date_creation']) {
      expect(desc).toContain(col);
    }
  });

  it('describe reports the T-SQL columns', async () => {
    executeQuery.mockResolvedValue({ rows: [{ total: 0 }], fields: [] });
    const tools = register();
    const result = await tools.get('describe')!.handler({ table: 'clients' });
    const text = result.content[0].text;
    expect(text).toContain('nom');
    expect(text).toContain('actif');
  });

  it('distinct-values probes nvarchar and bit columns at boot', async () => {
    const probe = vi.fn().mockResolvedValue({ rows: [], fields: [] });
    await computeDistinctValues({
      tables: [tsqlTable],
      selectedTables: { clients: ALL_COLUMNS },
      executeQuery: probe,
      databaseType: 'mssql',
    });

    const probed = probe.mock.calls.map((c) => String(c[0]));
    expect(probed.some((s) => s.includes('[nom]'))).toBe(true);
    expect(probed.some((s) => s.includes('[actif]'))).toBe(true);
    // ntext is large text — deliberately not enumerated.
    expect(probed.some((s) => s.includes('[notes]'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The failure mode that hid the bug
// ---------------------------------------------------------------------------

describe('filters on non-filterable columns are rejected, never ignored', () => {
  let executeQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeQuery = vi.fn().mockResolvedValue({ rows: [], fields: [] });
  });

  const binaryTable: TableInfo = {
    name: 'files',
    schema: 'dbo',
    columns: [
      { name: 'id', type: 'int', nullable: false, defaultValue: null },
      { name: 'blob', type: 'varbinary', nullable: true, defaultValue: null },
    ],
    primaryKeys: ['id'],
  };

  function register(table: TableInfo, selected: string[]) {
    const server = createMockServer();
    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [table],
      relations: [],
      selectedTables: { [table.name]: selected },
      executeQuery,
      profileName: 'test',
      databaseType: 'mssql',
    });
    return server.getRegisteredTools();
  }

  it('query errors on an unsupported-type column instead of returning all rows', async () => {
    const tools = register(binaryTable, ['id', 'blob']);
    const result = await tools
      .get('query')!
      .handler({ table: 'files', filters: { blob: { op: 'eq', value: 'x' } } });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/Column 'blob' is not filterable/);
    expect(payload.valid_columns).toEqual(['id']);
    // Critically: no query ran, so no unfiltered result was returned.
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('query errors on a column absent from the table', async () => {
    const tools = register(tsqlTable, ALL_COLUMNS);
    const result = await tools
      .get('query')!
      .handler({ table: 'clients', filters: { nope: { op: 'eq', value: 'x' } } });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/Column 'nope' is not filterable/);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('aggregate errors rather than aggregating over every row', async () => {
    const tools = register(binaryTable, ['id', 'blob']);
    const result = await tools.get('aggregate')!.handler({
      table: 'files',
      aggregation: 'count',
      filters: { blob: { op: 'eq', value: 'x' } },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/not filterable/);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('rejecting a hidden column is byte-identical to rejecting an absent one', async () => {
    // The non-disclosure invariant: the response for a given column NAME must
    // not depend on whether that column is masked or simply does not exist.
    // So we ask for the same name against two schemas — one where `solde` is
    // excluded by masking, one where it was never there — and require the two
    // payloads to be indistinguishable.
    const withMaskedColumn = createMockServer();
    registerDynamicTools({
      server: withMaskedColumn as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [tsqlTable],
      relations: [],
      selectedTables: { clients: ALL_COLUMNS },
      columnMasking: { clients: { solde: { maskingMode: 'exclude' } } },
      executeQuery,
      profileName: 'test',
      databaseType: 'mssql',
    });

    const withoutColumn = createMockServer();
    const trimmedTable: TableInfo = {
      ...tsqlTable,
      columns: tsqlTable.columns.filter((c) => c.name !== 'solde'),
    };
    registerDynamicTools({
      server: withoutColumn as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [trimmedTable],
      relations: [],
      selectedTables: { clients: trimmedTable.columns.map((c) => c.name) },
      executeQuery,
      profileName: 'test',
      databaseType: 'mssql',
    });

    const filters = { solde: { op: 'eq' as const, value: 1 } };
    const masked = await withMaskedColumn
      .getRegisteredTools()
      .get('query')!
      .handler({ table: 'clients', filters });
    const absent = await withoutColumn
      .getRegisteredTools()
      .get('query')!
      .handler({ table: 'clients', filters });

    expect(masked.content[0].text).toBe(absent.content[0].text);
    const payload = JSON.parse(masked.content[0].text);
    expect(payload.error).toMatch(/Column 'solde' is not filterable/);
    expect(payload.valid_columns).not.toContain('solde');
  });
});
