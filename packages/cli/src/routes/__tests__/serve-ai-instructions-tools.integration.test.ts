/**
 * Per-profile AI instructions: short reminder appended to the `rag_*` tool
 * descriptions (for clients that ignore `initialize.instructions`), read by a
 * real MCP SDK client through `registerServeRoute`.
 *
 * Matrix: `/mcp/<profile>` and `/mcp/<tenant>/<profile>` × API-key auth and
 * Calame/OAuth auth. The RAG runtime is a minimal stand-in that registers
 * `rag_*` tools with fixed descriptions; everything else (route, auth, tenant
 * resolution, source lookup, tool registration) is real. All data lives in a
 * throwaway temp directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sourceAdapterRegistry, type ServeProfile, type SourceAdapter } from '@calame/core';
import { AppState } from '../../state.js';
import { CalameDatabase } from '../../database.js';
import { UserManager } from '../../user.js';
import { TokenManager } from '../../token.js';
import { registerServeRoute } from '../serve.js';
import {
  AI_INSTRUCTIONS_TOOL_SUFFIX_MAX_LENGTH,
  appendAiInstructionsToRagTools,
  buildToolDescriptionSuffix,
  trackRegisteredTools,
} from '../../profile-ai-instructions.js';

const ADAPTER_TYPE = 'test-ai-instructions-docs';
const SEARCH_DESCRIPTION = 'Search the indexed documents of this profile.';
const LIST_DESCRIPTION = 'List the document sources available to this profile.';
const DEFAULT_TEXT =
  'Lis d’abord 00-LISEZ-MOI.md.\nUtilise rag_append_note pour ajouter à une note.';
const ACME_TEXT = 'ACME only: rag_write_document replaces a whole file.';

type AuthMode = 'token' | 'calame' | 'oauth';
type ListedTool = { name: string; description?: string };

describe('rag_* tool descriptions — real SDK client', () => {
  let dir: string;
  let db: CalameDatabase;
  let state: AppState;
  let listener: Server;
  let origin: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calame-ai-instructions-tools-'));
    db = new CalameDatabase(dir);
    db.raw.exec(`CREATE TABLE IF NOT EXISTS rag_sources (
      id TEXT PRIMARY KEY, type TEXT, name TEXT, config_encrypted TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default', deleted_at TEXT
    )`);
    for (const [id, tenant] of [
      ['docs-default', 'default'],
      ['docs-acme', 'acme'],
    ]) {
      db.raw
        .prepare(
          'INSERT INTO rag_sources (id, type, name, config_encrypted, tenant_id) VALUES (?,?,?,?,?)',
        )
        .run(id, ADAPTER_TYPE, id, '{}', tenant);
    }
    sourceAdapterRegistry.register({
      type: ADAPTER_TYPE,
      capabilities: ['read'],
    } as unknown as SourceAdapter);

    state = new AppState();
    state.db = db;
    state.userManager = new UserManager(db);
    state.tokenManager = new TokenManager(db);
    state.ragRuntime = {
      decryptConfig: (value: string) => value,
      documentAdapterDeps: {},
      ragCore: {
        registerMergedDocumentRagTools: (opts: {
          server: McpServer;
          tenantId: string;
          sources: Array<{ source: { name: string } }>;
        }) => {
          const names = opts.sources.map((s) => s.source.name).join(',');
          opts.server.tool('rag_search', SEARCH_DESCRIPTION, { query: z.string() }, async () => ({
            content: [{ type: 'text', text: JSON.stringify({ tenant: opts.tenantId, names }) }],
          }));
          opts.server.tool('rag_list_sources', LIST_DESCRIPTION, {}, async () => ({
            content: [{ type: 'text', text: JSON.stringify({ sources: names }) }],
          }));
        },
      },
    } as unknown as NonNullable<AppState['ragRuntime']>;

    const app = express();
    app.use(express.json());
    registerServeRoute(app, state);
    listener = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    sourceAdapterRegistry.unregister(ADAPTER_TYPE);
    db.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  function profile(
    name: string,
    authMode: AuthMode,
    sourceId: string,
    aiInstructions?: string,
  ): ServeProfile {
    return {
      name,
      label: name,
      authMode,
      sources: [sourceId],
      scopes: { [sourceId]: { kind: 'document', mode: 'allowAll' } },
      ...(aiInstructions !== undefined ? { aiInstructions } : {}),
    } as ServeProfile;
  }

  /** Default tenant: in-memory profiles. `acme`: profiles row in the DB. */
  function serve(defaults: ServeProfile[], acme: ServeProfile[] = []): void {
    state.serveProfiles = Object.fromEntries(defaults.map((p) => [p.name, p]));
    for (const p of defaults) state.activeProfileNames.add(p.name);
    if (acme.length > 0) {
      db.raw
        .prepare("INSERT OR REPLACE INTO profiles (key, data, tenant_id) VALUES ('main', ?, ?)")
        .run(
          JSON.stringify({ profiles: Object.fromEntries(acme.map((p) => [p.name, p])) }),
          'acme',
        );
    }
  }

  /** Throwaway credential for the given auth mode, scoped to (tenant, profile). */
  function credential(authMode: AuthMode, profileName: string, tenantId: string): string {
    if (authMode === 'token') {
      return state.tokenManager!.generateToken(profileName, 'test key', tenantId)._plaintextToken;
    }
    const user = state.userManager!.createUser({
      name: 'Test User',
      email: `user-${Math.random().toString(36).slice(2)}@example.test`,
      role: 'user',
      profiles: [{ profileName, allowedTables: null, allowedTools: null, accessMode: 'mcp' }],
      tenantId,
    });
    return state.userManager!.enableUser(user.id)!._plaintextToken;
  }

  async function listTools(mcpPath: string, token: string): Promise<Map<string, ListedTool>> {
    const client = new Client({ name: 'calame-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}${mcpPath}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      return new Map(tools.map((t) => [t.name, t]));
    } finally {
      await client.close();
    }
  }

  async function connect(mcpPath: string, token: string) {
    const client = new Client({ name: 'calame-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}${mcpPath}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return client;
  }

  for (const authMode of ['token', 'calame', 'oauth'] as const) {
    describe(`authMode=${authMode}`, () => {
      it('/mcp/<profile> appends the profile reminder to rag_* descriptions only', async () => {
        serve(
          [profile('demo', authMode, 'docs-default', DEFAULT_TEXT)],
          [profile('demo', authMode, 'docs-acme', ACME_TEXT)],
        );
        const tools = await listTools('/mcp/demo', credential(authMode, 'demo', 'default'));
        const suffix = buildToolDescriptionSuffix({ aiInstructions: DEFAULT_TEXT })!;
        expect(suffix).toBe(
          '\n\nProfile instructions: Lis d’abord 00-LISEZ-MOI.md. (full instructions sent at connection)',
        );
        expect(tools.get('rag_search')?.description).toBe(SEARCH_DESCRIPTION + suffix);
        expect(tools.get('rag_list_sources')?.description).toBe(LIST_DESCRIPTION + suffix);
        expect(tools.get('calc')?.description).not.toContain('Profile instructions');
        for (const tool of tools.values()) expect(tool.description).not.toContain('ACME only');
      });

      it('/mcp/<tenant>/<profile> uses that tenant profile reminder only', async () => {
        serve(
          [profile('demo', authMode, 'docs-default', DEFAULT_TEXT)],
          [profile('demo', authMode, 'docs-acme', ACME_TEXT)],
        );
        const tools = await listTools('/mcp/acme/demo', credential(authMode, 'demo', 'acme'));
        const suffix = buildToolDescriptionSuffix({ aiInstructions: ACME_TEXT })!;
        expect(suffix).toBe(`\n\nProfile instructions: ${ACME_TEXT}`);
        expect(tools.get('rag_search')?.description).toBe(SEARCH_DESCRIPTION + suffix);
        expect(tools.get('rag_list_sources')?.description).toBe(LIST_DESCRIPTION + suffix);
        for (const tool of tools.values()) expect(tool.description).not.toContain('00-LISEZ-MOI');
      });

      it('keeps descriptions unchanged on both routes when instructions are empty', async () => {
        serve(
          [
            profile('absent', authMode, 'docs-default'),
            profile('blank', authMode, 'docs-default', ' \n\t '),
          ],
          [profile('empty', authMode, 'docs-acme', '')],
        );
        const cases: Array<[string, string, string]> = [
          ['/mcp/absent', 'absent', 'default'],
          ['/mcp/blank', 'blank', 'default'],
          ['/mcp/acme/empty', 'empty', 'acme'],
        ];
        for (const [mcpPath, name, tenant] of cases) {
          const tools = await listTools(mcpPath, credential(authMode, name, tenant));
          expect(tools.get('rag_search')?.description).toBe(SEARCH_DESCRIPTION);
          expect(tools.get('rag_list_sources')?.description).toBe(LIST_DESCRIPTION);
        }
      });
    });
  }

  it('does not leak the reminder to another profile of the same tenant', async () => {
    serve([
      profile('demo', 'token', 'docs-default', DEFAULT_TEXT),
      profile('other', 'token', 'docs-default'),
    ]);
    // Connect to `demo` first so a leaked registration would show up on `other`.
    await listTools('/mcp/demo', credential('token', 'demo', 'default'));
    const tools = await listTools('/mcp/other', credential('token', 'other', 'default'));
    expect(tools.get('rag_search')?.description).toBe(SEARCH_DESCRIPTION);
    expect(tools.get('rag_list_sources')?.description).toBe(LIST_DESCRIPTION);
  });

  it('never injects the instructions into tool results', async () => {
    serve([profile('demo', 'token', 'docs-default', DEFAULT_TEXT)]);
    const client = await connect('/mcp/demo', credential('token', 'demo', 'default'));
    try {
      for (const [name, args] of [
        ['rag_search', { query: 'lisez-moi' }],
        ['rag_list_sources', {}],
        ['calc', { expression: '1+1' }],
      ] as const) {
        const result = JSON.stringify(await client.callTool({ name, arguments: args }));
        expect(result).not.toContain('00-LISEZ-MOI');
        expect(result).not.toContain('rag_append_note');
        expect(result).not.toContain('Profile instructions');
      }
    } finally {
      await client.close();
    }
  });
});

describe('buildToolDescriptionSuffix', () => {
  it('returns undefined for absent, empty or whitespace-only instructions', () => {
    expect(buildToolDescriptionSuffix(undefined)).toBeUndefined();
    expect(buildToolDescriptionSuffix({})).toBeUndefined();
    expect(buildToolDescriptionSuffix({ aiInstructions: '' })).toBeUndefined();
    expect(buildToolDescriptionSuffix({ aiInstructions: ' \n\t' })).toBeUndefined();
    expect(buildToolDescriptionSuffix({ aiInstructions: 42 })).toBeUndefined();
  });

  it('uses the first non-empty line and points to the full text when more follows', () => {
    expect(buildToolDescriptionSuffix({ aiInstructions: 'Single rule.' })).toBe(
      '\n\nProfile instructions: Single rule.',
    );
    expect(buildToolDescriptionSuffix({ aiInstructions: '\n\n  # Guide  \r\nSecond' })).toBe(
      '\n\nProfile instructions: # Guide (full instructions sent at connection)',
    );
  });

  it('truncates long lines within the limit, marks the cut and is deterministic', () => {
    const long = 'x'.repeat(500);
    const suffix = buildToolDescriptionSuffix({ aiInstructions: long })!;
    expect(suffix.length).toBeLessThanOrEqual(AI_INSTRUCTIONS_TOOL_SUFFIX_MAX_LENGTH);
    expect(suffix.length).toBe(AI_INSTRUCTIONS_TOOL_SUFFIX_MAX_LENGTH);
    expect(suffix).toMatch(
      /^\n\nProfile instructions: x+… \(full instructions sent at connection\)$/,
    );
    expect(buildToolDescriptionSuffix({ aiInstructions: long })).toBe(suffix);
  });

  it('stays within the limit at every boundary length and never splits a surrogate pair', () => {
    for (let n = 150; n <= 220; n++) {
      for (const text of ['a'.repeat(n), `${'a'.repeat(n)}\nnext`, '😀'.repeat(n)]) {
        const suffix = buildToolDescriptionSuffix({ aiInstructions: text })!;
        expect(suffix.length).toBeLessThanOrEqual(AI_INSTRUCTIONS_TOOL_SUFFIX_MAX_LENGTH);
        expect(suffix).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      }
    }
  });
});

describe('appendAiInstructionsToRagTools', () => {
  function fakeServer() {
    const make = (description?: string) => {
      const tool = {
        description,
        update: (u: { description?: string }) => {
          tool.description = u.description;
        },
      };
      return tool;
    };
    return {
      tool: (_name: string, description?: string) => make(description),
      registerTool: (_name: string, config: { description?: string }) => make(config.description),
    };
  }

  it('appends to rag_* tools only and keeps the original text verbatim', () => {
    const server = fakeServer();
    const tracked = trackRegisteredTools(server);
    const search = server.tool('rag_search', 'Original search.');
    const write = server.registerTool('rag_write_document', { description: 'Original write.' });
    const calc = server.tool('calc', 'Calculator.');
    const query = server.tool('query_items', 'Query rag_ rows.');
    appendAiInstructionsToRagTools(tracked, '\n\nProfile instructions: R');
    expect(search.description).toBe('Original search.\n\nProfile instructions: R');
    expect(write.description).toBe('Original write.\n\nProfile instructions: R');
    expect(calc.description).toBe('Calculator.');
    expect(query.description).toBe('Query rag_ rows.');
  });

  it('changes nothing when the suffix is empty', () => {
    const server = fakeServer();
    const tracked = trackRegisteredTools(server);
    const search = server.tool('rag_search', 'Original search.');
    appendAiInstructionsToRagTools(tracked, undefined);
    appendAiInstructionsToRagTools(tracked, '');
    expect(search.description).toBe('Original search.');
  });
});
