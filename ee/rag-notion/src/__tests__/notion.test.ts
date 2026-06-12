// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mock @notionhq/client.
//
// We hoist a single mocked Client instance per test and rebind its methods
// via `mockedNotion`. The `Client` exported by the mocked module is a class
// whose constructor returns the shared instance — so every `new Client(...)`
// call inside the connector hits the same mock.
//
// Errors / APIErrorCode are re-exported from the real module for type
// compatibility — the connector imports them as values, not just as types.
// ---------------------------------------------------------------------------

interface MockedNotionApi {
  users: { me: ReturnType<typeof vi.fn> };
  databases: {
    retrieve: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
  pages: { retrieve: ReturnType<typeof vi.fn> };
  blocks: { children: { list: ReturnType<typeof vi.fn> } };
  search: ReturnType<typeof vi.fn>;
}

let mockedNotion: MockedNotionApi;

vi.mock('@notionhq/client', () => {
  class Client {
    users = {
      me: (...args: unknown[]) => mockedNotion.users.me(...args),
    };
    databases = {
      retrieve: (...args: unknown[]) => mockedNotion.databases.retrieve(...args),
      query: (...args: unknown[]) => mockedNotion.databases.query(...args),
    };
    pages = {
      retrieve: (...args: unknown[]) => mockedNotion.pages.retrieve(...args),
    };
    blocks = {
      children: {
        list: (...args: unknown[]) => mockedNotion.blocks.children.list(...args),
      },
    };
    search = (...args: unknown[]) => mockedNotion.search(...args);
  }

  // Minimal stand-ins for APIResponseError / APIErrorCode — the connector
  // uses these for `instanceof` checks in error mapping. Real SDK errors
  // will arrive as plain objects in tests; we set `status` to drive the
  // status-based branches.
  class APIResponseError extends Error {
    code: string;
    status: number;
    constructor(opts: { code: string; status: number; message: string }) {
      super(opts.message);
      this.code = opts.code;
      this.status = opts.status;
      this.name = 'APIResponseError';
    }
  }
  const APIErrorCode = {
    Unauthorized: 'unauthorized',
    ObjectNotFound: 'object_not_found',
    RateLimited: 'rate_limited',
  } as const;

  return { Client, APIResponseError, APIErrorCode };
});

// Import AFTER the mock is registered.
import {
  NotionConnector,
  NotionAuthError,
  NotionDocumentNotFoundError,
  NotionRateLimitError,
  __testing,
} from '../notion.js';
import type { RagFolder } from '@calame-ee/rag-core';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

// 32 lowercase hex chars (no hyphens) — internal normalized form.
const PAGE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PAGE_ID_DASHED = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DB_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DB_ID_DASHED = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PAGE_ID_2 = 'cccccccccccccccccccccccccccccccc';

const baseConfig = {
  apiKey: 'secret_FAKE_KEY_FOR_TESTS',
};

beforeEach(() => {
  mockedNotion = {
    users: { me: vi.fn() },
    databases: { retrieve: vi.fn(), query: vi.fn() },
    pages: { retrieve: vi.fn() },
    blocks: { children: { list: vi.fn() } },
    search: vi.fn(),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpErr(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

async function drainToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Build a full Notion page object (search/query result shape). */
function fakePage(
  opts: {
    id?: string;
    title?: string;
    last_edited_time?: string;
    archived?: boolean;
    titleProp?: string;
  } = {},
): unknown {
  const propName = opts.titleProp ?? 'title';
  const titleText = opts.title ?? 'Hello';
  return {
    object: 'page',
    id: opts.id ?? PAGE_ID_DASHED,
    archived: opts.archived ?? false,
    last_edited_time: opts.last_edited_time ?? '2026-05-01T00:00:00Z',
    properties: {
      [propName]: {
        type: 'title',
        title: [
          {
            plain_text: titleText,
            annotations: {},
          },
        ],
      },
    },
  };
}

/** Build a Notion database object (search/retrieve result shape). */
function fakeDb(opts: { id?: string; title?: string; created_time?: string } = {}): unknown {
  return {
    object: 'database',
    id: opts.id ?? DB_ID_DASHED,
    created_time: opts.created_time ?? '2026-04-01T00:00:00Z',
    title: [{ plain_text: opts.title ?? 'My DB', annotations: {} }],
  };
}

// ===========================================================================
// testConnection
// ===========================================================================

describe('NotionConnector.testConnection', () => {
  it('resolves when users.me succeeds', async () => {
    mockedNotion.users.me.mockResolvedValueOnce({ object: 'user', id: 'bot' });
    const c = new NotionConnector();
    await expect(c.testConnection(baseConfig)).resolves.toBeUndefined();
    expect(mockedNotion.users.me).toHaveBeenCalledWith({});
  });

  it('throws NotionAuthError on HTTP 401', async () => {
    mockedNotion.users.me.mockRejectedValueOnce(httpErr(401));
    const c = new NotionConnector();
    await expect(c.testConnection(baseConfig)).rejects.toBeInstanceOf(NotionAuthError);
  });

  it('surfaces network errors with a clear message', async () => {
    mockedNotion.users.me.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const c = new NotionConnector();
    await expect(c.testConnection(baseConfig)).rejects.toThrow(/cannot reach the API/i);
  });
});

// ===========================================================================
// normalizeId / denormalizeId
// ===========================================================================

describe('normalizeId / denormalizeId', () => {
  it('strips hyphens and lowercases', () => {
    expect(__testing.normalizeId('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')).toBe(PAGE_ID);
    expect(__testing.normalizeId(PAGE_ID)).toBe(PAGE_ID);
  });

  it('returns "" for malformed ids', () => {
    expect(__testing.normalizeId('too-short')).toBe('');
    expect(__testing.normalizeId('not-hex-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe('');
    expect(__testing.normalizeId('')).toBe('');
  });

  it('round-trips normalize → denormalize', () => {
    const denormalized = __testing.denormalizeId(PAGE_ID);
    expect(denormalized).toBe(PAGE_ID_DASHED);
    expect(__testing.normalizeId(denormalized)).toBe(PAGE_ID);
  });

  it('denormalize returns input when not 32-hex-chars', () => {
    expect(__testing.denormalizeId('garbage')).toBe('garbage');
  });
});

// ===========================================================================
// narrowConfig
// ===========================================================================

describe('narrowConfig', () => {
  it('accepts a minimal config with just apiKey', () => {
    const out = __testing.narrowConfig({ apiKey: 'secret_AAA' });
    expect(out.apiKey).toBe('secret_AAA');
    expect(out.maxBlockDepth).toBe(5);
    expect(out.includeArchived).toBe(false);
  });

  it('accepts the new ntn_ prefix', () => {
    const out = __testing.narrowConfig({ apiKey: 'ntn_AAA' });
    expect(out.apiKey).toBe('ntn_AAA');
  });

  it('rejects api keys without the expected prefix', () => {
    expect(() => __testing.narrowConfig({ apiKey: 'wrong_prefix' })).toThrow(
      /secret_.*ntn_/,
    );
  });

  it('rejects missing / empty apiKey', () => {
    expect(() => __testing.narrowConfig({})).toThrow(/apiKey/);
    expect(() => __testing.narrowConfig({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('normalizes rootIds (dashed and undashed accepted)', () => {
    const out = __testing.narrowConfig({
      apiKey: 'secret_x',
      rootIds: [PAGE_ID, DB_ID_DASHED],
    });
    expect(out.rootIds).toEqual([PAGE_ID, DB_ID]);
  });

  it('rejects malformed rootIds', () => {
    expect(() =>
      __testing.narrowConfig({ apiKey: 'secret_x', rootIds: ['short'] }),
    ).toThrow(/invalid Notion id/);
    expect(() => __testing.narrowConfig({ apiKey: 'secret_x', rootIds: 'not-array' })).toThrow(
      /array/,
    );
  });

  it('validates maxBlockDepth', () => {
    expect(__testing.narrowConfig({ apiKey: 'secret_x', maxBlockDepth: 0 }).maxBlockDepth).toBe(
      0,
    );
    expect(() =>
      __testing.narrowConfig({ apiKey: 'secret_x', maxBlockDepth: -1 }),
    ).toThrow(/maxBlockDepth/);
  });
});

// ===========================================================================
// listFolders
// ===========================================================================

describe('NotionConnector.listFolders', () => {
  it('returns [] when a parent is supplied (databases are flat in MVP)', async () => {
    const c = new NotionConnector();
    const parent: RagFolder = {
      id: 'notion:db:something',
      sourceId: 's1',
      parentId: null,
      path: 'X',
      name: 'X',
      createdAt: '',
    };
    const folders = await c.listFolders(baseConfig, 's1', parent);
    expect(folders).toEqual([]);
    expect(mockedNotion.search).not.toHaveBeenCalled();
  });

  it('with rootIds: returns databases (and silently skips page ids)', async () => {
    mockedNotion.databases.retrieve
      .mockResolvedValueOnce(fakeDb({ title: 'My DB' }))
      // Second rootId is a page → databases.retrieve throws 404 → skipped.
      .mockRejectedValueOnce(httpErr(404));
    const c = new NotionConnector();
    const folders = await c.listFolders(
      { apiKey: 'secret_x', rootIds: [DB_ID, PAGE_ID] },
      's1',
    );
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({
      id: `notion:db:${DB_ID}`,
      sourceId: 's1',
      parentId: null,
      name: 'My DB',
      path: 'My DB',
    });
  });

  it('without rootIds: paginates the search endpoint', async () => {
    mockedNotion.search
      .mockResolvedValueOnce({
        results: [fakeDb({ id: DB_ID_DASHED, title: 'A' })],
        has_more: true,
        next_cursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        results: [fakeDb({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', title: 'B' })],
        has_more: false,
        next_cursor: null,
      });
    const c = new NotionConnector();
    const folders = await c.listFolders(baseConfig, 's1');
    expect(folders.map((f) => f.name)).toEqual(['A', 'B']);
    expect(mockedNotion.search).toHaveBeenCalledTimes(2);
    expect(mockedNotion.search.mock.calls[1]?.[0]).toMatchObject({
      filter: { property: 'object', value: 'database' },
      start_cursor: 'cursor-2',
    });
  });

  it('maps 401 from search to NotionAuthError', async () => {
    mockedNotion.search.mockRejectedValueOnce(httpErr(401));
    const c = new NotionConnector();
    await expect(c.listFolders(baseConfig, 's1')).rejects.toBeInstanceOf(NotionAuthError);
  });

  it('maps 429 to NotionRateLimitError', async () => {
    mockedNotion.search.mockRejectedValueOnce(httpErr(429));
    const c = new NotionConnector();
    await expect(c.listFolders(baseConfig, 's1')).rejects.toBeInstanceOf(NotionRateLimitError);
  });
});

// ===========================================================================
// listDocuments
// ===========================================================================

describe('NotionConnector.listDocuments', () => {
  it('queries a database when a folder is supplied, with pagination', async () => {
    mockedNotion.databases.query
      .mockResolvedValueOnce({
        results: [fakePage({ id: PAGE_ID_DASHED, title: 'Row 1' })],
        has_more: true,
        next_cursor: 'cur-2',
      })
      .mockResolvedValueOnce({
        results: [
          fakePage({
            id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
            title: 'Row 2',
            last_edited_time: '2026-05-10T00:00:00Z',
          }),
        ],
        has_more: false,
        next_cursor: null,
      });
    const c = new NotionConnector();
    const folder: RagFolder = {
      id: `notion:db:${DB_ID}`,
      sourceId: 's1',
      parentId: null,
      path: 'Engineering',
      name: 'Engineering',
      createdAt: '',
    };
    const docs = await c.listDocuments(baseConfig, 's1', folder);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      id: `notion:${PAGE_ID}`,
      sourceId: 's1',
      folderId: `notion:db:${DB_ID}`,
      path: 'Engineering/Row 1',
      name: 'Row 1',
      mimeType: 'text/markdown',
      etag: '2026-05-01T00:00:00Z',
      hash: '',
    });
    expect(docs[1]?.etag).toBe('2026-05-10T00:00:00Z');
    expect(mockedNotion.databases.query).toHaveBeenCalledTimes(2);
    // Second call carries start_cursor; first does not.
    expect(mockedNotion.databases.query.mock.calls[1]?.[0]).toMatchObject({
      start_cursor: 'cur-2',
    });
  });

  it('skips archived pages by default and includes them when configured', async () => {
    const archived = fakePage({
      id: PAGE_ID_DASHED,
      title: 'Stale',
      archived: true,
    });
    const live = fakePage({
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      title: 'Fresh',
    });
    mockedNotion.databases.query.mockResolvedValueOnce({
      results: [archived, live],
      has_more: false,
      next_cursor: null,
    });
    const c = new NotionConnector();
    const folder: RagFolder = {
      id: `notion:db:${DB_ID}`,
      sourceId: 's1',
      parentId: null,
      path: 'X',
      name: 'X',
      createdAt: '',
    };
    const docs = await c.listDocuments(baseConfig, 's1', folder);
    expect(docs.map((d) => d.name)).toEqual(['Fresh']);

    mockedNotion.databases.query.mockResolvedValueOnce({
      results: [archived, live],
      has_more: false,
      next_cursor: null,
    });
    const withArchived = await c.listDocuments(
      { apiKey: 'secret_x', includeArchived: true },
      's1',
      folder,
    );
    expect(withArchived.map((d) => d.name)).toEqual(['Stale', 'Fresh']);
    expect(withArchived[0]?.deletedAt).toBe('2026-05-01T00:00:00Z');
  });

  it('without folder + with rootIds: retrieves each page (skipping DB ids)', async () => {
    mockedNotion.pages.retrieve
      .mockResolvedValueOnce(fakePage({ id: PAGE_ID_DASHED, title: 'P1' }))
      // Second rootId resolves to a database → page retrieve fails 404 → skip.
      .mockRejectedValueOnce(httpErr(404));
    const c = new NotionConnector();
    const docs = await c.listDocuments(
      { apiKey: 'secret_x', rootIds: [PAGE_ID, DB_ID] },
      's1',
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]?.name).toBe('P1');
    expect(docs[0]?.folderId).toBeNull();
    expect(docs[0]?.path).toBe('P1');
  });

  it('without folder, without rootIds: searches all pages and paginates', async () => {
    mockedNotion.search
      .mockResolvedValueOnce({
        results: [fakePage({ id: PAGE_ID_DASHED, title: 'A' })],
        has_more: true,
        next_cursor: 'next',
      })
      .mockResolvedValueOnce({
        results: [fakePage({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', title: 'B' })],
        has_more: false,
        next_cursor: null,
      });
    const c = new NotionConnector();
    const docs = await c.listDocuments(baseConfig, 's1');
    expect(docs.map((d) => d.name)).toEqual(['A', 'B']);
    expect(mockedNotion.search.mock.calls[0]?.[0]).toMatchObject({
      filter: { property: 'object', value: 'page' },
    });
  });

  it('uses last_edited_time as etag', async () => {
    mockedNotion.search.mockResolvedValueOnce({
      results: [
        fakePage({
          id: PAGE_ID_DASHED,
          last_edited_time: '2026-06-15T12:34:56Z',
        }),
      ],
      has_more: false,
      next_cursor: null,
    });
    const c = new NotionConnector();
    const docs = await c.listDocuments(baseConfig, 's1');
    expect(docs[0]?.etag).toBe('2026-06-15T12:34:56Z');
  });
});

// ===========================================================================
// fetchDocument
// ===========================================================================

describe('NotionConnector.fetchDocument', () => {
  it('renders a flat page to markdown', async () => {
    mockedNotion.blocks.children.list.mockResolvedValueOnce({
      results: [
        {
          object: 'block',
          id: 'b1',
          type: 'heading_1',
          has_children: false,
          heading_1: {
            rich_text: [{ plain_text: 'Title', annotations: {} }],
            color: 'default',
            is_toggleable: false,
          },
        },
        {
          object: 'block',
          id: 'b2',
          type: 'paragraph',
          has_children: false,
          paragraph: {
            rich_text: [
              { plain_text: 'Hello ', annotations: {} },
              { plain_text: 'world', annotations: { bold: true } },
            ],
            color: 'default',
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    const c = new NotionConnector();
    const out = await c.fetchDocument(baseConfig, 's1', `notion:${PAGE_ID}`);
    expect(out.mimeType).toBe('text/markdown');
    const text = await drainToString(out.stream);
    expect(text).toContain('# Title');
    expect(text).toContain('Hello **world**');
  });

  it('recurses into children up to maxBlockDepth', async () => {
    // Outer toggle has one child paragraph.
    mockedNotion.blocks.children.list
      .mockResolvedValueOnce({
        results: [
          {
            object: 'block',
            id: 'toggle1',
            type: 'toggle',
            has_children: true,
            toggle: {
              rich_text: [{ plain_text: 'Outer', annotations: {} }],
              color: 'default',
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [
          {
            object: 'block',
            id: 'inner',
            type: 'paragraph',
            has_children: false,
            paragraph: {
              rich_text: [{ plain_text: 'Inner text', annotations: {} }],
              color: 'default',
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      });
    const c = new NotionConnector();
    const out = await c.fetchDocument(baseConfig, 's1', `notion:${PAGE_ID}`);
    const text = await drainToString(out.stream);
    expect(text).toContain('Outer');
    expect(text).toContain('Inner text');
    // Inner text is indented under the toggle.
    expect(text).toMatch(/Outer\n {2}Inner text/);
    expect(mockedNotion.blocks.children.list).toHaveBeenCalledTimes(2);
  });

  it('caps recursion at maxBlockDepth (no fetch beyond the cap)', async () => {
    // depth=0 root → 1 toggle with has_children
    // With maxBlockDepth=1 we should NOT fetch the children of the toggle
    // (currentDepth + 1 < maxDepth → 0+1 < 1 is false).
    mockedNotion.blocks.children.list.mockResolvedValueOnce({
      results: [
        {
          object: 'block',
          id: 'toggle1',
          type: 'toggle',
          has_children: true,
          toggle: {
            rich_text: [{ plain_text: 'Outer', annotations: {} }],
            color: 'default',
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    const c = new NotionConnector();
    await c.fetchDocument(
      { apiKey: 'secret_x', maxBlockDepth: 1 },
      's1',
      `notion:${PAGE_ID}`,
    );
    expect(mockedNotion.blocks.children.list).toHaveBeenCalledTimes(1);
  });

  it('does NOT recurse into child_page or child_database (separate documents)', async () => {
    mockedNotion.blocks.children.list.mockResolvedValueOnce({
      results: [
        {
          object: 'block',
          id: 'cp1',
          type: 'child_page',
          has_children: true,
          child_page: { title: 'My Sub-page' },
        },
        {
          object: 'block',
          id: 'cd1',
          type: 'child_database',
          has_children: true,
          child_database: { title: 'My Sub-DB' },
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    const c = new NotionConnector();
    const out = await c.fetchDocument(baseConfig, 's1', `notion:${PAGE_ID}`);
    const text = await drainToString(out.stream);
    expect(text).toContain('→ Sub-page: My Sub-page');
    expect(text).toContain('→ Database: My Sub-DB');
    // Only one call: we did not recurse into the children even though
    // has_children was true.
    expect(mockedNotion.blocks.children.list).toHaveBeenCalledTimes(1);
  });

  it('throws NotionDocumentNotFoundError on 404', async () => {
    mockedNotion.blocks.children.list.mockRejectedValueOnce(httpErr(404));
    const c = new NotionConnector();
    await expect(
      c.fetchDocument(baseConfig, 's1', `notion:${PAGE_ID_2}`),
    ).rejects.toBeInstanceOf(NotionDocumentNotFoundError);
  });

  it('rejects docIds with the wrong prefix', async () => {
    const c = new NotionConnector();
    await expect(
      c.fetchDocument(baseConfig, 's1', 'gdrive:not-a-notion-id'),
    ).rejects.toBeInstanceOf(NotionDocumentNotFoundError);
  });
});

// ===========================================================================
// renderBlocksToText
// ===========================================================================

describe('renderBlocksToText', () => {
  function block(type: string, payload: Record<string, unknown>): unknown {
    return { object: 'block', id: 't', type, has_children: false, [type]: payload };
  }
  function rt(text: string, ann: Record<string, boolean> = {}): unknown {
    return { plain_text: text, annotations: ann };
  }

  it('renders paragraph with annotations', () => {
    const out = __testing.renderBlocksToText([
      block('paragraph', {
        rich_text: [rt('plain '), rt('bold', { bold: true }), rt(' '), rt('italic', { italic: true })],
        color: 'default',
      }) as Parameters<typeof __testing.renderBlocksToText>[0][number],
    ]);
    expect(out).toBe('plain **bold** *italic*');
  });

  it('renders heading_1 / heading_2 / heading_3', () => {
    const out = __testing.renderBlocksToText([
      block('heading_1', { rich_text: [rt('H1')], color: 'default', is_toggleable: false }) as never,
      block('heading_2', { rich_text: [rt('H2')], color: 'default', is_toggleable: false }) as never,
      block('heading_3', { rich_text: [rt('H3')], color: 'default', is_toggleable: false }) as never,
    ]);
    expect(out).toBe('# H1\n## H2\n### H3');
  });

  it('renders bulleted and numbered list items', () => {
    const out = __testing.renderBlocksToText([
      block('bulleted_list_item', {
        rich_text: [rt('alpha')],
        color: 'default',
      }) as never,
      block('numbered_list_item', {
        rich_text: [rt('one')],
        color: 'default',
      }) as never,
    ]);
    expect(out).toBe('- alpha\n1. one');
  });

  it('renders code with language as a fenced block', () => {
    const out = __testing.renderBlocksToText([
      block('code', {
        rich_text: [rt('const x = 1;')],
        caption: [],
        language: 'typescript',
      }) as never,
    ]);
    expect(out).toBe('```typescript\nconst x = 1;\n```');
  });

  it('renders quote and divider', () => {
    const out = __testing.renderBlocksToText([
      block('quote', { rich_text: [rt('be brave')], color: 'default' }) as never,
      block('divider', {}) as never,
    ]);
    expect(out).toBe('> be brave\n---');
  });

  it('renders image with caption fallback to url', () => {
    const out = __testing.renderBlocksToText([
      block('image', {
        type: 'external',
        external: { url: 'https://example.com/x.png' },
        caption: [],
      }) as never,
      block('image', {
        type: 'file',
        file: { url: 'https://example.com/y.png', expiry_time: 'z' },
        caption: [rt('Diagram')],
      }) as never,
    ]);
    expect(out).toContain('[Image: https://example.com/x.png]');
    expect(out).toContain('[Image: Diagram]');
  });

  it('renders toggle with summary and recursed children', () => {
    const toggleWithChildren = {
      object: 'block',
      id: 't',
      type: 'toggle',
      has_children: true,
      toggle: { rich_text: [rt('Click me')], color: 'default' },
      _children: [
        block('paragraph', {
          rich_text: [rt('inside')],
          color: 'default',
        }),
      ],
    };
    const out = __testing.renderBlocksToText([
      toggleWithChildren as Parameters<typeof __testing.renderBlocksToText>[0][number],
    ]);
    expect(out).toBe('Click me\n  inside');
  });

  it('silently skips unsupported block types', () => {
    const out = __testing.renderBlocksToText([
      { object: 'block', id: 'x', type: 'totally_new_block', has_children: false } as never,
      block('paragraph', { rich_text: [rt('still here')], color: 'default' }) as never,
    ]);
    expect(out).toBe('still here');
  });
});

// ===========================================================================
// pageTitle
// ===========================================================================

describe('pageTitle', () => {
  it('extracts the title from the title-typed property', () => {
    expect(__testing.pageTitle(fakePage({ title: 'My Page' }))).toBe('My Page');
  });

  it('scans properties for the title type regardless of key name', () => {
    // Database pages use the column name as the property key (often "Name").
    expect(
      __testing.pageTitle(fakePage({ title: 'Renamed col', titleProp: 'Name' })),
    ).toBe('Renamed col');
  });

  it('returns "Untitled" for malformed input', () => {
    expect(__testing.pageTitle(null)).toBe('Untitled');
    expect(__testing.pageTitle({})).toBe('Untitled');
    expect(__testing.pageTitle({ properties: { foo: { type: 'number' } } })).toBe('Untitled');
  });

  it('returns "Untitled" when the title rich_text is empty', () => {
    expect(
      __testing.pageTitle({
        properties: { title: { type: 'title', title: [] } },
      }),
    ).toBe('Untitled');
  });
});

// ===========================================================================
// Doc id round-trip
// ===========================================================================

describe('doc id encode/decode', () => {
  it('round-trips page ids verbatim with the notion: prefix', () => {
    const docId = __testing.encodeDocId(PAGE_ID);
    expect(docId).toBe(`notion:${PAGE_ID}`);
    expect(__testing.decodeDocId(docId)).toBe(PAGE_ID);
  });

  it('normalizes dashed ids before encoding', () => {
    const docId = __testing.encodeDocId(PAGE_ID_DASHED);
    expect(docId).toBe(`notion:${PAGE_ID}`);
  });

  it('rejects foreign prefixes', () => {
    expect(() => __testing.decodeDocId('gdrive:abc')).toThrow(NotionDocumentNotFoundError);
    expect(() => __testing.decodeDocId('s3:abc')).toThrow(NotionDocumentNotFoundError);
    expect(() => __testing.decodeDocId('notion:')).toThrow(NotionDocumentNotFoundError);
  });

  it('encodes / decodes folder ids with the notion:db: prefix', () => {
    const folderId = __testing.encodeFolderId(DB_ID_DASHED);
    expect(folderId).toBe(`notion:db:${DB_ID}`);
    expect(__testing.decodeFolderId(folderId)).toBe(DB_ID);
    expect(__testing.decodeFolderId('notion:not-a-folder')).toBe('');
  });
});

// ===========================================================================
// Type discriminator
// ===========================================================================

describe('NotionConnector type discriminator', () => {
  it("exposes type === 'notion' so the registry can dispatch on it", () => {
    const c = new NotionConnector();
    expect(c.type).toBe('notion');
  });
});

// ===========================================================================
// Rate-limiter wiring
// ===========================================================================

describe('NotionConnector rate limiter', () => {
  it('does not throttle when no limiter is wired (backwards-compatible)', async () => {
    mockedNotion.users.me.mockResolvedValue({ id: 'u-1' });
    const connector = new NotionConnector();
    await expect(connector.testConnection(baseConfig)).resolves.toBeUndefined();
    expect(mockedNotion.users.me).toHaveBeenCalledTimes(1);
  });

  it('invokes acquire("notion", hash(apiKey)) before each SDK call', async () => {
    mockedNotion.users.me.mockResolvedValue({ id: 'u-1' });
    mockedNotion.search.mockResolvedValue({ results: [], has_more: false });

    const acquireCalls: Array<{ type: string; credentialKey: string }> = [];
    const fakeLimiter = {
      acquire: async (type: string, credentialKey: string): Promise<number> => {
        acquireCalls.push({ type, credentialKey });
        return 0;
      },
    };

    const connector = new NotionConnector();
    connector.setRateLimiter(fakeLimiter);

    await connector.testConnection(baseConfig);
    // No rootIds → falls through to `search`.
    await connector.listFolders(baseConfig, 'src-rl');

    // testConnection → 1 users.me; listFolders → 1 search (one page, no
    // `has_more`). Two acquires total.
    expect(acquireCalls).toHaveLength(2);
    expect(acquireCalls.every((c) => c.type === 'notion')).toBe(true);
    // credentialKey is a hash of the apiKey — not the raw key.
    expect(acquireCalls[0]?.credentialKey).not.toBe(baseConfig.apiKey);
    expect(acquireCalls[0]?.credentialKey).toMatch(/^[0-9a-f]+$/);
    // Same apiKey → same hash.
    expect(acquireCalls[0]?.credentialKey).toBe(acquireCalls[1]?.credentialKey);
  });

  it('different api keys produce different bucket keys', async () => {
    mockedNotion.users.me.mockResolvedValue({ id: 'u-1' });

    const seen = new Set<string>();
    const fakeLimiter = {
      acquire: async (_type: string, credentialKey: string): Promise<number> => {
        seen.add(credentialKey);
        return 0;
      },
    };

    const connector = new NotionConnector();
    connector.setRateLimiter(fakeLimiter);

    await connector.testConnection({ apiKey: 'secret_ONE' });
    await connector.testConnection({ apiKey: 'secret_TWO' });
    expect(seen.size).toBe(2);
  });
});
