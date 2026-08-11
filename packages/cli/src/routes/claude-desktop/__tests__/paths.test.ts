import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveClaudeDesktopConfigDir, resolveClaudeDesktopConfigPath } from '../paths.js';

describe('resolveClaudeDesktopConfigDir', () => {
  it('overrideDir always wins, regardless of platform', () => {
    expect(
      resolveClaudeDesktopConfigDir({ overrideDir: '/tmp/fake-claude', platform: 'win32' }),
    ).toBe('/tmp/fake-claude');
  });

  it('win32: uses APPDATA\\Claude when APPDATA is set', () => {
    const dir = resolveClaudeDesktopConfigDir({
      platform: 'win32',
      homedir: 'C:\\Users\\tom',
      env: { APPDATA: 'C:\\Users\\tom\\AppData\\Roaming' },
    });
    expect(dir).toBe(path.win32.join('C:\\Users\\tom\\AppData\\Roaming', 'Claude'));
  });

  it('win32: falls back to <home>\\AppData\\Roaming\\Claude when APPDATA is unset', () => {
    const dir = resolveClaudeDesktopConfigDir({
      platform: 'win32',
      homedir: 'C:\\Users\\tom',
      env: {},
    });
    expect(dir).toBe(path.win32.join('C:\\Users\\tom', 'AppData', 'Roaming', 'Claude'));
  });

  it('darwin: uses ~/Library/Application Support/Claude', () => {
    const dir = resolveClaudeDesktopConfigDir({
      platform: 'darwin',
      homedir: '/Users/tom',
      env: {},
    });
    expect(dir).toBe(path.posix.join('/Users/tom', 'Library', 'Application Support', 'Claude'));
  });

  it('linux: uses $XDG_CONFIG_HOME/Claude when set', () => {
    const dir = resolveClaudeDesktopConfigDir({
      platform: 'linux',
      homedir: '/home/tom',
      env: { XDG_CONFIG_HOME: '/home/tom/.xdgconfig' },
    });
    expect(dir).toBe(path.posix.join('/home/tom/.xdgconfig', 'Claude'));
  });

  it('linux: falls back to ~/.config/Claude when XDG_CONFIG_HOME is unset', () => {
    const dir = resolveClaudeDesktopConfigDir({
      platform: 'linux',
      homedir: '/home/tom',
      env: {},
    });
    expect(dir).toBe(path.posix.join('/home/tom', '.config', 'Claude'));
  });
});

describe('resolveClaudeDesktopConfigPath', () => {
  it('appends claude_desktop_config.json to the resolved directory', () => {
    const p = resolveClaudeDesktopConfigPath({ overrideDir: '/tmp/fake-claude' });
    expect(p).toBe(path.join('/tmp/fake-claude', 'claude_desktop_config.json'));
  });
});
