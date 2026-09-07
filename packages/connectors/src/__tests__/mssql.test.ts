import { describe, it, expect } from 'vitest';
import { parseDsn, quoteMssqlIdent, MSSQLConnector } from '../mssql.js';

// ---------------------------------------------------------------------------
// DSN parsing is pure, so it is tested directly — no SQL Server needed.
// Connection / introspection behaviour is covered by the integration suite.
//
// v1 supports SQL Server authentication only; Windows / AD integrated auth is
// rejected up front rather than silently downgraded to an anonymous connect.
// ---------------------------------------------------------------------------

describe('MSSQL DSN parsing — ADO form', () => {
  it('parses the canonical SSMS-style connection string', () => {
    const config = parseDsn(
      'Server=localhost,1433;Database=mydb;User Id=sa;Password=Str0ng!;Encrypt=true;TrustServerCertificate=true',
    );
    expect(config.server).toBe('localhost');
    expect(config.port).toBe(1433);
    expect(config.database).toBe('mydb');
    expect(config.user).toBe('sa');
    expect(config.password).toBe('Str0ng!');
    expect(config.options?.encrypt).toBe(true);
    expect(config.options?.trustServerCertificate).toBe(true);
  });

  it('accepts the Data Source / Initial Catalog / UID / PWD aliases', () => {
    const config = parseDsn('Data Source=db.internal;Initial Catalog=sales;UID=app;PWD=hunter2');
    expect(config.server).toBe('db.internal');
    expect(config.database).toBe('sales');
    expect(config.user).toBe('app');
    expect(config.password).toBe('hunter2');
  });

  it('is case-insensitive in keys and tolerates surrounding whitespace', () => {
    const config = parseDsn(
      '  SERVER = localhost ; database = mydb ; user id = sa ; password = p ',
    );
    expect(config.server).toBe('localhost');
    expect(config.database).toBe('mydb');
    expect(config.user).toBe('sa');
    expect(config.password).toBe('p');
  });

  it('reads a braced password containing semicolons and equals signs', () => {
    const config = parseDsn('Server=h;Database=d;User Id=u;Password={p;w=x}');
    expect(config.password).toBe('p;w=x');
    expect(config.database).toBe('d');
  });

  it('unescapes a doubled closing brace inside a braced password', () => {
    const config = parseDsn('Server=h;Database=d;User Id=u;Password={a}}b}');
    expect(config.password).toBe('a}b');
  });

  it('splits a named instance off the server value', () => {
    const config = parseDsn('Server=host\\SQLEXPRESS;Database=d;User Id=u;Password=p');
    expect(config.server).toBe('host');
    expect(config.options?.instanceName).toBe('SQLEXPRESS');
  });

  it('strips the tcp: prefix and reads the comma port', () => {
    const config = parseDsn('Server=tcp:host,14330;Database=d;User Id=u;Password=p');
    expect(config.server).toBe('host');
    expect(config.port).toBe(14330);
  });

  it('converts the ADO Connection Timeout from seconds to milliseconds', () => {
    const config = parseDsn('Server=h;Database=d;User Id=u;Password=p;Connection Timeout=30');
    expect(config.connectionTimeout).toBe(30000);
  });

  it('defaults Encrypt to true and TrustServerCertificate to false', () => {
    const config = parseDsn('Server=h;Database=d;User Id=u;Password=p');
    expect(config.options?.encrypt).toBe(true);
    expect(config.options?.trustServerCertificate).toBe(false);
  });

  it('honours Encrypt=false when the operator opts out explicitly', () => {
    const config = parseDsn('Server=h;Database=d;User Id=u;Password=p;Encrypt=false');
    expect(config.options?.encrypt).toBe(false);
  });
});

describe('MSSQL DSN parsing — URL form', () => {
  it('parses the mssql:// URL form with query-string options', () => {
    const config = parseDsn(
      'mssql://sa:Str0ng!@localhost:1433/mydb?encrypt=true&trustServerCertificate=true',
    );
    expect(config.server).toBe('localhost');
    expect(config.port).toBe(1433);
    expect(config.database).toBe('mydb');
    expect(config.user).toBe('sa');
    expect(config.password).toBe('Str0ng!');
    expect(config.options?.trustServerCertificate).toBe(true);
  });

  it('accepts the sqlserver:// scheme too', () => {
    const config = parseDsn('sqlserver://sa:p@host:1433/db');
    expect(config.server).toBe('host');
    expect(config.database).toBe('db');
  });

  it('percent-decodes credentials', () => {
    const config = parseDsn('mssql://us%40er:p%40ss%3Aword@host:1433/db');
    expect(config.user).toBe('us@er');
    expect(config.password).toBe('p@ss:word');
  });

  it('rejects a URL with no database', () => {
    expect(() => parseDsn('mssql://sa:p@host:1433/')).toThrow(/must include a database name/i);
  });

  it('rejects a URL with no credentials', () => {
    expect(() => parseDsn('mssql://host:1433/db')).toThrow(/login and password/i);
  });
});

describe('MSSQL DSN parsing — rejections', () => {
  it('rejects Windows integrated authentication', () => {
    expect(() => parseDsn('Server=h;Database=d;Integrated Security=true')).toThrow(
      /not supported in this version/i,
    );
  });

  it('rejects Integrated Security=SSPI', () => {
    expect(() => parseDsn('Server=h;Database=d;Integrated Security=SSPI')).toThrow(
      /not supported in this version/i,
    );
  });

  it('rejects Trusted_Connection=yes', () => {
    expect(() => parseDsn('Server=h;Database=d;Trusted_Connection=yes')).toThrow(
      /not supported in this version/i,
    );
  });

  it('rejects an ADO string with no Server', () => {
    expect(() => parseDsn('Database=d;User Id=u;Password=p')).toThrow(/must include a "Server"/i);
  });

  it('rejects an ADO string with no Database', () => {
    expect(() => parseDsn('Server=h;User Id=u;Password=p')).toThrow(/must include a "Database"/i);
  });

  it('rejects an ADO string with no credentials', () => {
    expect(() => parseDsn('Server=h;Database=d')).toThrow(/SQL Server\s+authentication only/i);
  });

  it('rejects an unrecognisable connection string', () => {
    expect(() => parseDsn('just-some-text')).toThrow(/Unrecognised SQL Server connection string/i);
  });
});

describe('quoteMssqlIdent', () => {
  it('bracket-quotes a plain identifier', () => {
    expect(quoteMssqlIdent('orders')).toBe('[orders]');
  });

  it('doubles an embedded closing bracket', () => {
    expect(quoteMssqlIdent('we]ird')).toBe('[we]]ird]');
  });

  it('leaves a name that would otherwise break out of the brackets inert', () => {
    expect(quoteMssqlIdent('a] DROP TABLE t --')).toBe('[a]] DROP TABLE t --]');
  });
});

describe('MSSQLConnector metadata', () => {
  const connector = new MSSQLConnector();

  it('identifies itself as mssql', () => {
    expect(connector.name).toBe('mssql');
    expect(connector.displayName).toBe('SQL Server');
  });

  it('documents both accepted DSN forms in the placeholder', () => {
    expect(connector.placeholderDsn).toContain('Server=');
    expect(connector.placeholderDsn).toContain('mssql://');
  });

  it('reports zeroed pool stats before any connection is opened', () => {
    expect(connector.getPoolStats()).toEqual({ active: 0, idle: 0, waiting: 0, total: 0 });
  });

  it('disconnects cleanly when no pool was ever created', async () => {
    await expect(connector.disconnect()).resolves.toBeUndefined();
  });
});
