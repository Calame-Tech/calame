import { describe, it, expect } from 'vitest';
import { buildServerKey } from '../keys.js';

describe('buildServerKey', () => {
  it('uses "calame-<profileName>" for the default tenant', () => {
    expect(buildServerKey('prod')).toBe('calame-prod');
    expect(buildServerKey('prod', 'default')).toBe('calame-prod');
  });

  it('uses "calame-<tenantId>-<profileName>" for a non-default tenant', () => {
    expect(buildServerKey('prod', 'acme-corp')).toBe('calame-acme-corp-prod');
  });
});
