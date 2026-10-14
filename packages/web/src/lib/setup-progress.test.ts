import { describe, it, expect } from 'vitest';
import { computeSetupProgress } from './setup-progress.js';
import type { AuditLogEntry } from '../types/schema.js';

function entry(profileName: string, result: 'success' | 'error' = 'success'): AuditLogEntry {
  return {
    id: `${profileName}-${result}`,
    timestamp: '2026-10-14T10:00:00.000Z',
    profileName,
    toolName: 'query',
    toolArgs: {},
    result,
    durationMs: 3,
  };
}

const mcp = { name: 'sales', configurations: ['sales-config'] };

describe('computeSetupProgress', () => {
  it('starts on "connect a source" when nothing exists', () => {
    const p = computeSetupProgress({ sourceCount: 0, savedProfiles: [], auditEntries: [] });
    expect([p.source, p.mcp, p.client]).toEqual(['current', 'todo', 'todo']);
    expect(p.mcpName).toBeNull();
    expect(p.allDone).toBe(false);
  });

  it('moves to "create the MCP" once a source exists', () => {
    const p = computeSetupProgress({ sourceCount: 1, savedProfiles: [], auditEntries: [] });
    expect([p.source, p.mcp, p.client]).toEqual(['done', 'current', 'todo']);
  });

  it('ignores saved profiles without data (e.g. the "default" placeholder)', () => {
    const p = computeSetupProgress({
      sourceCount: 1,
      // Shape actually returned by GET /api/profiles/load for the placeholder
      // re-persisted after deleting the last MCP (connections backfilled to
      // ['default'], then upgraded to sources).
      savedProfiles: [
        { name: 'default', sources: ['default'] },
        { name: 'empty', configurations: [], sources: ['default'] },
      ],
      auditEntries: [entry('default')],
    });
    expect(p.mcp).toBe('current');
    expect(p.client).toBe('todo');
  });

  it('moves to "use it from a client" once an MCP with data is saved', () => {
    const p = computeSetupProgress({ sourceCount: 1, savedProfiles: [mcp], auditEntries: [] });
    expect([p.source, p.mcp, p.client]).toEqual(['done', 'done', 'current']);
    expect(p.mcpName).toBe('sales');
  });

  it('does not complete the client step without a successful call on that MCP', () => {
    const p = computeSetupProgress({
      sourceCount: 1,
      savedProfiles: [mcp],
      auditEntries: [entry('sales', 'error'), entry('other-mcp')],
    });
    expect(p.client).toBe('current');
    expect(p.allDone).toBe(false);
  });

  it('completes on a successful audited call and targets the MCP that was used', () => {
    const p = computeSetupProgress({
      sourceCount: 1,
      savedProfiles: [mcp, { name: 'docs', sources: [{ id: 'kb' }] }],
      auditEntries: [entry('docs')],
    });
    expect(p.client).toBe('done');
    expect(p.mcpName).toBe('docs');
    expect(p.allDone).toBe(true);
  });
});
