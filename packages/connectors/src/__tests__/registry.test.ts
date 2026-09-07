import { describe, it, expect } from 'vitest';
import { getConnector, getAvailableConnectors } from '../index.js';
import type { DatabaseType } from '../types.js';

describe('getConnector', () => {
  it('returns the postgresql connector', () => {
    const connector = getConnector('postgresql');
    expect(connector.name).toBe('postgresql');
    expect(connector.displayName).toBe('PostgreSQL');
    expect(connector.placeholderDsn).toContain('postgresql://');
  });

  it('returns the mysql connector', () => {
    const connector = getConnector('mysql');
    expect(connector.name).toBe('mysql');
    expect(connector.placeholderDsn).toContain('mysql://');
  });

  it('returns the sqlite connector', () => {
    const connector = getConnector('sqlite');
    expect(connector.name).toBe('sqlite');
    expect(connector.placeholderDsn).toContain('sqlite://');
  });

  it('returns the mssql connector', () => {
    const connector = getConnector('mssql');
    expect(connector.name).toBe('mssql');
    expect(connector.displayName).toBe('SQL Server');
    // The placeholder documents both accepted DSN forms.
    expect(connector.placeholderDsn).toContain('Server=');
    expect(connector.placeholderDsn).toContain('mssql://');
  });

  it('returns a stable singleton — same reference on repeated calls', () => {
    const a = getConnector('postgresql');
    const b = getConnector('postgresql');
    expect(a).toBe(b);
  });

  it('throws for an unregistered type', () => {
    // Force an invalid type past TypeScript
    expect(() => getConnector('oracle' as DatabaseType)).toThrow(
      /No connector registered for database type/,
    );
  });
});

describe('getAvailableConnectors', () => {
  it('returns every registered connector', () => {
    const connectors = getAvailableConnectors();
    expect(connectors).toHaveLength(4);
    const names = connectors.map((c) => c.name);
    expect(names).toContain('postgresql');
    expect(names).toContain('mysql');
    expect(names).toContain('sqlite');
    expect(names).toContain('mssql');
  });

  it('every connector implements the DatabaseConnector interface shape', () => {
    const connectors = getAvailableConnectors();
    for (const connector of connectors) {
      expect(typeof connector.name).toBe('string');
      expect(typeof connector.displayName).toBe('string');
      expect(typeof connector.placeholderDsn).toBe('string');
      expect(typeof connector.testConnection).toBe('function');
      expect(typeof connector.introspect).toBe('function');
      expect(typeof connector.disconnect).toBe('function');
    }
  });
});
