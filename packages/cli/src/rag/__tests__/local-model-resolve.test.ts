import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveLocalModelDir, stripWindowsLongPathPrefix } from '../local-model-resolve.js';

const MODEL_FOLDER = 'embeddinggemma-300m';

describe('stripWindowsLongPathPrefix', () => {
  it('strips the drive-letter extended-length prefix', () => {
    expect(stripWindowsLongPathPrefix('\\\\?\\C:\\Users\\X\\AppData\\Local\\Calame')).toBe(
      'C:\\Users\\X\\AppData\\Local\\Calame',
    );
  });

  it('strips the UNC extended-length prefix and restores the leading \\\\', () => {
    expect(stripWindowsLongPathPrefix('\\\\?\\UNC\\server\\share\\models')).toBe(
      '\\\\server\\share\\models',
    );
  });

  it('leaves a plain Windows path untouched', () => {
    expect(stripWindowsLongPathPrefix('C:\\Users\\X\\models')).toBe('C:\\Users\\X\\models');
  });

  it('leaves a POSIX path untouched', () => {
    expect(stripWindowsLongPathPrefix('/opt/models')).toBe('/opt/models');
  });
});

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

    it('strips a Windows extended-length (\\\\?\\) prefix before validating and returning the path', () => {
      const strippedPath = 'C:\\Users\\X\\AppData\\Local\\Calame\\resources\\server\\models';
      const result = resolveLocalModelDir({
        overridePath: '\\\\?\\' + strippedPath,
        packaged: false,
        platform: 'win32',
        existsFn: (p) => p === path.win32.join(strippedPath, MODEL_FOLDER, 'config.json'),
      });
      expect(result).toEqual({ path: strippedPath, available: true, unavailableReason: null });
    });

    it('strips a Windows extended-length UNC (\\\\?\\UNC\\) prefix before validating and returning the path', () => {
      const strippedPath = '\\\\server\\share\\models';
      const result = resolveLocalModelDir({
        overridePath: '\\\\?\\UNC\\server\\share\\models',
        packaged: false,
        platform: 'win32',
        existsFn: (p) => p === path.win32.join(strippedPath, MODEL_FOLDER, 'config.json'),
      });
      expect(result).toEqual({ path: strippedPath, available: true, unavailableReason: null });
    });

    it('reports the stripped path in unavailableReason when the extended-length override is missing the model', () => {
      const strippedPath = 'C:\\Users\\X\\models';
      const result = resolveLocalModelDir({
        overridePath: '\\\\?\\' + strippedPath,
        packaged: false,
        platform: 'win32',
        existsFn: () => false,
      });
      expect(result.path).toBeNull();
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain(strippedPath);
      expect(result.unavailableReason).not.toContain('\\\\?\\');
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

    it('strips a Windows extended-length (\\\\?\\) prefix from packagedBaseDir', () => {
      const strippedBaseDir = 'C:\\Users\\X\\AppData\\Local\\Calame\\resources\\server';
      const result = resolveLocalModelDir({
        packaged: true,
        packagedBaseDir: '\\\\?\\' + strippedBaseDir,
        platform: 'win32',
        existsFn: (p) =>
          p === path.win32.join(strippedBaseDir, 'models', MODEL_FOLDER, 'config.json'),
      });
      expect(result).toEqual({
        path: path.win32.join(strippedBaseDir, 'models'),
        available: true,
        unavailableReason: null,
      });
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
