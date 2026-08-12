import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveMcpRemoteEntry } from '../mcp-remote-resolve.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

describe('resolveMcpRemoteEntry', () => {
  it('packaged mode: joins the (overridable) base dir with mcp-remote.mjs', () => {
    const entry = resolveMcpRemoteEntry({ packaged: true, packagedBaseDir: '/opt/calame/bundle' });
    expect(entry).toBe(path.join('/opt/calame/bundle', 'mcp-remote.mjs'));
  });

  it("packaged mode: defaults the base dir to this module's own directory", () => {
    const entry = resolveMcpRemoteEntry({ packaged: true });
    // ../mcp-remote-resolve.ts lives one directory up from this test file.
    expect(path.dirname(entry)).toBe(path.dirname(THIS_DIR));
    expect(path.basename(entry)).toBe('mcp-remote.mjs');
  });

  it('dev mode: resolves the installed mcp-remote package CLI entry from node_modules', () => {
    const entry = resolveMcpRemoteEntry({ packaged: false });
    expect(entry.replace(/\\/g, '/')).toContain('mcp-remote/dist/proxy.js');
    // The whole point of vendoring: the resolved file must actually exist,
    // so `node <entry> <url> --header ...` can run it directly.
    expect(fs.existsSync(entry)).toBe(true);
  });
});
