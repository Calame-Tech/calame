import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  ClaudeDesktopConfigCorruptError,
  listMcpServerEntries,
  readClaudeDesktopConfig,
  upsertMcpServerEntry,
} from '../config-writer.js';

describe('config-writer', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-claude-desktop-test-'));
    configPath = path.join(tmpDir, 'nested', 'claude_desktop_config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readClaudeDesktopConfig', () => {
    it('returns {} when the file (and its directory) do not exist', () => {
      expect(readClaudeDesktopConfig(configPath)).toEqual({});
    });

    it('returns the parsed object for valid JSON', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { foo: { command: 'x', args: [] } } }),
      );
      expect(readClaudeDesktopConfig(configPath)).toEqual({
        mcpServers: { foo: { command: 'x', args: [] } },
      });
    });

    it('throws ClaudeDesktopConfigCorruptError on invalid JSON', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '{ this is not json');
      expect(() => readClaudeDesktopConfig(configPath)).toThrow(ClaudeDesktopConfigCorruptError);
    });

    it('throws ClaudeDesktopConfigCorruptError when the JSON is not an object', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify([1, 2, 3]));
      expect(() => readClaudeDesktopConfig(configPath)).toThrow(ClaudeDesktopConfigCorruptError);
    });
  });

  describe('listMcpServerEntries', () => {
    it('returns {} when the file is missing', () => {
      expect(listMcpServerEntries(configPath)).toEqual({});
    });

    it('swallows corruption and returns {} rather than throwing', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, 'not json at all');
      expect(listMcpServerEntries(configPath)).toEqual({});
    });

    it('returns the mcpServers map when present', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { 'calame-default': { command: 'node', args: ['x'] } } }),
      );
      expect(listMcpServerEntries(configPath)).toEqual({
        'calame-default': { command: 'node', args: ['x'] },
      });
    });
  });

  describe('upsertMcpServerEntry', () => {
    it('creates the directory and file when neither exists, and writes no .bak', () => {
      const merged = upsertMcpServerEntry(configPath, 'calame-default', {
        command: 'node',
        args: [
          '/abs/mcp-remote.mjs',
          'http://127.0.0.1:4567/mcp/default',
          '--header',
          'Authorization: Bearer tok',
        ],
      });

      expect(merged.mcpServers?.['calame-default']).toEqual({
        command: 'node',
        args: [
          '/abs/mcp-remote.mjs',
          'http://127.0.0.1:4567/mcp/default',
          '--header',
          'Authorization: Bearer tok',
        ],
      });
      expect(fs.existsSync(configPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual(merged);

      const siblings = fs.readdirSync(path.dirname(configPath));
      expect(siblings.some((f) => f.endsWith('.bak'))).toBe(false);
    });

    it('merges into an existing file, preserving unrelated keys and other mcpServers entries, and writes a .bak', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const original = {
        someOtherTopLevelSetting: true,
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(original, null, 2));

      const merged = upsertMcpServerEntry(configPath, 'calame-default', {
        command: 'node',
        args: ['/abs/mcp-remote.mjs'],
      });

      expect(merged.someOtherTopLevelSetting).toBe(true);
      expect(merged.mcpServers?.filesystem).toEqual(original.mcpServers.filesystem);
      expect(merged.mcpServers?.['calame-default']).toEqual({
        command: 'node',
        args: ['/abs/mcp-remote.mjs'],
      });

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(onDisk).toEqual(merged);

      const siblings = fs.readdirSync(path.dirname(configPath));
      const backups = siblings.filter((f) => f.endsWith('.bak'));
      expect(backups).toHaveLength(1);
      const backupContent = JSON.parse(
        fs.readFileSync(path.join(path.dirname(configPath), backups[0]), 'utf-8'),
      );
      expect(backupContent).toEqual(original);
    });

    it('overwrites (not appends) when connecting the same profile twice', () => {
      upsertMcpServerEntry(configPath, 'calame-default', { command: 'node', args: ['first'] });
      const merged = upsertMcpServerEntry(configPath, 'calame-default', {
        command: 'node',
        args: ['second'],
      });
      expect(merged.mcpServers?.['calame-default']).toEqual({ command: 'node', args: ['second'] });
      expect(Object.keys(merged.mcpServers ?? {})).toEqual(['calame-default']);
    });

    it('throws on a corrupt existing file and does NOT touch it (no write, no .bak)', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '{ definitely not json');
      const before = fs.readFileSync(configPath, 'utf-8');

      expect(() =>
        upsertMcpServerEntry(configPath, 'calame-default', { command: 'node', args: [] }),
      ).toThrow(ClaudeDesktopConfigCorruptError);

      expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
      const siblings = fs.readdirSync(path.dirname(configPath));
      expect(siblings.filter((f) => f.endsWith('.bak'))).toHaveLength(0);
    });
  });
});
