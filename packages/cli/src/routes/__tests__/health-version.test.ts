import { afterEach, describe, expect, it, vi } from 'vitest';

describe('health product version', () => {
  afterEach(() => {
    delete process.env.CALAME_VERSION;
    vi.resetModules();
  });

  it('reads the canonical monorepo product version', async () => {
    const { getVersion } = await import('../health.js');

    expect(getVersion()).toBe('0.8.1');
  });

  it('prefers the version injected into packaged builds', async () => {
    process.env.CALAME_VERSION = '9.8.7-test';
    const { getVersion } = await import('../health.js');

    expect(getVersion()).toBe('9.8.7-test');
  });
});
