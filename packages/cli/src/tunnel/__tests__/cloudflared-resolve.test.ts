import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveCloudflaredPath } from '../cloudflared-resolve.js';

describe('resolveCloudflaredPath', () => {
  describe('overridePath (CALAME_CLOUDFLARED_PATH)', () => {
    it('wins when it exists, regardless of packaged mode', () => {
      const result = resolveCloudflaredPath({
        overridePath: '/opt/tools/cloudflared',
        packaged: false,
        existsFn: (p) => p === '/opt/tools/cloudflared',
      });
      expect(result).toEqual({
        path: '/opt/tools/cloudflared',
        available: true,
        unavailableReason: null,
      });
    });

    it('is reported unavailable with a clear reason when the file does not exist', () => {
      const result = resolveCloudflaredPath({
        overridePath: '/does/not/exist/cloudflared',
        packaged: true,
        existsFn: () => false,
      });
      expect(result.path).toBeNull();
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain('/does/not/exist/cloudflared');
      expect(result.unavailableReason).toContain('CALAME_CLOUDFLARED_PATH');
    });

    it('is not consulted when overridePath is an empty string', () => {
      const result = resolveCloudflaredPath({
        overridePath: '',
        packaged: false,
        devCacheDir: '/dev/cache',
        platform: 'linux',
        existsFn: (p) => p === path.posix.join('/dev/cache', 'cloudflared'),
      });
      expect(result.available).toBe(true);
      expect(result.path).toBe(path.posix.join('/dev/cache', 'cloudflared'));
    });
  });

  describe('packaged mode', () => {
    it('resolves cloudflared.exe next to the bundled server on win32', () => {
      const result = resolveCloudflaredPath({
        packaged: true,
        packagedBaseDir: '/opt/calame/resources/server',
        platform: 'win32',
        existsFn: (p) => p === path.win32.join('/opt/calame/resources/server', 'cloudflared.exe'),
      });
      expect(result).toEqual({
        path: path.win32.join('/opt/calame/resources/server', 'cloudflared.exe'),
        available: true,
        unavailableReason: null,
      });
    });

    it('resolves the extension-less cloudflared binary on non-win32 platforms', () => {
      const result = resolveCloudflaredPath({
        packaged: true,
        packagedBaseDir: '/opt/calame/resources/server',
        platform: 'darwin',
        existsFn: (p) => p === path.posix.join('/opt/calame/resources/server', 'cloudflared'),
      });
      expect(result.available).toBe(true);
      expect(result.path).toBe(path.posix.join('/opt/calame/resources/server', 'cloudflared'));
    });

    it('reports unavailable with a reason mentioning the looked-up path when missing', () => {
      const result = resolveCloudflaredPath({
        packaged: true,
        packagedBaseDir: '/opt/calame/resources/server',
        platform: 'win32',
        existsFn: () => false,
      });
      expect(result.path).toBeNull();
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain(
        path.win32.join('/opt/calame/resources/server', 'cloudflared.exe'),
      );
    });

    it("defaults the base dir to this module's own directory when packagedBaseDir is omitted", () => {
      const result = resolveCloudflaredPath({
        packaged: true,
        platform: 'win32',
        existsFn: () => false,
      });
      // Only asserting it doesn't throw and produces a well-formed reason —
      // the real default dir depends on this module's own file location.
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain('cloudflared.exe');
    });
  });

  describe('dev mode (no override, not packaged)', () => {
    it('resolves the cached download when present', () => {
      const result = resolveCloudflaredPath({
        packaged: false,
        devCacheDir: '/repo/node_modules/.cache/calame-desktop',
        platform: 'win32',
        existsFn: (p) =>
          p === path.win32.join('/repo/node_modules/.cache/calame-desktop', 'cloudflared.exe'),
      });
      expect(result).toEqual({
        path: path.win32.join('/repo/node_modules/.cache/calame-desktop', 'cloudflared.exe'),
        available: true,
        unavailableReason: null,
      });
    });

    it('resolves the cached download on a non-win32 platform too', () => {
      const result = resolveCloudflaredPath({
        packaged: false,
        devCacheDir: '/repo/node_modules/.cache/calame-desktop',
        platform: 'linux',
        existsFn: (p) =>
          p === path.posix.join('/repo/node_modules/.cache/calame-desktop', 'cloudflared'),
      });
      expect(result).toEqual({
        path: path.posix.join('/repo/node_modules/.cache/calame-desktop', 'cloudflared'),
        available: true,
        unavailableReason: null,
      });
    });

    it('reports unavailable with a reason pointing at the prepare script when nothing is cached', () => {
      const result = resolveCloudflaredPath({
        packaged: false,
        devCacheDir: '/repo/node_modules/.cache/calame-desktop',
        platform: 'linux',
        existsFn: () => false,
      });
      expect(result.path).toBeNull();
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain('prepare-desktop.mjs');
      expect(result.unavailableReason).toContain('CALAME_CLOUDFLARED_PATH');
    });

    it('uses the real repo-root-relative cache dir when devCacheDir is not overridden', () => {
      const result = resolveCloudflaredPath({
        packaged: false,
        platform: 'win32',
        existsFn: () => false,
      });
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toContain('node_modules');
      expect(result.unavailableReason).toContain('.cache');
      expect(result.unavailableReason).toContain('calame-desktop');
      expect(result.unavailableReason).toContain('cloudflared.exe');
    });
  });
});
