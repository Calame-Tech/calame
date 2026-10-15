import { describe, it, expect } from 'vitest';
import { computeRagReadiness } from './rag-source-readiness.js';

describe('computeRagReadiness', () => {
  const sources = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
    { id: 'd', name: 'D' },
  ];

  it('derives each source state from its latest job (newest first)', () => {
    const r = computeRagReadiness(sources, [
      { sourceId: 'a', status: 'failed', error: '1/2 failed; last: x' },
      { sourceId: 'a', status: 'completed', error: null },
      { sourceId: 'b', status: 'completed', error: null },
      { sourceId: 'c', status: 'running', error: null },
    ]);
    expect(r.map((s) => [s.id, s.state, s.error])).toEqual([
      ['a', 'failed', '1/2 failed; last: x'],
      ['b', 'ready', null],
      ['c', 'syncing', null],
      ['d', 'not-synced', null],
    ]);
  });
});
