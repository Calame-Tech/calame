import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, isPackagedMode, getPackagedDataDir } from '../config.js';

// ---------------------------------------------------------------------------
// Packaged desktop mode (CALAME_PACKAGED) — dataDir defaulting
// ---------------------------------------------------------------------------
//
// All existing (non-packaged) behavior must remain unchanged: dataDir keeps
// defaulting to process.cwd() unless CALAME_DATA_DIR is set. In packaged mode
// (no pnpm workspace, no writable monorepo checkout around the bundled
// server), the default switches to the platform app-data directory instead —
// unless CALAME_DATA_DIR is explicitly set, which always keeps priority.

const ENV_KEYS = ['CALAME_PACKAGED', 'CALAME_DATA_DIR', 'CALAME_WEB_DIST'] as const;

describe('packaged mode config', () => {
  let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('isPackagedMode() is false when CALAME_PACKAGED is unset', () => {
    expect(isPackagedMode()).toBe(false);
  });

  it('isPackagedMode() is true for "1" and "true"', () => {
    process.env.CALAME_PACKAGED = '1';
    expect(isPackagedMode()).toBe(true);

    process.env.CALAME_PACKAGED = 'true';
    expect(isPackagedMode()).toBe(true);
  });

  it('isPackagedMode() is false for any other value', () => {
    process.env.CALAME_PACKAGED = '0';
    expect(isPackagedMode()).toBe(false);
  });

  it('defaults dataDir to process.cwd() when not packaged (unchanged behavior)', () => {
    const config = loadConfig();
    expect(config.packaged).toBe(false);
    expect(config.dataDir).toBe(process.cwd());
  });

  it('defaults dataDir to the platform app-data dir when packaged and CALAME_DATA_DIR is unset', () => {
    process.env.CALAME_PACKAGED = '1';

    const config = loadConfig();
    expect(config.packaged).toBe(true);
    expect(config.dataDir).toBe(getPackagedDataDir());
    expect(config.dataDir).not.toBe(process.cwd());
  });

  it('CALAME_DATA_DIR keeps priority over the packaged default', () => {
    process.env.CALAME_PACKAGED = '1';
    process.env.CALAME_DATA_DIR = '/custom/calame-data';

    const config = loadConfig();
    expect(config.dataDir).toBe('/custom/calame-data');
  });

  it('CALAME_DATA_DIR keeps priority over process.cwd() when not packaged (unchanged behavior)', () => {
    process.env.CALAME_DATA_DIR = '/custom/calame-data';

    const config = loadConfig();
    expect(config.dataDir).toBe('/custom/calame-data');
  });

  it('webDistPath defaults to null and is overridable via CALAME_WEB_DIST', () => {
    const defaultConfig = loadConfig();
    expect(defaultConfig.webDistPath).toBeNull();

    process.env.CALAME_WEB_DIST = '/opt/calame/web-dist';
    const overriddenConfig = loadConfig();
    expect(overriddenConfig.webDistPath).toBe('/opt/calame/web-dist');
  });
});
