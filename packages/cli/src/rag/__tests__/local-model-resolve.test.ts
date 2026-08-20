import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveLocalModelDir } from '../local-model-resolve.js';

const MODEL_FOLDER = 'embeddinggemma-300m';

describe('resolveLocalModelDir', () => {
  describe('overridePath (CALAME_LOCAL_EMBEDDING_MODEL_DIR)', () => {
    it('wins when the model folder exists there, regardless of packaged mode', () => {
      const result = resolveLocalModelDir({
        overridePath: '/opt/models',
        packaged: false,
        platform: 'linux',
        existsFn: (p) => p === path.posix.join('/opt/models', MODEL_FOLDER, 'config.json'),
      });
      expect(result).toEqual({ path: '/opt/models', available: true, unavailableReason: null });
    });

    it('is reported unavailable with a clear reason when config.json does not exist there', () => {
      const result = resolveLocalModelDir({
        overridePath: '/opt/wrong-dir',
        packaged: true,
        existsFn: () => false,
      });
      expect(result.path).toBeNull();
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain('/opt/wrong-dir');
      expect(result.unavailableReason).toContain('CALAME_LOCAL_EMBEDDING_MODEL_DIR');
    });

    it('is not consulted when overridePath is an empty string', () => {
      const result = resolveLocalModelDir({
        overridePath: '',
        packaged: false,
        devCacheDir: '/dev/cache',
        platform: 'linux',
        readdirFn: (dir) => (dir === path.posix.join('/dev/cache', 'models') ? ['rev-abc'] : []),
        existsFn: (p) =>
          p === path.posix.join('/dev/cache', 'models', 'rev-abc', MODEL_FOLDER, 'config.json'),
      });
      expect(result.available).toBe(true);
      expect(result.path).toBe(path.posix.join('/dev/cache', 'models', 'rev-abc'));
    });
  });

  describe('packaged mode', () => {
    it('resolves models/ next to the bundled server on win32', () => {
      const result = resolveLocalModelDir({
        packaged: true,
        packagedBaseDir: 'C:\\Program Files\\Calame\\resources\\server',
        platform: 'win32',
        existsFn: (p) =>
          p ===
          path.win32.join(
            'C:\\Program Files\\Calame\\resources\\server',
            'models',
            MODEL_FOLDER,
            'config.json',
          ),
      });
      expect(result).toEqual({
        path: path.win32.join('C:\\Program Files\\Calame\\resources\\server', 'models'),
        available: true,
        unavailableReason: null,
      });
    });

    it('reports unavailable with a reason mentioning the looked-up path when missing', () => {
      const result = resolveLocalModelDir({
        packaged: true,
        packagedBaseDir: '/opt/calame/resources/server',
        platform: 'linux',
        existsFn: () => false,
      });
      expect(result.path).toBeNull();
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain(
        path.posix.join('/opt/calame/resources/server', 'models', MODEL_FOLDER, 'config.json'),
      );
    });

    it("defaults the base dir to this module's own directory when packagedBaseDir is omitted", () => {
      const result = resolveLocalModelDir({
        packaged: true,
        platform: 'linux',
        existsFn: () => false,
      });
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain(MODEL_FOLDER);
    });
  });

  describe('dev mode (no override, not packaged)', () => {
    it('globs the cache dir and resolves whichever revision has a valid model folder', () => {
      const result = resolveLocalModelDir({
        packaged: false,
        devCacheDir: '/repo/node_modules/.cache/calame-desktop',
        platform: 'linux',
        readdirFn: (dir) =>
          dir === path.posix.join('/repo/node_modules/.cache/calame-desktop', 'models')
            ? ['5090578d9565bb06545b4552f76e6bc2c93e4a66']
            : [],
        existsFn: (p) =>
          p ===
          path.posix.join(
            '/repo/node_modules/.cache/calame-desktop',
            'models',
            '5090578d9565bb06545b4552f76e6bc2c93e4a66',
            MODEL_FOLDER,
            'config.json',
          ),
      });
      expect(result.available).toBe(true);
      expect(result.path).toBe(
        path.posix.join(
          '/repo/node_modules/.cache/calame-desktop',
          'models',
          '5090578d9565bb06545b4552f76e6bc2c93e4a66',
        ),
      );
    });

    it('skips a revision directory without a valid model and picks the next one', () => {
      const result = resolveLocalModelDir({
        packaged: false,
        devCacheDir: '/cache',
        platform: 'linux',
        readdirFn: (dir) =>
          dir === path.posix.join('/cache', 'models') ? ['stale-rev', 'good-rev'] : [],
        existsFn: (p) =>
          p === path.posix.join('/cache', 'models', 'good-rev', MODEL_FOLDER, 'config.json'),
      });
      expect(result.available).toBe(true);
      expect(result.path).toBe(path.posix.join('/cache', 'models', 'good-rev'));
    });

    it('reports unavailable with a reason pointing at "pnpm model:fetch" when nothing is cached', () => {
      const result = resolveLocalModelDir({
        packaged: false,
        devCacheDir: '/cache',
        platform: 'linux',
        readdirFn: () => [],
        existsFn: () => false,
      });
      expect(result.path).toBeNull();
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain('pnpm model:fetch');
      expect(result.unavailableReason).toContain('CALAME_LOCAL_EMBEDDING_MODEL_DIR');
    });

    it('does not throw when the models cache directory does not exist at all', () => {
      const result = resolveLocalModelDir({
        packaged: false,
        devCacheDir: '/cache',
        platform: 'linux',
        readdirFn: () => {
          throw new Error('ENOENT: no such file or directory');
        },
        existsFn: () => false,
      });
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain('pnpm model:fetch');
    });

    it('uses the real repo-root-relative cache dir when devCacheDir is not overridden', () => {
      const result = resolveLocalModelDir({
        packaged: false,
        platform: 'win32',
        readdirFn: () => [],
        existsFn: () => false,
      });
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain('node_modules');
      expect(result.unavailableReason).toContain('.cache');
      expect(result.unavailableReason).toContain('calame-desktop');
      expect(result.unavailableReason).toContain('models');
    });
  });
});
