// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mock @microsoft/microsoft-graph-client and @azure/identity.
//
// The Graph SDK exposes a fluent `client.api(path).get()` interface (with
// an optional `.responseType(...)` modifier for streaming responses). We
// hoist a router (`mockGraphResponses`) keyed on the Graph path so each
// test can register the responses it expects without setting up a deep
// chain of `.mockResolvedValueOnce(...)` calls in a specific order.
//
// `@azure/identity`'s `ClientSecretCredential` is a no-op constructor — the
// connector only hands it to the auth provider, never reads anything off it.
// ---------------------------------------------------------------------------

interface RouteHandler {
  result: unknown;
  throws?: boolean;
}

let mockGraphResponses: Map<string, RouteHandler[]>;
let getCalls: Array<{ path: string; responseType?: string }>;

vi.mock('@microsoft/microsoft-graph-client', () => {
  const ResponseType = {
    JSON: 'json',
    STREAM: 'stream',
    TEXT: 'text',
    ARRAYBUFFER: 'arraybuffer',
    BLOB: 'blob',
    RAW: 'raw',
  } as const;

  function makeRequestBuilder(path: string) {
    let responseType: string | undefined;
    const builder = {
      responseType(rt: string) {
        responseType = rt;
        return builder;
      },
      async get() {
        getCalls.push({ path, responseType });
        const handlers = mockGraphResponses.get(path);
        if (!handlers || handlers.length === 0) {
          throw new Error(`No mock registered for Graph path: ${path}`);
        }
        const next = handlers.shift() as RouteHandler;
        if (next.throws) throw next.result;
        return next.result;
      },
    };
    return builder;
  }

  class Client {
    static initWithMiddleware(_opts: unknown) {
      return new Client();
    }
    api(path: string) {
      return makeRequestBuilder(path);
    }
  }

  return { Client, ResponseType };
});

vi.mock('@azure/identity', () => {
  class ClientSecretCredential {
    constructor(_t: string, _c: string, _s: string) {}
    async getToken() {
      return { token: 'fake-token', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { ClientSecretCredential };
});

// Import AFTER the mocks are registered.
import {
  SharePointConnector,
  SharePointAuthError,
  SharePointDocumentNotFoundError,
  SharePointPermissionError,
  __testing,
} from '../sharepoint.js';
import type { RagFolder } from '@calame-ee/rag-core';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const baseConfig = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: '22222222-2222-2222-2222-222222222222',
  clientSecret: 'super-secret-value',
  siteUrl: 'https://contoso.sharepoint.com/sites/intranet',
};

// Graph site IDs follow the `<host>,<spGuid>,<webGuid>` shape — stable, opaque.
const SITE_ID = 'contoso.sharepoint.com,site-guid-1234,web-guid-5678';
const DRIVE_ID = 'drive-id-xyz';
const ROOT_ITEM_ID = 'root-item-id';

const NORMALISED_SITE_URL = 'contoso.sharepoint.com:/sites/intranet';

beforeEach(() => {
  mockGraphResponses = new Map();
  getCalls = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Register a single response for an exact path. Successive registrations are queued. */
function mockRoute(path: string, result: unknown, throws = false): void {
  const arr = mockGraphResponses.get(path) ?? [];
  arr.push({ result, throws });
  mockGraphResponses.set(path, arr);
}

/** Build a fake Graph SDK error with a given HTTP status (+ optional `code`). */
function graphError(status: number, message?: string, code?: string): Error {
  const e = new Error(message ?? `error ${status}`) as Error & {
    statusCode: number;
    code?: string;
  };
  e.statusCode = status;
  if (code) e.code = code;
  return e;
}

/**
 * Pre-register the routes hit by testConnection / first-time resolveDrive:
 *   GET /sites/<normalised>             → site
 *   GET /sites/<siteId>/drives          → drive list
 *   GET /sites/<siteId>/drives/<driveId>/root  → root item
 *
 * The driveItem used for the root has its `id` set to ROOT_ITEM_ID so
 * subsequent listChildren calls can address `/items/<root>/children`.
 */
function primeDriveResolution(opts: { driveName?: string; rootFolderPath?: string } = {}) {
  mockRoute(`/sites/${NORMALISED_SITE_URL}`, {
    id: SITE_ID,
    displayName: 'Intranet',
  });
  mockRoute(`/sites/${SITE_ID}/drives`, {
    value: [
      { id: DRIVE_ID, name: 'Documents', displayName: 'Documents', driveType: 'documentLibrary' },
      {
        id: 'other-drive',
        name: 'Engineering',
        displayName: 'Engineering',
        driveType: 'documentLibrary',
      },
    ],
  });
  if (opts.rootFolderPath) {
    mockRoute(`/sites/${SITE_ID}/drives/${DRIVE_ID}/root:${opts.rootFolderPath}`, {
      id: ROOT_ITEM_ID,
      name: opts.rootFolderPath.split('/').pop(),
    });
  } else {
    mockRoute(`/sites/${SITE_ID}/drives/${DRIVE_ID}/root`, {
      id: ROOT_ITEM_ID,
      name: '',
    });
  }
}

/** Drain a Readable into a string. */
async function drainToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('SharePointConnector.testConnection', () => {
  it('resolves the site and lists drives on success', async () => {
    primeDriveResolution();
    const connector = new SharePointConnector();
    await expect(connector.testConnection(baseConfig)).resolves.toBeUndefined();
    expect(getCalls.map((c) => c.path)).toEqual(
      expect.arrayContaining([
        `/sites/${NORMALISED_SITE_URL}`,
        `/sites/${SITE_ID}/drives`,
        `/sites/${SITE_ID}/drives/${DRIVE_ID}/root`,
      ]),
    );
  });

  it('throws SharePointAuthError on HTTP 401', async () => {
    mockRoute(`/sites/${NORMALISED_SITE_URL}`, graphError(401), true);
    const connector = new SharePointConnector();
    await expect(connector.testConnection(baseConfig)).rejects.toBeInstanceOf(SharePointAuthError);
  });

  it('throws SharePointPermissionError on HTTP 403 / Authorization_RequestDenied', async () => {
    mockRoute(
      `/sites/${NORMALISED_SITE_URL}`,
      graphError(403, 'No perm', 'Authorization_RequestDenied'),
      true,
    );
    const connector = new SharePointConnector();
    await expect(connector.testConnection(baseConfig)).rejects.toBeInstanceOf(
      SharePointPermissionError,
    );
  });

  it('throws a "site not found" error on 404', async () => {
    mockRoute(`/sites/${NORMALISED_SITE_URL}`, graphError(404), true);
    const connector = new SharePointConnector();
    await expect(connector.testConnection(baseConfig)).rejects.toThrow(/site not found/i);
  });

  it('picks the first drive when driveName is omitted and several are available', async () => {
    primeDriveResolution();
    const connector = new SharePointConnector();
    await expect(connector.testConnection(baseConfig)).resolves.toBeUndefined();
    // The 'root' call must have been made against DRIVE_ID (the first one).
    expect(getCalls.some((c) => c.path === `/sites/${SITE_ID}/drives/${DRIVE_ID}/root`)).toBe(true);
  });

  it('errors when an explicit driveName has no match', async () => {
    mockRoute(`/sites/${NORMALISED_SITE_URL}`, { id: SITE_ID });
    mockRoute(`/sites/${SITE_ID}/drives`, {
      value: [{ id: DRIVE_ID, name: 'Documents', displayName: 'Documents' }],
    });
    const connector = new SharePointConnector();
    await expect(
      connector.testConnection({ ...baseConfig, driveName: 'Nonexistent' }),
    ).rejects.toThrow(/Nonexistent/);
  });
});

// ---------------------------------------------------------------------------
// listFolders
// ---------------------------------------------------------------------------

describe('SharePointConnector.listFolders', () => {
  it('returns folder children of the root', async () => {
    primeDriveResolution();
    mockRoute(`/sites/${SITE_ID}/drives/${DRIVE_ID}/items/${ROOT_ITEM_ID}/children?$top=200`, {
      value: [
        {
          id: 'F1',
          name: 'Engineering',
          folder: { childCount: 3 },
          createdDateTime: '2026-04-01T10:00:00Z',
          parentReference: { path: `/drives/${DRIVE_ID}/root:` },
        },
        {
          id: 'D1',
          name: 'README.md',
          file: { mimeType: 'text/markdown' },
          parentReference: { path: `/drives/${DRIVE_ID}/root:` },
        },
      ],
    });
    const connector = new SharePointConnector();
    const folders = await connector.listFolders(baseConfig, 'src-1');
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({
      id: 'F1',
      sourceId: 'src-1',
      parentId: null,
      name: 'Engineering',
      path: 'Engineering',
    });
  });

  it('resolves a sub-path root via /root:/<path>', async () => {
    primeDriveResolution({ rootFolderPath: '/Shared Documents/Projects' });
    mockRoute(`/sites/${SITE_ID}/drives/${DRIVE_ID}/items/${ROOT_ITEM_ID}/children?$top=200`, {
      value: [
        {
          id: 'F2',
          name: '2026',
          folder: { childCount: 1 },
          parentReference: { path: `/drives/${DRIVE_ID}/root:/Shared Documents/Projects` },
        },
      ],
    });
    const connector = new SharePointConnector();
    const folders = await connector.listFolders(
      { ...baseConfig, rootFolderPath: '/Shared Documents/Projects' },
      'src-1',
    );
    expect(folders[0]?.path).toBe('Shared Documents/Projects/2026');
  });

  it('paginates via @odata.nextLink', async () => {
    primeDriveResolution();
    mockRoute(`/sites/${SITE_ID}/drives/${DRIVE_ID}/items/${ROOT_ITEM_ID}/children?$top=200`, {
      value: [{ id: 'F1', name: 'A', folder: {} }],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/PAGE-2',
    });
    mockRoute('https://graph.microsoft.com/v1.0/PAGE-2', {
      value: [{ id: 'F2', name: 'B', folder: {} }],
    });
    const connector = new SharePointConnector();
    const folders = await connector.listFolders(baseConfig, 'src-1');
    expect(folders.map((f) => f.id)).toEqual(['F1', 'F2']);
  });

  it('returns [] for sub-folders when recursive=false and a parent is supplied', async () => {
    const connector = new SharePointConnector();
    const parent: RagFolder = {
      id: 'PARENT_ID',
      sourceId: 'src-1',
      parentId: null,
      path: 'Engineering',
      name: 'Engineering',
      createdAt: '',
    };
    const folders = await connector.listFolders(
      { ...baseConfig, recursive: false },
      'src-1',
      parent,
    );
    expect(folders).toEqual([]);
    // No Graph call should have been made.
    expect(getCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listDocuments
// ---------------------------------------------------------------------------

describe('SharePointConnector.listDocuments', () => {
  it('paginates and maps files into RagDocument records, stripping eTag quotes', async () => {
    primeDriveResolution();
    mockRoute(`/sites/${SITE_ID}/drives/${DRIVE_ID}/items/${ROOT_ITEM_ID}/children?$top=200`, {
      value: [
        {
          id: 'D1',
          name: 'spec.pdf',
          size: 12345,
          eTag: '"{01XYZ},1"',
          file: {
            mimeType: 'application/pdf',
            hashes: { sha256Hash: 'aabbcc' },
          },
          parentReference: { path: `/drives/${DRIVE_ID}/root:` },
        },
      ],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/NEXT',
    });
    mockRoute('https://graph.microsoft.com/v1.0/NEXT', {
      value: [
        {
          id: 'D2',
          name: 'guide.docx',
          size: 500,
          eTag: '"{02ABC},2"',
          file: {
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            hashes: { quickXorHash: 'qx-hash-bytes' },
          },
          parentReference: { path: `/drives/${DRIVE_ID}/root:` },
        },
      ],
    });
    const connector = new SharePointConnector();
    const docs = await connector.listDocuments(baseConfig, 'src-1');
    expect(docs).toHaveLength(2);
    const d1 = docs.find((d) => d.name === 'spec.pdf');
    expect(d1).toMatchObject({
      id: 'sharepoint:D1',
      sourceId: 'src-1',
      folderId: null,
      path: 'spec.pdf',
      mimeType: 'application/pdf',
      size: 12345,
      hash: 'aabbcc',
      etag: '{01XYZ},1',
    });
    const d2 = docs.find((d) => d.name === 'guide.docx');
    // sha256 absent → falls back to quickXorHash.
    expect(d2?.hash).toBe('qx-hash-bytes');
    expect(d2?.etag).toBe('{02ABC},2');
  });

  it('applies includeMimeTypes / excludeMimeTypes filters', async () => {
    primeDriveResolution();
    mockRoute(`/sites/${SITE_ID}/drives/${DRIVE_ID}/items/${ROOT_ITEM_ID}/children?$top=200`, {
      value: [
        {
          id: 'D1',
          name: 'note.txt',
          size: 10,
          file: { mimeType: 'text/plain' },
          parentReference: { path: `/drives/${DRIVE_ID}/root:` },
        },
        {
          id: 'D2',
          name: 'spec.pdf',
          size: 20,
          file: { mimeType: 'application/pdf' },
          parentReference: { path: `/drives/${DRIVE_ID}/root:` },
        },
        {
          id: 'D3',
          name: 'temp.bin',
          size: 30,
          file: { mimeType: 'application/octet-stream' },
          parentReference: { path: `/drives/${DRIVE_ID}/root:` },
        },
      ],
    });
    const connector = new SharePointConnector();
    const docs = await connector.listDocuments(
      {
        ...baseConfig,
        includeMimeTypes: ['application/pdf', 'text/plain'],
        excludeMimeTypes: ['text/plain'],
      },
      'src-1',
    );
    // text/plain excluded; octet-stream not in includes; only PDF passes.
    expect(docs.map((d) => d.name)).toEqual(['spec.pdf']);
  });
});

// ---------------------------------------------------------------------------
// fetchDocument
// ---------------------------------------------------------------------------

describe('SharePointConnector.fetchDocument', () => {
  it('streams the file body and returns the metadata mime type', async () => {
    primeDriveResolution();
    mockRoute(`/sites/${SITE_ID}/drives/${DRIVE_ID}/items/D1`, {
      id: 'D1',
      name: 'spec.pdf',
      file: { mimeType: 'application/pdf' },
    });
    mockRoute(
      `/sites/${SITE_ID}/drives/${DRIVE_ID}/items/D1/content`,
      Readable.from([Buffer.from('PDF-BYTES', 'utf8')]),
    );
    const connector = new SharePointConnector();
    const out = await connector.fetchDocument(baseConfig, 'src-1', 'sharepoint:D1');
    expect(out.mimeType).toBe('application/pdf');
    expect(await drainToString(out.stream)).toBe('PDF-BYTES');
    // The /content call must have requested a STREAM response type.
    const streamCall = getCalls.find((c) => c.path.endsWith('/items/D1/content'));
    expect(streamCall?.responseType).toBe('stream');
  });

  it('throws SharePointDocumentNotFoundError on 404 metadata lookup', async () => {
    primeDriveResolution();
    mockRoute(`/sites/${SITE_ID}/drives/${DRIVE_ID}/items/MISSING`, graphError(404), true);
    const connector = new SharePointConnector();
    await expect(
      connector.fetchDocument(baseConfig, 'src-1', 'sharepoint:MISSING'),
    ).rejects.toBeInstanceOf(SharePointDocumentNotFoundError);
  });

  it('rejects docIds without the sharepoint: prefix', async () => {
    const connector = new SharePointConnector();
    await expect(
      connector.fetchDocument(baseConfig, 'src-1', 's3:not-a-sharepoint-id'),
    ).rejects.toBeInstanceOf(SharePointDocumentNotFoundError);
    await expect(
      connector.fetchDocument(baseConfig, 'src-1', 'gdrive:also-not'),
    ).rejects.toBeInstanceOf(SharePointDocumentNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Doc id round-trip
// ---------------------------------------------------------------------------

describe('doc id encode/decode', () => {
  it('round-trips driveItem ids verbatim with the sharepoint: prefix', () => {
    const cases = ['01ABCDEF1234567890', 'opaque-graph-id-with_special.chars', 'simple'];
    for (const id of cases) {
      const docId = __testing.encodeDocId(id);
      expect(docId).toBe(`sharepoint:${id}`);
      expect(__testing.decodeDocId(docId)).toBe(id);
    }
  });

  it('rejects ids without the sharepoint: prefix', () => {
    expect(() => __testing.decodeDocId('s3:abc')).toThrow(SharePointDocumentNotFoundError);
    expect(() => __testing.decodeDocId('gdrive:abc')).toThrow(SharePointDocumentNotFoundError);
    expect(() => __testing.decodeDocId('sharepoint:')).toThrow(SharePointDocumentNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// narrowConfig + URL normalisation
// ---------------------------------------------------------------------------

describe('narrowConfig', () => {
  it('accepts a full https URL and normalises to <host>:/<path>', () => {
    const out = __testing.narrowConfig(baseConfig);
    expect(out.siteUrl).toBe(NORMALISED_SITE_URL);
    expect(out.tenantId).toBe(baseConfig.tenantId);
    expect(out.clientId).toBe(baseConfig.clientId);
    expect(out.clientSecret).toBe(baseConfig.clientSecret);
    expect(out.recursive).toBe(true);
  });

  it('leaves hostname-relative and raw site id forms unchanged', () => {
    expect(__testing.normaliseSiteUrl('contoso.sharepoint.com:/sites/intranet')).toBe(
      'contoso.sharepoint.com:/sites/intranet',
    );
    expect(__testing.normaliseSiteUrl('contoso.sharepoint.com,site-guid,web-guid')).toBe(
      'contoso.sharepoint.com,site-guid,web-guid',
    );
  });

  it('throws when tenantId / clientId / clientSecret / siteUrl are missing or empty', () => {
    const minimal = { ...baseConfig } as Record<string, unknown>;
    delete minimal.tenantId;
    expect(() => __testing.narrowConfig(minimal)).toThrow(/tenantId/);

    expect(() => __testing.narrowConfig({ ...baseConfig, clientId: '' })).toThrow(/clientId/);
    expect(() => __testing.narrowConfig({ ...baseConfig, clientSecret: '' })).toThrow(
      /clientSecret/,
    );
    expect(() => __testing.narrowConfig({ ...baseConfig, siteUrl: '' })).toThrow(/siteUrl/);
  });

  it('defaults recursive to true and respects an explicit false', () => {
    expect(__testing.narrowConfig(baseConfig).recursive).toBe(true);
    expect(__testing.narrowConfig({ ...baseConfig, recursive: false }).recursive).toBe(false);
  });

  it('validates include/exclude mime type arrays', () => {
    expect(() =>
      __testing.narrowConfig({ ...baseConfig, includeMimeTypes: 'not-an-array' }),
    ).toThrow(/includeMimeTypes/);
    expect(() => __testing.narrowConfig({ ...baseConfig, excludeMimeTypes: [1, 2] })).toThrow(
      /excludeMimeTypes/,
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('stripQuotes peels outer double quotes off Graph eTags', () => {
    expect(__testing.stripQuotes('"{abc},1"')).toBe('{abc},1');
    expect(__testing.stripQuotes('no-quotes')).toBe('no-quotes');
    expect(__testing.stripQuotes('"unmatched')).toBe('"unmatched');
  });

  it('parseGraphPath strips the /drives/<id>/root: prefix and decodes URI components', () => {
    expect(__testing.parseGraphPath('/drives/D/root:/Shared%20Documents/Projects')).toBe(
      '/Shared Documents/Projects',
    );
    expect(__testing.parseGraphPath('/drives/D/root:')).toBe('');
    expect(__testing.parseGraphPath(undefined)).toBe('');
    expect(__testing.parseGraphPath('not-a-graph-path')).toBe('');
  });

  it('matchMimeTypes applies include/exclude semantics', () => {
    expect(__testing.matchMimeTypes('application/pdf', undefined, undefined)).toBe(true);
    expect(__testing.matchMimeTypes('application/pdf', ['application/pdf'], undefined)).toBe(true);
    expect(__testing.matchMimeTypes('text/plain', ['application/pdf'], undefined)).toBe(false);
    expect(__testing.matchMimeTypes('text/plain', undefined, ['text/plain'])).toBe(false);
    // Exclude wins over include.
    expect(__testing.matchMimeTypes('text/plain', ['text/plain'], ['text/plain'])).toBe(false);
  });

  it('clientCacheKey ignores siteUrl / driveName / rootFolderPath', () => {
    const k1 = __testing.clientCacheKey({
      tenantId: 't',
      clientId: 'c',
      clientSecret: 's',
    });
    const k2 = __testing.clientCacheKey({
      tenantId: 't',
      clientId: 'c',
      clientSecret: 's',
    });
    expect(k1).toBe(k2);
    const k3 = __testing.clientCacheKey({
      tenantId: 't',
      clientId: 'c',
      clientSecret: 'different',
    });
    expect(k3).not.toBe(k1);
  });

  it('mapTestConnectionError produces distinct error types per status / code', () => {
    expect(__testing.mapTestConnectionError(graphError(401), 'site')).toBeInstanceOf(
      SharePointAuthError,
    );
    expect(__testing.mapTestConnectionError(graphError(403), 'site')).toBeInstanceOf(
      SharePointPermissionError,
    );
    expect(
      __testing.mapTestConnectionError(
        graphError(403, 'denied', 'Authorization_RequestDenied'),
        'site',
      ).message,
    ).toMatch(/Sites\.Read\.All/);
    expect(__testing.mapTestConnectionError(graphError(404), 'my-site').message).toMatch(/my-site/);
    expect(__testing.mapTestConnectionError(new Error('boom'), 'site').message).toMatch(
      /cannot reach/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Type discriminator
// ---------------------------------------------------------------------------

describe('SharePointConnector type discriminator', () => {
  it("exposes type === 'sharepoint' so the registry can dispatch on it", () => {
    const c = new SharePointConnector();
    expect(c.type).toBe('sharepoint');
  });
});
