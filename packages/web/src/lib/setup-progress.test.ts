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

const salesData = { name: 'sales-config', sources: ['warehouse'] };
const mcp = { name: 'sales', configurations: ['sales-config'] };
const steps = (p: ReturnType<typeof computeSetupProgress>) => [
  p.source,
  p.dataProfile,
  p.mcp,
  p.client,
];

describe('computeSetupProgress', () => {
  it('starts on "connect data" when nothing exists', () => {
    const p = computeSetupProgress({
      sourceCount: 0,
      dataProfiles: [],
      savedProfiles: [],
      auditEntries: [],
    });
    expect(steps(p)).toEqual(['current', 'todo', 'todo', 'todo']);
    expect([p.currentStep, p.nextStep]).toEqual(['source', 'dataProfile']);
    expect(p.mcpName).toBeNull();
    expect(p.allDone).toBe(false);
  });

  it('moves to "create a data profile" once data exists', () => {
    const p = computeSetupProgress({
      sourceCount: 1,
      dataProfiles: [],
      savedProfiles: [],
      auditEntries: [],
    });
    expect(steps(p)).toEqual(['done', 'current', 'todo', 'todo']);
    expect([p.currentStep, p.nextStep]).toEqual(['dataProfile', 'mcp']);
  });

  it('ignores a data profile that contains no data', () => {
    const p = computeSetupProgress({
      sourceCount: 1,
      dataProfiles: [
        { name: 'empty', sources: [] },
        { name: 'legacy', sources: ['default'] },
      ],
      savedProfiles: [],
      auditEntries: [],
    });
    expect(p.dataProfile).toBe('current');
  });

  it('moves to "create the MCP" once a data profile contains data', () => {
    const p = computeSetupProgress({
      sourceCount: 1,
      dataProfiles: [salesData],
      savedProfiles: [],
      auditEntries: [],
    });
    expect(steps(p)).toEqual(['done', 'done', 'current', 'todo']);
    expect(p.dataProfileName).toBe('sales-config');
  });

  it('does not count an MCP that is not attached to a data profile with data', () => {
    const p = computeSetupProgress({
      sourceCount: 1,
      dataProfiles: [salesData, { name: 'empty', sources: [] }],
      // Inline data or an empty profile is not the supported model: an MCP is
      // attached to a data profile, never to data directly.
      savedProfiles: [
        { name: 'default', sources: ['default'] },
        { name: 'inline', sources: [{ id: 'kb' }] },
        { name: 'on-empty', configurations: ['empty'] },
      ],
      auditEntries: [entry('inline'), entry('on-empty')],
    });
    expect(p.mcp).toBe('current');
    expect(p.client).toBe('todo');
  });

  it('moves to "connect and test" once an MCP is attached to a data profile', () => {
    const p = computeSetupProgress({
      sourceCount: 1,
      dataProfiles: [salesData],
      savedProfiles: [mcp],
      auditEntries: [],
    });
    expect(steps(p)).toEqual(['done', 'done', 'done', 'current']);
    expect([p.currentStep, p.nextStep]).toEqual(['client', null]);
    expect(p.mcpName).toBe('sales');
    expect(p.doneCount).toBe(3);
  });

  it('does not complete the client step without a successful call on that MCP', () => {
    const p = computeSetupProgress({
      sourceCount: 1,
      dataProfiles: [salesData],
      savedProfiles: [mcp],
      auditEntries: [entry('sales', 'error'), entry('other-mcp')],
    });
    expect(p.client).toBe('current');
    expect(p.allDone).toBe(false);
  });

  it('completes on a successful audited call and targets the MCP that was used', () => {
    const p = computeSetupProgress({
      sourceCount: 1,
      dataProfiles: [salesData],
      savedProfiles: [mcp, { name: 'docs', configurations: ['sales-config'] }],
      auditEntries: [entry('docs')],
    });
    expect(steps(p)).toEqual(['done', 'done', 'done', 'done']);
    expect(p.mcpName).toBe('docs');
    expect(p.allDone).toBe(true);
  });

  it('never marks a step done while an earlier one is missing', () => {
    const p = computeSetupProgress({
      sourceCount: 0,
      dataProfiles: [salesData],
      savedProfiles: [mcp],
      auditEntries: [entry('sales')],
    });
    expect(steps(p)).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(p.allDone).toBe(false);
  });
});

describe('computeSetupProgress — knowledge-base readiness', () => {
  const kb = (state: 'ready' | 'failed' | 'syncing' | 'not-synced') => ({
    id: `kb-${state}`,
    name: `KB ${state}`,
    state,
    error: state === 'failed' ? '1/1 failed; last: boom' : null,
  });

  it('does not complete "connect a source" when the only source failed to sync', () => {
    const p = computeSetupProgress({
      sourceCount: 0,
      ragSources: [kb('failed')],
      dataProfiles: [],
      savedProfiles: [],
      auditEntries: [],
    });
    expect(p.source).toBe('current');
    expect(p.dataProfile).toBe('todo');
    expect(p.failedSources.map((s) => s.name)).toEqual(['KB failed']);
  });

  it('keeps a saved but not yet indexed source as "not ready"', () => {
    const p = computeSetupProgress({
      sourceCount: 0,
      ragSources: [kb('syncing')],
      dataProfiles: [],
      savedProfiles: [],
      auditEntries: [],
    });
    expect(p.source).toBe('current');
    expect(p.notReadySources).toHaveLength(1);
  });

  it('completes the step once a knowledge base is indexed', () => {
    const p = computeSetupProgress({
      sourceCount: 0,
      ragSources: [kb('ready'), kb('failed')],
      dataProfiles: [],
      savedProfiles: [],
      auditEntries: [],
    });
    expect([p.source, p.dataProfile]).toEqual(['done', 'current']);
  });
});
