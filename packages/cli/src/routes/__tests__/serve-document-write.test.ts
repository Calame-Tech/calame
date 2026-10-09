import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { ServeProfile } from '@calame/core';

// Only unrelated registration plumbing is replaced. The host's resolveTarget,
// SQL source lookup, document tools, and disk I/O are real.
vi.mock('@calame/core', async (original) => {
  const actual = await original<typeof import('@calame/core')>();
  return {
    ...actual,
    registerCalcTool: vi.fn(),
    sourceAdapterRegistry: { get: () => ({ type: 'local', capabilities: ['read'] }), register: vi.fn() },
  };
});

import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { registerToolsViaAdapters } from '../serve/registration.js';
import { loadServeProfileForTenant } from '../serve/routing.js';
import { readConfigurationsFile } from '../configurations.js';
import { mergeConfigurations } from '../serve/tool-merger.js';
import { registerDocumentWriteTools } from '../../../../../ee/rag-core/src/write-tools.js';

type Reply = { content: Array<{ text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;

describe('document writes through the real host registration', () => {
  let dir: string;
  let db: CalameDatabase;
  let state: AppState;
  let profile: ServeProfile;
  let handlers: Map<string, Handler>;
  let triggerSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'calame-host-write-'));
    await mkdir(path.join(dir, 'notes'));
    await mkdir(path.join(dir, 'temp'));
    db = new CalameDatabase(dir);
    db.raw.exec(`CREATE TABLE IF NOT EXISTS rag_sources (
      id TEXT PRIMARY KEY, type TEXT, name TEXT, config_encrypted TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default', deleted_at TEXT
    ); CREATE TABLE IF NOT EXISTS rag_documents (
      source_id TEXT, path TEXT, hash TEXT, deleted_at TEXT
    );`);
    for (const id of ['local', 'other']) {
      db.raw.prepare('INSERT INTO rag_sources (id,type,name,config_encrypted) VALUES (?,?,?,?)')
        .run(id, 'local', id, JSON.stringify({ rootPath: dir }));
    }
    handlers = new Map();
    triggerSync = vi.fn().mockReturnValue('test-sync');
    state = new AppState();
    state.db = db;
    state.ragRuntime = {
      decryptConfig: (value: string) => value,
      triggerSync,
      documentAdapterDeps: {},
      ragCore: { registerDocumentWriteTools, registerMergedDocumentRagTools: vi.fn() },
    } as unknown as NonNullable<AppState['ragRuntime']>;
    profile = {
      label: 'Host test', sources: ['local', 'other'],
      scopes: {
        local: { kind: 'document', mode: 'allowAll' },
        other: { kind: 'document', mode: 'allowAll' },
      },
      documentWrite: { enabled: true, sources: { local: {} } },
    } as unknown as ServeProfile;
    state.serveProfiles.notes = profile;
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function register(tenantId = 'default', actualServer?: McpServer) {
    const liveProfile = loadServeProfileForTenant(state, tenantId, 'notes');
    if (!liveProfile) throw new Error('Missing profile fixture');
    const file = readConfigurationsFile(db, tenantId);
    const configs = (liveProfile.configurations ?? []).map((name) => file.configurations[name]).filter(Boolean);
    const merged = mergeConfigurations(configs);
    const server = actualServer ?? {
      tool: (name: string, ...args: unknown[]) => {
        handlers.set(name, args[args.length - 1] as Handler);
      },
    } as unknown as McpServer;
    await registerToolsViaAdapters({
      mcpServer: server, profile: liveProfile, state, profileName: 'notes', tenantId,
      profileConnections: [], effectiveSelectedTables: {},
      effectiveTableOptions: undefined, effectiveColumnMasking: undefined,
      effectiveDocumentScopes: merged.documentScopes, scopeGuard: {} as never,
      responseMode: 'raw', wrapResponse: (value) => value,
      resolvedTokenLabel: 'host-regression',
    });
  }

  async function call(name: string, args: Record<string, unknown>) {
    const handler = handlers.get(name);
    if (!handler) throw new Error('Tool is not registered');
    const reply = await handler(args);
    return { ...JSON.parse(reply.content[0]!.text), isError: reply.isError === true };
  }

  async function mkdirp(dir: string) {
    await mkdir(dir, { recursive: true });
  }

  const write = (source = 'local', filename = 'nationex.md') =>
    call('rag_write_document', { source, path: filename, content: '---\nstatus: open\n---\nResume' });

  it.skipIf(!process.env.CALAME_TEST_MCP_PORT)('smokes actual MCP HTTP tools/list and tools/call with live revocation', async () => {
    const port = Number(process.env.CALAME_TEST_MCP_PORT);
    if (!Number.isInteger(port) || port < 8100 || port > 8199) throw new Error('Smoke port must be prechecked in 8100-8199');
    const mcp = new McpServer({ name: 'calame-document-write-smoke', version: '1' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const client = new Client({ name: 'write-smoke-client', version: '1' });
    await register('default', mcp);
    await mcp.connect(transport);
    const app = express();
    app.use(express.json());
    app.all('/mcp', (req, res) => {
      void transport.handleRequest(req, res, req.body).catch(() => { if (!res.headersSent) res.sendStatus(500); });
    });
    const listener = app.listen(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(['rag_write_document', 'rag_read_note']);
      const savedReply = await client.callTool({ name: 'rag_write_document', arguments: {
        source: 'local', path: 'protocol.md', content: 'Actual MCP round-trip',
      } });
      const saved = JSON.parse((savedReply.content as Array<{ text: string }>)[0]!.text);
      expect(saved).toMatchObject({ saved: true, operation: 'created' });
      const readReply = await client.callTool({ name: 'rag_read_note', arguments: { source: 'local', path: 'protocol.md' } });
      expect(JSON.parse((readReply.content as Array<{ text: string }>)[0]!.text))
        .toMatchObject({ content: 'Actual MCP round-trip', version: saved.version });
      state.serveProfiles.notes = { ...profile, documentWrite: { enabled: false, sources: {} } };
      const refused = await client.callTool({ name: 'rag_write_document', arguments: {
        source: 'local', path: 'protocol.md', content: 'denied', expectedVersion: saved.version,
      } });
      expect(refused.isError).toBe(true);
      expect(JSON.parse((refused.content as Array<{ text: string }>)[0]!.text).code).toBe('not_permitted');
      expect(await readFile(path.join(dir, 'protocol.md'), 'utf8')).toBe('Actual MCP round-trip');
    } finally {
      await client.close();
      await mcp.close();
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  }, 15_000);

  it.each([undefined, { enabled: false, sources: { local: {} } }])(
    'does not register callable document tools when disabled or absent: %j', async (setting) => {
      profile.documentWrite = setting;
      await register();
      expect([...handlers.keys()]).not.toContain('rag_write_document');
      expect([...handlers.keys()]).not.toContain('rag_read_note');
      await expect(write()).rejects.toThrow('Tool is not registered');
    },
  );

  it('registers both tools only with an explicit local-source grant', async () => {
    await register();
    expect([...handlers.keys()]).toEqual(['rag_write_document', 'rag_read_note']);
  });

  it('does not turn a readable source into a writable source', async () => {
    await register();
    expect(await write('other')).toMatchObject({ isError: true, code: 'not_permitted' });
  });

  it('refuses a source outside the profile scope even if granted', async () => {
    profile.sources = ['local'];
    delete profile.scopes!.other;
    profile.documentWrite!.sources.other = {};
    await register();
    expect(await write('other')).toMatchObject({ isError: true, code: 'not_permitted' });
  });

  it.each([
    "UPDATE rag_sources SET type = 's3' WHERE id = 'local'",
    "UPDATE rag_sources SET deleted_at = 'deleted' WHERE id = 'local'",
    "UPDATE rag_sources SET tenant_id = 'another' WHERE id = 'local'",
  ])('rechecks source ownership/type/deletion on each call: %s', async (sql) => {
    await register();
    db.raw.exec(sql);
    expect(await write()).toMatchObject({ isError: true, code: 'not_permitted' });
  });

  it('honors explicit disable in an already-registered session', async () => {
    await register();
    state.serveProfiles.notes = { ...profile, documentWrite: { enabled: false, sources: {} } };
    expect(await write()).toMatchObject({ isError: true, code: 'not_permitted' });
  });

  it('creates and reads back real bytes/frontmatter, requests indexing, and refuses stale updates', async () => {
    await register();
    const saved = await write();
    expect(saved).toMatchObject({ saved: true, indexing: { status: 'queued', indexed: false } });
    expect(triggerSync).toHaveBeenCalledWith('local');
    const read = await call('rag_read_note', { source: 'local', path: 'nationex.md' });
    expect(read.content).toBe(await readFile(path.join(dir, 'nationex.md'), 'utf8'));
    expect(read.version).toBe(saved.version);
    expect(read.indexed).toBe(false);
    const updated = await call('rag_write_document', {
      source: 'local', path: 'nationex.md', content: 'Updated', expectedVersion: read.version,
    });
    expect(updated).toMatchObject({ saved: true, operation: 'replaced' });
    expect(await call('rag_write_document', {
      source: 'local', path: 'nationex.md', content: 'Lost update', expectedVersion: read.version,
    })).toMatchObject({ code: 'version_conflict', isError: true });
    expect(await readFile(path.join(dir, 'nationex.md'), 'utf8')).toBe('Updated');
    // This harness deliberately does not fabricate an indexed row. A real
    // pipeline integration test is still required to prove indexed=true.
  });

  it('fails closed when the live profile is removed', async () => {
    await register();
    delete state.serveProfiles.notes;
    expect(await write()).toMatchObject({ isError: true, code: 'not_permitted' });
  });

  it('rechecks removal of the source from the live profile scope', async () => {
    await register();
    state.serveProfiles.notes = { ...profile, sources: [], scopes: {} };
    expect(await write()).toMatchObject({ isError: true, code: 'not_permitted' });
  });

  it('does not read outside the document allowList through the note tool', async () => {
    // Prepare an allowed write before narrowing read access; this keeps setup
    // independent of the policy assertion below.
    await register();
    await write();
    handlers.clear();
    profile.scopes!.local = {
      kind: 'document', mode: 'allowList', allowedFolders: ['restricted'], allowedDocuments: [],
    } as never;
    await register();
    expect(await call('rag_read_note', { source: 'local', path: 'nationex.md' }))
      .toMatchObject({ isError: true });
  });

  // =======================================================================
  // Non-default tenant: profile stored in SQLite, config_json path
  // =======================================================================

  it('loads a non-default tenant profile from the real DB and allows create/read/write', async () => {
    // Write a profile for tenant-test into the profiles table.
    const tenantId = 'tenant-test';
    db.raw.prepare("UPDATE rag_sources SET tenant_id = ? WHERE id = 'local'").run(tenantId);
    const tenantProfile = {
      label: 'Tenant test',
      sources: ['local'],
      scopes: {
        local: { kind: 'document', mode: 'allowAll' },
      },
      documentWrite: { enabled: true, sources: { local: {} } },
    };
    db.raw
      .prepare("INSERT INTO profiles (key, data, tenant_id) VALUES ('main', ?, ?)")
      .run(JSON.stringify({ profiles: { notes: tenantProfile } }), tenantId);

    handlers.clear();
    await register(tenantId);
    expect([...handlers.keys()]).toEqual(['rag_write_document', 'rag_read_note']);

    // Create a file.
    const saved = await write();
    expect(saved).toMatchObject({ saved: true });

    // Read it back.
    const read = await call('rag_read_note', { source: 'local', path: 'nationex.md' });
    expect(read.content).toBe(await readFile(path.join(dir, 'nationex.md'), 'utf8'));
    expect(read.version).toBe(saved.version);

    // DB updates must revoke both operations in this already-open session.
    db.raw.prepare("UPDATE profiles SET data = ? WHERE key = 'main' AND tenant_id = ?")
      .run(JSON.stringify({ profiles: { notes: { ...tenantProfile, documentWrite: { enabled: false, sources: {} } } } }), tenantId);
    expect(await call('rag_read_note', { source: 'local', path: 'nationex.md' }))
      .toMatchObject({ isError: true, code: 'not_permitted' });
    expect(await write()).toMatchObject({ isError: true, code: 'not_permitted' });
    db.raw.prepare("DELETE FROM profiles WHERE key = 'main' AND tenant_id = ?").run(tenantId);
    expect(await call('rag_read_note', { source: 'local', path: 'nationex.md' }))
      .toMatchObject({ isError: true, code: 'not_permitted' });
    expect(await write()).toMatchObject({ isError: true, code: 'not_permitted' });
  });

  it('denies read+write after config_json is deleted for a non-default tenant', async () => {
    const tenantId = 'tenant-test-2';
    db.raw.prepare("UPDATE rag_sources SET tenant_id = ? WHERE id = 'local'").run(tenantId);
    const tenantProfile = {
      label: 'Tenant test 2',
      sources: ['local'],
      scopes: {
        local: { kind: 'document', mode: 'allowAll' },
      },
      documentWrite: { enabled: true, sources: { local: {} } },
      configurations: ['tenant-cfg'],
    };
    db.raw
      .prepare("INSERT INTO profiles (key, data, tenant_id) VALUES ('main', ?, ?)")
      .run(JSON.stringify({ profiles: { notes: tenantProfile } }), tenantId);

    // Write a configuration row for this tenant.
    db.raw
      .prepare(
        `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('tenant-cfg', 'Tenant Config', '["local"]', '{}', tenantId);

    // Initial registration: should succeed because config_json exists.
    handlers.clear();
    await register(tenantId);
    expect([...handlers.keys()]).toEqual(['rag_write_document', 'rag_read_note']);
    const saved = await write();
    expect(saved.saved).toBe(true);

    // Now delete the configuration row.
    db.raw.prepare('DELETE FROM configurations WHERE name = ? AND tenant_id = ?').run('tenant-cfg', tenantId);

    // Both read and write must now fail because the config path returns empty scopes.
    expect(await write()).toMatchObject({ isError: true, code: 'not_permitted' });
    expect(await call('rag_read_note', { source: 'local', path: 'nationex.md' }))
      .toMatchObject({ isError: true, code: 'not_permitted' });
  });

  // =======================================================================
  // Config scope reduction: linked-data config narrows allowedFolders
  // =======================================================================

  it('config scope with allowedFolders narrows write+read to that folder', async () => {
    const tenantId = 'tenant-test-3';
    db.raw.prepare("UPDATE rag_sources SET tenant_id = ? WHERE id = 'local'").run(tenantId);
    const tenantProfile = {
      label: 'Tenant test 3',
      sources: ['local'],
      scopes: {
        local: { kind: 'document', mode: 'allowAll' },
      },
      documentWrite: { enabled: true, sources: { local: {} } },
      configurations: ['cfg-narrow'],
    };
    db.raw
      .prepare("INSERT INTO profiles (key, data, tenant_id) VALUES ('main', ?, ?)")
      .run(JSON.stringify({ profiles: { notes: tenantProfile } }), tenantId);

    // Write a configuration that restricts the source to the 'notes' folder only.
    db.raw
      .prepare(
        `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id, sources_scopes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'cfg-narrow',
        'Narrow Config',
        '["local"]',
        '{}',
        tenantId,
        JSON.stringify({
          name: 'cfg-narrow',
          label: 'Narrow Config',
          sources: ['local'],
          scopes: { local: { kind: 'document', mode: 'allowList', allowedFolders: ['notes'], allowedDocuments: [] } },
        }),
      );

    // Register with the non-default tenant.
    handlers.clear();
    await register(tenantId);
    expect([...handlers.keys()]).toEqual(['rag_write_document', 'rag_read_note']);

    // Write a file inside the allowed folder.
    const saved = await call('rag_write_document', { source: 'local', path: 'notes/example.md', content: 'hello' });
    expect(saved).toMatchObject({ saved: true });

    // Read it back.
    const read = await call('rag_read_note', { source: 'local', path: 'notes/example.md' });
    expect(read.content).toBe('hello');

    // Write outside the allowed folder must be denied.
    expect(await call('rag_write_document', { source: 'local', path: 'other.md', content: 'nope' }))
      .toMatchObject({ isError: true, code: 'outside_authorized_folder' });

    // Read outside the allowed folder must be denied.
    expect(await call('rag_read_note', { source: 'local', path: 'other.md' }))
      .toMatchObject({ isError: true, code: 'outside_authorized_folder' });

    // Tighten the persisted configuration without reconnecting the MCP session.
    db.raw.prepare('UPDATE configurations SET sources_scopes = ? WHERE name = ? AND tenant_id = ?')
      .run(JSON.stringify({ name: 'cfg-narrow', label: 'Narrow Config', sources: ['local'], scopes: {
        local: { kind: 'document', mode: 'allowList', allowedFolders: ['temp'], allowedDocuments: [] },
      } }), 'cfg-narrow', tenantId);
    expect(await call('rag_read_note', { source: 'local', path: 'notes/example.md' }))
      .toMatchObject({ isError: true, code: 'outside_authorized_folder' });
    expect(await call('rag_write_document', {
      source: 'local', path: 'notes/example.md', content: 'denied', expectedVersion: saved.version,
    })).toMatchObject({ isError: true, code: 'outside_authorized_folder' });
    expect(await readFile(path.join(dir, 'notes/example.md'), 'utf8')).toBe('hello');
  });

  it('config deletion denies read and write for a non-default tenant', async () => {
    const tenantId = 'tenant-test-4';
    db.raw.prepare("UPDATE rag_sources SET tenant_id = ? WHERE id = 'local'").run(tenantId);
    const tenantProfile = {
      label: 'Tenant test 4',
      sources: ['local'],
      scopes: {
        local: { kind: 'document', mode: 'allowAll' },
      },
      documentWrite: { enabled: true, sources: { local: {} } },
      configurations: ['cfg-to-delete'],
    };
    db.raw
      .prepare("INSERT INTO profiles (key, data, tenant_id) VALUES ('main', ?, ?)")
      .run(JSON.stringify({ profiles: { notes: tenantProfile } }), tenantId);

    db.raw
      .prepare(
        `INSERT INTO configurations (name, label, connections, selected_tables, tenant_id, sources_scopes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'cfg-to-delete',
        'Delete Me',
        '["local"]',
        '{}',
        tenantId,
        JSON.stringify({
          name: 'cfg-to-delete',
          label: 'Delete Me',
          sources: ['local'],
          scopes: { local: { kind: 'document', mode: 'allowList', allowedFolders: ['temp'], allowedDocuments: [] } },
        }),
      );

    handlers.clear();
    await register(tenantId);
    expect([...handlers.keys()]).toEqual(['rag_write_document', 'rag_read_note']);

    // Delete the configuration row.
    db.raw.prepare('DELETE FROM configurations WHERE name = ? AND tenant_id = ?').run('cfg-to-delete', tenantId);

    // Both read and write must fail.
    expect(await write()).toMatchObject({ isError: true, code: 'not_permitted' });
    expect(await call('rag_read_note', { source: 'local', path: 'nationex.md' }))
      .toMatchObject({ isError: true, code: 'not_permitted' });
  });

  // =======================================================================
  // allowedFolders narrowing: create notes/example.md, reject root, reduce live
  // =======================================================================

  it('allowedFolders:[notes] authorizes create/read notes/example.md and rejects root example.md', async () => {
    // Reuse the default tenant with a profile that has allowedFolders: ['notes'].
    handlers.clear();
    profile.scopes!.local = {
      kind: 'document', mode: 'allowList', allowedFolders: ['notes'], allowedDocuments: [],
    } as never;
    await register();
    expect([...handlers.keys()]).toEqual(['rag_write_document', 'rag_read_note']);

    // Create the notes folder first (write tool requires parent folders to exist).
    await mkdirp(path.join(dir, 'notes'));

    // Create inside allowed folder.
    const saved = await call('rag_write_document', { source: 'local', path: 'notes/example.md', content: 'inside' });
    expect(saved).toMatchObject({ saved: true });

    // Read it back.
    const read = await call('rag_read_note', { source: 'local', path: 'notes/example.md' });
    expect(read.content).toBe('inside');

    // Create at root should be denied.
    expect(await call('rag_write_document', { source: 'local', path: 'example.md', content: 'root' }))
      .toMatchObject({ isError: true, code: 'outside_authorized_folder' });
  });

  it('reducing live allowedFolders rejects previously allowed file read+replace', async () => {
    // Start with a broad scope, create a file, then narrow.
    await register();
    const saved = await write();
    expect(saved.saved).toBe(true);

    // Now narrow allowedFolders to a folder that does not contain nationex.md.
    state.serveProfiles.notes = {
      ...profile, scopes: {
        ...profile.scopes,
        local: { kind: 'document', mode: 'allowList', allowedFolders: ['forbidden'], allowedDocuments: [] },
      },
    };

    // Read must fail.
    expect(await call('rag_read_note', { source: 'local', path: 'nationex.md' }))
      .toMatchObject({ isError: true, code: 'outside_authorized_folder' });

    // Replace must fail.
    expect(await call('rag_write_document', {
      source: 'local', path: 'nationex.md', content: 'updated', expectedVersion: saved.version,
    })).toMatchObject({ isError: true, code: 'outside_authorized_folder' });
  });

  it('directFetchDisabled on a scope denies rag_read_note for that source', async () => {
    handlers.clear();
    profile.scopes!.local = {
      kind: 'document', mode: 'allowAll', directFetchDisabled: true,
    } as never;
    await register();
    expect([...handlers.keys()]).toEqual(['rag_write_document', 'rag_read_note']);

    // Read must be denied because directFetchDisabled blocks the note tool.
    expect(await call('rag_read_note', { source: 'local', path: 'nationex.md' }))
      .toMatchObject({ isError: true, code: 'outside_authorized_folder' });

    // Write should also fail because insideReadScope checks directFetchDisabled.
    expect(await call('rag_write_document', { source: 'local', path: 'notes/test.md', content: 'x' }))
      .toMatchObject({ isError: true, code: 'outside_authorized_folder' });
  });

  // =======================================================================
  // Default tenant via DB: loadServeProfileForTenant uses AppState cache
  // =======================================================================

  it('default tenant profile is served from AppState cache, not the DB', async () => {
    // Insert a conflicting profile into the DB for the default tenant.
    const dbProfile = {
      label: 'DB Profile',
      sources: [],
      scopes: {},
      documentWrite: { enabled: true, sources: {} },
    };
    db.raw
      .prepare("INSERT OR REPLACE INTO profiles (key, data, tenant_id) VALUES ('main', ?, ?)")
      .run(JSON.stringify({ profiles: { notes: dbProfile } }), 'default');

    // The default tenant should still serve the in-memory profile (which has
    // sources: ['local', 'other'] and documentWrite enabled for 'local').
    handlers.clear();
    await register('default');
    expect([...handlers.keys()]).toEqual(['rag_write_document', 'rag_read_note']);
  });
});
