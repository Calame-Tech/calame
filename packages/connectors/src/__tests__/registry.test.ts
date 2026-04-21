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
  it('returns all three connectors', () => {
    const connectors = getAvailableConnectors();
    expect(connectors).toHaveLength(3);
    const names = connectors.map((c) => c.name);
    expect(names).toContain('postgresql');
    expect(names).toContain('mysql');
    expect(names).toContain('sqlite');
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
