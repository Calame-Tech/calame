import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootPackagePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../package.json',
);
const rootPackageVersion = (
  JSON.parse(readFileSync(rootPackagePath, 'utf8')) as {
    version: string;
  }
).version;

describe('health product version', () => {
  afterEach(() => {
    delete process.env.CALAME_VERSION;
    vi.resetModules();
  });

  it('reads the canonical monorepo product version', async () => {
    const { getVersion } = await import('../health.js');

    expect(getVersion()).toBe(rootPackageVersion);
  });

  it('prefers the version injected into packaged builds', async () => {
    process.env.CALAME_VERSION = '9.8.7-test';
    const { getVersion } = await import('../health.js');

    expect(getVersion()).toBe('9.8.7-test');
  });
});
