// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Input validation of the merged rag_* tools through a real MCP SDK
 * client/server pair (initialize → tools/list → tools/call), so the Zod
 * schemas are exercised exactly as an MCP client would hit them.
 *
 * Covered: valid arguments reach the search index; invalid and oversized
 * arguments (huge arrays, out-of-range numbers) are refused before any
 * handler runs, without hanging or crashing the server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerMergedDocumentRagTools } from '../merged-rag-tools.js';
import type { DocumentAdapterDeps } from '../source-adapter.js';
import type { Source } from '@calame/core';

const source: Source = {
  id: 'src-1',
  name: 'My KB',
  type: 'local',
  configEncrypted: '',
  capabilities: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('merged rag_* tools — input validation over a real MCP client', () => {
  let search: ReturnType<typeof vi.fn>;
  let listDocuments: ReturnType<typeof vi.fn>;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    search = vi.fn().mockResolvedValue({ chunks: [] });
    listDocuments = vi.fn().mockResolvedValue([]);
    const deps: DocumentAdapterDeps = {
      resolveConnector: vi.fn().mockReturnValue(null),
      storage: {
        listFolders: vi.fn().mockResolvedValue([]),
        listDocuments,
        getDocument: vi.fn().mockResolvedValue(null),
        listSources: vi.fn().mockResolvedValue([]),
        getDocumentFolderChain: vi.fn().mockResolvedValue([]),
      },
      searchIndex: { search },
    } as unknown as DocumentAdapterDeps;

    server = new McpServer({ name: 'calame-test', version: '1.0.0' });
    registerMergedDocumentRagTools({
      server,
      deps,
      tenantId: 'tenant-abc',
      sources: [
        {
          source,
          selection: {
            kind: 'document',
            mode: 'allowAll',
            allowedFolders: [],
            allowedDocuments: [],
          },
          config: { root: '/data' },
        },
      ],
      profileName: 'test-profile',
      responseMode: 'raw',
      onAuditLog: vi.fn(),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'calame-test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('completes initialize and lists the rag_* tools', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'calame-test' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['rag_search', 'rag_list_documents']),
    );
  });

  it('accepts valid arguments and reaches the search index', async () => {
    const result = await client.callTool({
      name: 'rag_search',
      arguments: { query: 'hello', topK: 10, folders: ['docs'], minSimilarity: 0.3 },
    });
    expect(result.isError).toBeFalsy();
    expect(search).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing query', {}],
    ['empty query', { query: '' }],
    ['topK of the wrong type', { query: 'q', topK: 'ten' }],
    ['topK below the minimum', { query: 'q', topK: 0 }],
    ['non-integer topK', { query: 'q', topK: 2.5 }],
    ['minSimilarity out of range', { query: 'q', minSimilarity: 2 }],
    ['folders not an array', { query: 'q', folders: 'docs' }],
  ])('refuses invalid arguments (%s) before searching', async (_label, args) => {
    const result = await client.callTool({ name: 'rag_search', arguments: args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/validation/i);
    expect(search).not.toHaveBeenCalled();
  });

  it('refuses oversized arguments quickly, without calling the handler', async () => {
    const started = Date.now();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['rag_search', { query: 'q', topK: Number.MAX_SAFE_INTEGER }],
      ['rag_search', { query: 'q', topK: 1e308 }],
      ['rag_search', { query: 'q', folders: [...Array(100_000).fill('docs'), 42] }],
      ['rag_search', { query: 'q', fileTypes: Array(100_000).fill(1) }],
      ['rag_list_documents', { folder: '', limit: 1_000_000 }],
    ];
    for (const [name, args] of cases) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/validation/i);
    }
    expect(search).not.toHaveBeenCalled();
    expect(listDocuments).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(10_000);

    // The server is still usable afterwards.
    const ok = await client.callTool({ name: 'rag_search', arguments: { query: 'q' } });
    expect(ok.isError).toBeFalsy();
  });
});
