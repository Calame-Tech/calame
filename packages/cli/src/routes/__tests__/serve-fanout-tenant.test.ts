import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { lookupSourceTenant } from '../serve/registration.js';
import type { AppState } from '../../state.js';

function stateWithRawDb(raw: Database.Database | undefined): AppState {
  return (raw ? { db: { raw } } : { db: undefined }) as unknown as AppState;
}

// Regression: the fan-out tenant filter used to query a `rag_connections`
// table that never existed anywhere in the schema — on any live server
// (state.db defined) hitting the fan-out path threw "no such table" and
// broke the profile's MCP registration.
describe('lookupSourceTenant', () => {
  it('returns the default tenant when the rag_sources table does not exist', () => {
    const raw = new Database(':memory:');
    expect(lookupSourceTenant(stateWithRawDb(raw), 'demo-logistique')).toBe('default');
  });

  it('returns the default tenant when there is no row for the source', () => {
    const raw = new Database(':memory:');
    raw.exec(`CREATE TABLE rag_sources (id TEXT PRIMARY KEY, tenant_id TEXT)`);
    expect(lookupSourceTenant(stateWithRawDb(raw), 'unknown-source')).toBe('default');
  });

  it('returns the owning tenant when the source has a row', () => {
    const raw = new Database(':memory:');
    raw.exec(`CREATE TABLE rag_sources (id TEXT PRIMARY KEY, tenant_id TEXT)`);
    raw.prepare(`INSERT INTO rag_sources (id, tenant_id) VALUES (?, ?)`).run('src-1', 'acme');
    expect(lookupSourceTenant(stateWithRawDb(raw), 'src-1')).toBe('acme');
  });

  it('treats a null tenant_id as the default tenant', () => {
    const raw = new Database(':memory:');
    raw.exec(`CREATE TABLE rag_sources (id TEXT PRIMARY KEY, tenant_id TEXT)`);
    raw.prepare(`INSERT INTO rag_sources (id, tenant_id) VALUES (?, ?)`).run('src-2', null);
    expect(lookupSourceTenant(stateWithRawDb(raw), 'src-2')).toBe('default');
  });

  it('returns the default tenant when state.db is undefined', () => {
    expect(lookupSourceTenant(stateWithRawDb(undefined), 'anything')).toBe('default');
  });
});
