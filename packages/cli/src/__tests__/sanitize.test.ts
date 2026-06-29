import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../sanitize.js';

describe('redactSecrets', () => {
  it('masks credentials in a PostgreSQL URL DSN', () => {
    expect(redactSecrets('postgresql://admin:hunter2@db.example.com:5432/mydb')).toBe(
      'postgresql://***@db.example.com:5432/mydb',
    );
  });

  it('masks credentials in a MySQL URL DSN', () => {
    expect(redactSecrets('mysql://root:secret@localhost:3306/testdb')).toBe(
      'mysql://***@localhost:3306/testdb',
    );
  });

  it('masks credentials in a postgres:// (short scheme) URL DSN', () => {
    expect(redactSecrets('postgres://user:pass@host/db')).toBe('postgres://***@host/db');
  });

  it('masks URL-encoded credentials', () => {
    expect(redactSecrets('mysql://my%40user:p%40ss%21@localhost:3306/db')).toBe(
      'mysql://***@localhost:3306/db',
    );
  });

  it('masks a DSN embedded in a driver error message', () => {
    const msg =
      'Error: connect ECONNREFUSED at postgresql://admin:hunter2@db.example.com:5432/mydb';
    expect(redactSecrets(msg)).toBe(
      'Error: connect ECONNREFUSED at postgresql://***@db.example.com:5432/mydb',
    );
  });

  it('masks username-only DSN (no password)', () => {
    expect(redactSecrets('postgres://admin@host/db')).toBe('postgres://***@host/db');
  });

  it('masks libpq key=value password field', () => {
    expect(redactSecrets('host=localhost port=5432 user=admin password=hunter2')).toBe(
      'host=localhost port=5432 user=admin password=***',
    );
  });

  it('masks quoted libpq password values', () => {
    expect(redactSecrets("password='my secret'")).toBe('password=***');
    expect(redactSecrets('password="my secret"')).toBe('password=***');
  });

  it('masks pwd/passwd aliases', () => {
    expect(redactSecrets('pwd=hunter2')).toBe('pwd=***');
    expect(redactSecrets('passwd=hunter2')).toBe('passwd=***');
  });

  it('leaves URLs without userinfo unchanged', () => {
    expect(redactSecrets('http://example.com/path')).toBe('http://example.com/path');
    expect(redactSecrets('https://api.example.com')).toBe('https://api.example.com');
  });

  it('leaves plain error messages unchanged', () => {
    expect(redactSecrets('Connection timed out')).toBe('Connection timed out');
    expect(redactSecrets('Table "users" not found')).toBe('Table "users" not found');
  });

  it('handles empty input', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('masks multiple DSNs in a single string', () => {
    const msg = 'retry postgresql://a:b@h1/d failed, postgresql://c:d@h2/d also failed';
    expect(redactSecrets(msg)).toBe(
      'retry postgresql://***@h1/d failed, postgresql://***@h2/d also failed',
    );
  });
});
