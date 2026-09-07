import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerDynamicTools } from '../dynamic-tools.js';
import { computeDistinctValues } from '../distinct-values.js';
import { makeDialect, dateBucketExpr, type DateBucket } from '../tool-context.js';
import { buildWhereConditions } from '../filter-builder.js';
import type { TableInfo, Relation } from '../../introspect/types.js';

// ---------------------------------------------------------------------------
// Table-driven SQL-dialect tests.
//
// Every supported backend is exercised through the same six tools so a new
// dialect cannot ship with one call site silently emitting another backend's
// syntax. The SQL Server expectations are the reason this file exists:
// T-SQL has no LIMIT, no `||` concatenation and no `$n` / `?` placeholders.
// ---------------------------------------------------------------------------

type DbType = 'postgresql' | 'mysql' | 'sqlite' | 'mssql';

interface DialectExpectation {
  databaseType: DbType;
  /** Quoted form of the identifier `name`. */
  quotedIdent: string;
  /** Quoted form of table `users` in schema `public`. */
  quotedTable: string;
  /** Placeholder rendered for the first bind parameter. */
  firstParam: string;
  /**
   * Substring that must appear in a paginated SELECT, given the 1-based bind
   * positions of the limit and offset values. They are not always 1 and 2 —
   * `top_n_per_group` binds its row cap first.
   */
  pagination: (limitIdx: number, offsetIdx: number) => string;
  /** Substring that must appear in a capped read of 30 rows. */
  cappedReadFragment: string;
  /** Random-ordering function. */
  random: string;
}

const DIALECTS: DialectExpectation[] = [
  {
    databaseType: 'postgresql',
    quotedIdent: '"name"',
    quotedTable: '"public"."users"',
    firstParam: '$1',
    pagination: (l, o) => `LIMIT $${l} OFFSET $${o}`,
    cappedReadFragment: 'LIMIT 30',
    random: 'RANDOM()',
  },
  {
    databaseType: 'mysql',
    quotedIdent: '`name`',
    quotedTable: '`users`',
    firstParam: '?',
    pagination: () => 'LIMIT ? OFFSET ?',
    cappedReadFragment: 'LIMIT 30',
    random: 'RAND()',
  },
  {
    databaseType: 'sqlite',
    quotedIdent: '"name"',
    quotedTable: '"users"',
    firstParam: '?',
    pagination: () => 'LIMIT ? OFFSET ?',
    cappedReadFragment: 'LIMIT 30',
    random: 'RANDOM()',
  },
  {
    databaseType: 'mssql',
    quotedIdent: '[name]',
    quotedTable: '[public].[users]',
    firstParam: '@p1',
    pagination: (l, o) => `OFFSET @p${o} ROWS FETCH NEXT @p${l} ROWS ONLY`,
    cappedReadFragment: 'TOP (30)',
    random: 'NEWID()',
  },
];

// ---------------------------------------------------------------------------
// Pure dialect behaviour
// ---------------------------------------------------------------------------

describe('makeDialect', () => {
  for (const expected of DIALECTS) {
    describe(expected.databaseType, () => {
      const dialect = makeDialect(expected.databaseType);

      it('quotes identifiers', () => {
        expect(dialect.quoteIdent('name')).toBe(expected.quotedIdent);
      });

      it('quotes schema-qualified tables', () => {
        expect(dialect.quoteTable('public', 'users')).toBe(expected.quotedTable);
      });

      it('renders the first bind placeholder', () => {
        expect(dialect.param(1)).toBe(expected.firstParam);
      });

      it('exposes a random-ordering function', () => {
        expect(dialect.random).toBe(expected.random);
      });

      it('paginates with an explicit ORDER BY', () => {
        const sql = dialect.paginate('ORDER BY [x]', dialect.param(1), dialect.param(2));
        expect(sql).toContain('ORDER BY');
        expect(sql).toContain(expected.pagination(1, 2));
      });

      it('emits exactly one of topPrefix / limitSuffix', () => {
        const hasTop = dialect.topPrefix(30) !== '';
        const hasLimit = dialect.limitSuffix(30) !== '';
        expect(hasTop).not.toBe(hasLimit);
        expect(`${dialect.topPrefix(30)}${dialect.limitSuffix(30)}`).toContain(
          expected.cappedReadFragment,
        );
      });

      it('reports a default schema', () => {
        expect(dialect.defaultSchema.length).toBeGreaterThan(0);
      });
    });
  }

  it('SQL Server injects a no-op ORDER BY when the query has none', () => {
    // OFFSET/FETCH is illegal without ORDER BY, so an unordered page must
    // still produce valid T-SQL.
    const dialect = makeDialect('mssql');
    expect(dialect.paginate('', '@p1', '@p2')).toBe(
      'ORDER BY (SELECT NULL) OFFSET @p2 ROWS FETCH NEXT @p1 ROWS ONLY',
    );
  });

  it('non-SQL-Server dialects leave an absent ORDER BY absent', () => {
    for (const dbType of ['postgresql', 'mysql', 'sqlite'] as const) {
      expect(makeDialect(dbType).paginate('', 'a', 'b')).not.toContain('ORDER BY');
    }
  });

  it('SQL Server concatenates with + and the others with ||', () => {
    expect(makeDialect('mssql').concat("'%'", '@p1', "'%'")).toBe("'%' + @p1 + '%'");
    for (const dbType of ['postgresql', 'mysql', 'sqlite'] as const) {
      expect(makeDialect(dbType).concat("'%'", '?', "'%'")).toBe("'%' || ? || '%'");
    }
  });

  it('escapes a closing bracket inside a SQL Server identifier', () => {
    const dialect = makeDialect('mssql');
    expect(dialect.quoteIdent('we]ird')).toBe('[we]]ird]');
    expect(dialect.quoteTable('sa]les', 'or]ders')).toBe('[sa]]les].[or]]ders]');
  });

  it('SQL Server uses the T-SQL statistics spellings and disables percentiles', () => {
    const dialect = makeDialect('mssql');
    expect(dialect.stddevExpr('[x]')).toBe('STDEV([x])');
    expect(dialect.varianceExpr('[x]')).toBe('VAR([x])');
    // PERCENTILE_CONT is a window function in T-SQL and does not compose with
    // the GROUP BY shape the aggregate tool emits.
    expect(dialect.supportsPercentile).toBe(false);
    expect(dialect.medianExpr('[x]')).toBeNull();
    expect(dialect.percentileExpr('[x]', 0.9)).toBeNull();
  });

  it('SQL Server defaults to the dbo schema', () => {
    expect(makeDialect('mssql').defaultSchema).toBe('dbo');
  });
});

// ---------------------------------------------------------------------------
// Filter rendering — the `||` concatenation is invalid T-SQL
// ---------------------------------------------------------------------------

describe('buildWhereConditions string operators', () => {
  for (const expected of DIALECTS) {
    it(`renders contains/starts_with/ends_with for ${expected.databaseType}`, () => {
      const dialect = makeDialect(expected.databaseType);
      const { conditions } = buildWhereConditions(
        {
          name: { op: 'contains', value: 'ab' },
          email: { op: 'starts_with', value: 'cd' },
          city: { op: 'ends_with', value: 'ef' },
        },
        ['name', 'email', 'city'],
        dialect,
        1,
      );
      const sql = conditions.join(' AND ');
      if (expected.databaseType === 'mssql') {
        expect(sql).toContain('+');
        expect(sql).not.toContain('||');
      } else {
        expect(sql).toContain('||');
      }
    });
  }

  it('SQL Server renders a LIKE pattern with + concatenation', () => {
    const dialect = makeDialect('mssql');
    const { conditions, values } = buildWhereConditions(
      { name: { op: 'contains', value: 'ab' } },
      ['name'],
      dialect,
      1,
    );
    expect(conditions[0]).toBe("LOWER([name]) LIKE '%' + LOWER(@p1) + '%'");
    // The wildcards live in the SQL, never in the bound value.
    expect(values).toEqual(['ab']);
  });

  it('SQL Server binds an IN list rather than PostgreSQL ANY()', () => {
    const dialect = makeDialect('mssql');
    const { conditions, values } = buildWhereConditions(
      { status: { op: 'in', value: ['a', 'b'] } },
      ['status'],
      dialect,
      1,
    );
    expect(conditions[0]).toBe('[status] IN (@p1, @p2)');
    expect(values).toEqual(['a', 'b']);
  });

  // T-SQL reads `[...]` in a LIKE pattern as a character class; the other
  // three engines treat brackets literally. Without escaping, the same filter
  // would match different rows per backend.
  describe('LIKE character-class parity', () => {
    const likeOps = ['contains', 'starts_with', 'ends_with'] as const;

    for (const op of likeOps) {
      for (const expected of DIALECTS) {
        it(`binds a literal [ safely for ${op} on ${expected.databaseType}`, () => {
          const dialect = makeDialect(expected.databaseType);
          const { values } = buildWhereConditions(
            { name: { op, value: 'Acme [Retired]' } },
            ['name'],
            dialect,
            1,
          );
          expect(values).toEqual([
            expected.databaseType === 'mssql' ? 'Acme [[]Retired]' : 'Acme [Retired]',
          ]);
        });
      }
    }

    it('SQL Server escapes every bracket in a value, not just the first', () => {
      const { values } = buildWhereConditions(
        { name: { op: 'contains', value: '[a][b]' } },
        ['name'],
        makeDialect('mssql'),
        1,
      );
      expect(values).toEqual(['[[]a][[]b]']);
    });

    it('SQL Server leaves a lone ] and ^ untouched — both are literal with no open class', () => {
      const dialect = makeDialect('mssql');
      const { values } = buildWhereConditions(
        { name: { op: 'contains', value: 'a]b^c' } },
        ['name'],
        dialect,
        1,
      );
      expect(values).toEqual(['a]b^c']);
    });

    it('every dialect leaves % and _ as wildcards inside the value', () => {
      // Pre-existing cross-dialect behaviour, identical on all four backends
      // and deliberately unchanged by the bracket fix.
      for (const expected of DIALECTS) {
        const { values } = buildWhereConditions(
          { name: { op: 'contains', value: '50%_off' } },
          ['name'],
          makeDialect(expected.databaseType),
          1,
        );
        expect(values).toEqual(['50%_off']);
      }
    });

    it('a value with no special characters is untouched on every dialect', () => {
      for (const expected of DIALECTS) {
        const { values } = buildWhereConditions(
          { name: { op: 'contains', value: 'plain' } },
          ['name'],
          makeDialect(expected.databaseType),
          1,
        );
        expect(values).toEqual(['plain']);
      }
    });
  });

  it('SQL Server coerces booleans to 0/1 for BIT columns', () => {
    const dialect = makeDialect('mssql');
    const { values } = buildWhereConditions(
      { active: { op: 'eq', value: true } },
      ['active'],
      dialect,
      1,
    );
    expect(values).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Date bucketing
// ---------------------------------------------------------------------------

describe('dateBucketExpr', () => {
  const granularities: DateBucket[] = ['day', 'week', 'month', 'quarter', 'year'];

  for (const expected of DIALECTS) {
    it(`renders every granularity for ${expected.databaseType}`, () => {
      const dialect = makeDialect(expected.databaseType);
      for (const granularity of granularities) {
        const expr = dateBucketExpr(dialect, granularity, 'col');
        expect(expr.length).toBeGreaterThan(0);
        expect(expr).toContain('col');
      }
    });
  }

  it('SQL Server avoids strftime and DATE_TRUNC entirely', () => {
    const dialect = makeDialect('mssql');
    for (const granularity of granularities) {
      const expr = dateBucketExpr(dialect, granularity, 'col');
      expect(expr).not.toContain('strftime');
      expect(expr).not.toContain('DATE_TRUNC');
      expect(expr).not.toContain('DATE_FORMAT');
    }
  });

  it('SQL Server zero-pads the ISO week so periods sort chronologically', () => {
    const expr = dateBucketExpr(makeDialect('mssql'), 'week', 'col');
    expect(expr).toContain('ISO_WEEK');
    expect(expr).toContain("RIGHT('0'");
  });
});

// ---------------------------------------------------------------------------
// Tool-level SQL emission
// ---------------------------------------------------------------------------

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

const usersTable: TableInfo = {
  name: 'users',
  schema: 'public',
  columns: [
    { name: 'id', type: 'integer', nullable: false, defaultValue: null },
    { name: 'name', type: 'text', nullable: false, defaultValue: null },
    { name: 'age', type: 'integer', nullable: true, defaultValue: null },
  ],
  primaryKeys: ['id'],
};

const ordersTable: TableInfo = {
  name: 'orders',
  schema: 'public',
  columns: [
    { name: 'id', type: 'integer', nullable: false, defaultValue: null },
    { name: 'user_id', type: 'integer', nullable: false, defaultValue: null },
    { name: 'amount', type: 'numeric', nullable: false, defaultValue: null },
  ],
  primaryKeys: ['id'],
};

const relations: Relation[] = [
  { fromTable: 'orders', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' },
];

function registerFor(databaseType: DbType, executeQuery: ReturnType<typeof vi.fn>) {
  const server = createMockServer();
  registerDynamicTools({
    server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
    tables: [usersTable, ordersTable],
    relations,
    selectedTables: { users: ['id', 'name', 'age'], orders: ['id', 'user_id', 'amount'] },
    executeQuery,
    profileName: 'test',
    databaseType,
  });
  return server.getRegisteredTools();
}

/** Collect every SQL string the tools sent to the executor. */
function sqlCalls(executeQuery: ReturnType<typeof vi.fn>): string[] {
  return executeQuery.mock.calls.map((call) => String(call[0]));
}

describe('tool SQL generation per dialect', () => {
  let executeQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeQuery = vi.fn().mockResolvedValue({ rows: [], fields: [] });
  });

  for (const expected of DIALECTS) {
    describe(expected.databaseType, () => {
      it('query paginates and quotes with the dialect syntax', async () => {
        const tools = registerFor(expected.databaseType, executeQuery);
        await tools.get('query')!.handler({ table: 'users', limit: 5, offset: 10 });

        const sql = sqlCalls(executeQuery)[0];
        expect(sql).toContain(expected.quotedTable);
        expect(sql).toContain(expected.quotedIdent);
        expect(sql).toContain(expected.pagination(1, 2));
        if (expected.databaseType === 'mssql') expect(sql).not.toContain('LIMIT');
      });

      it('query orders randomly when sampling', async () => {
        const tools = registerFor(expected.databaseType, executeQuery);
        await tools.get('query')!.handler({ table: 'users', sample: true, limit: 3 });
        expect(sqlCalls(executeQuery)[0]).toContain(`ORDER BY ${expected.random}`);
      });

      it('aggregate paginates with the dialect syntax', async () => {
        const tools = registerFor(expected.databaseType, executeQuery);
        await tools.get('aggregate')!.handler({
          table: 'orders',
          aggregation: 'sum',
          aggregation_column: 'amount',
          group_by: 'user_id',
          limit: 5,
          offset: 0,
        });

        const sql = sqlCalls(executeQuery)[0];
        expect(sql).toContain(expected.pagination(1, 2));
        if (expected.databaseType === 'mssql') expect(sql).not.toContain('LIMIT');
      });

      it('aggregate paginates the top_n_per_group window wrapper', async () => {
        const tools = registerFor(expected.databaseType, executeQuery);
        await tools.get('aggregate')!.handler({
          table: 'orders',
          aggregation: 'sum',
          aggregation_column: 'amount',
          group_by: 'user_id',
          top_n_per_group: { partition_by: 'user_id', order_by: 'result', n: 3 },
          limit: 5,
          offset: 0,
        });

        const sql = sqlCalls(executeQuery)[0];
        expect(sql).toContain('ROW_NUMBER() OVER');
        expect(sql).toContain(expected.pagination(2, 3));
      });

      it('join_aggregate paginates with the dialect syntax', async () => {
        const tools = registerFor(expected.databaseType, executeQuery);
        await tools.get('join_aggregate')!.handler({
          primary_table: 'orders',
          join_table: 'users',
          aggregation: 'sum',
          aggregation_column: 'amount',
          group_by_column: 'name',
          group_by_table: 'join',
          limit: 5,
          offset: 0,
        });

        const sql = sqlCalls(executeQuery)[0];
        expect(sql).toContain('INNER JOIN');
        expect(sql).toContain(expected.pagination(1, 2));
        if (expected.databaseType === 'mssql') expect(sql).not.toContain('LIMIT');
      });

      it('describe caps its distinct-value probes without an offset', async () => {
        // The first call is the stats query; distinct probes follow only when
        // the column looks low-cardinality, so assert over every emitted SQL.
        executeQuery.mockResolvedValue({
          rows: [{ total: 1, name__distinct: 2, age__distinct: 2 }],
          fields: [],
        });
        const tools = registerFor(expected.databaseType, executeQuery);
        await tools.get('describe')!.handler({ table: 'users' });

        const probes = sqlCalls(executeQuery).filter((s) => s.includes('SELECT DISTINCT'));
        for (const probe of probes) {
          if (expected.databaseType === 'mssql') {
            expect(probe).toContain('TOP (');
            expect(probe).not.toContain('LIMIT');
          } else {
            expect(probe).toContain('LIMIT');
          }
        }
      });

      it('list_tables answers from memory without emitting SQL', async () => {
        const tools = registerFor(expected.databaseType, executeQuery);
        const result = await tools.get('list_tables')!.handler({});
        expect(JSON.parse(result.content[0].text)).toHaveLength(2);
        expect(sqlCalls(executeQuery)).toHaveLength(0);
      });

      it('distinct-values caps the boot-time catalogue probe', async () => {
        const probe = vi.fn().mockResolvedValue({ rows: [], fields: [] });
        await computeDistinctValues({
          tables: [usersTable],
          selectedTables: { users: ['id', 'name', 'age'] },
          executeQuery: probe,
          databaseType: expected.databaseType,
          maxValues: 20,
        });

        const sql = String(probe.mock.calls[0][0]);
        expect(sql).toContain(expected.quotedTable);
        if (expected.databaseType === 'mssql') {
          expect(sql).toContain('TOP (21)');
          expect(sql).not.toContain('LIMIT');
        } else {
          expect(sql).toContain('LIMIT 21');
        }
      });
    });
  }

  it('SQL Server pagination stays legal when the query has no ORDER BY', async () => {
    const tools = registerFor('mssql', executeQuery);
    await tools.get('query')!.handler({ table: 'users', limit: 5, offset: 10 });

    const sql = sqlCalls(executeQuery)[0];
    expect(sql).toContain('ORDER BY (SELECT NULL)');
    expect(sql).toContain('OFFSET @p2 ROWS FETCH NEXT @p1 ROWS ONLY');
  });

  it('SQL Server binds sequentially numbered named parameters', async () => {
    const tools = registerFor('mssql', executeQuery);
    await tools.get('query')!.handler({
      table: 'users',
      filters: { name: { op: 'eq', value: 'ana' } },
      limit: 5,
      offset: 0,
    });

    const [sql, params] = executeQuery.mock.calls[0];
    // One filter param, then limit and offset — @p1..@p3 in bind order.
    expect(sql).toContain('[name] = @p1');
    expect(sql).toContain('OFFSET @p3 ROWS FETCH NEXT @p2 ROWS ONLY');
    expect(params).toEqual(['ana', 5, 0]);
  });

  it('SQL Server schema-qualifies a non-dbo table', async () => {
    const salesTable: TableInfo = { ...usersTable, name: 'clients', schema: 'sales' };
    const server = createMockServer();
    registerDynamicTools({
      server: server as unknown as Parameters<typeof registerDynamicTools>[0]['server'],
      tables: [salesTable],
      relations: [],
      selectedTables: { clients: ['id', 'name', 'age'] },
      executeQuery,
      profileName: 'test',
      databaseType: 'mssql',
    });

    await server.getRegisteredTools().get('query')!.handler({ table: 'clients', limit: 1 });
    // The schema travels in TableInfo.schema and is re-joined at quote time —
    // the table keeps its bare name rather than being flattened.
    expect(sqlCalls(executeQuery)[0]).toContain('FROM [sales].[clients]');
  });
});
