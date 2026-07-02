import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { buildMaskingRules, applyMasking, type MaskingRule } from '../masking.js';
import type { ColumnMasking } from '../../../pii/types.js';

describe('buildMaskingRules', () => {
  it('skips columns with maskingMode "none"', () => {
    const cfg: Record<string, ColumnMasking> = {
      a: { maskingMode: 'none' } as ColumnMasking,
      b: { maskingMode: 'hash' } as ColumnMasking,
    };
    const rules = buildMaskingRules(cfg);
    expect(rules.a).toBeUndefined();
    expect(rules.b).toEqual({ mode: 'hash' });
  });

  it('carries replaceValue for "replace" mode', () => {
    const cfg: Record<string, ColumnMasking> = {
      email: { maskingMode: 'replace', replaceValue: '[hidden]' } as ColumnMasking,
    };
    expect(buildMaskingRules(cfg).email).toEqual({ mode: 'replace', replaceValue: '[hidden]' });
  });

  it('defaults truncate options (showFirst=1, showLast=0)', () => {
    const cfg: Record<string, ColumnMasking> = {
      phone: { maskingMode: 'truncate' } as ColumnMasking,
    };
    expect(buildMaskingRules(cfg).phone).toEqual({ mode: 'truncate', showFirst: 1, showLast: 0 });
  });
});

describe('applyMasking', () => {
  it('returns rows unchanged when there are no rules', () => {
    const rows = [{ a: 1 }];
    expect(applyMasking(rows, {})).toBe(rows);
  });

  it('excludes columns for "exclude" and "aggregate_only"', () => {
    const rules: Record<string, MaskingRule> = {
      secret: { mode: 'exclude' },
      total: { mode: 'aggregate_only' },
    };
    const [out] = applyMasking([{ id: 1, secret: 'x', total: 9 }], rules);
    expect(out).toEqual({ id: 1 });
  });

  it('replaces, truncates, and hashes values', () => {
    const rules: Record<string, MaskingRule> = {
      r: { mode: 'replace', replaceValue: '[X]' },
      t: { mode: 'truncate', showFirst: 2, showLast: 2 },
      h: { mode: 'hash' },
    };
    const [out] = applyMasking([{ r: 'visible', t: 'abcdefgh', h: 'secret' }], rules);
    expect(out.r).toBe('[X]');
    expect(out.t).toBe('ab...gh');
    expect(out.h).toBe(createHash('sha256').update('secret').digest('hex'));
  });

  it('does not mutate the source rows and skips absent columns', () => {
    const rows = [{ id: 1 }];
    const out = applyMasking(rows, { missing: { mode: 'exclude' } });
    expect(out[0]).toEqual({ id: 1 });
    expect(out[0]).not.toBe(rows[0]);
  });
});
