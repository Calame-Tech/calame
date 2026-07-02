// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mock googleapis.
//
// The Drive resource exposes `files.get`, `files.list`, `files.export`. We
// hoist a set of vitest mock functions per-test and rebind them on the mocked
// `google.drive(...)` factory via `mockDriveImpl`.
//
// `google.auth.JWT` is a no-op constructor — the connector only stores the
// instance and hands it to `google.drive({ auth })`, so any object works.
// ---------------------------------------------------------------------------

interface MockedDriveFiles {
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  export: ReturnType<typeof vi.fn>;
}

let mockedFiles: MockedDriveFiles;

vi.mock('googleapis', () => {
  // The factory is called once per test (vi.mock is hoisted). The connector
  // pulls `files` off the object returned by `google.drive(...)` each time
  // it instantiates a client, so we need a stable reference per test — we
  // wire it via a closure that always returns the CURRENT `mockedFiles`.
  return {
    google: {
      auth: {
        JWT: vi.fn().mockImplementation(function (this: unknown) {
          // The connector reads no JWT methods other than the eviction-time
          // `revokeCredentials()` call (which is best-effort and guarded).
          return this;
        }),
      },
      drive: vi.fn(() => ({
        files: {
          get: (...args: unknown[]) => mockedFiles.get(...args),
          list: (...args: unknown[]) => mockedFiles.list(...args),
          export: (...args: unknown[]) => mockedFiles.export(...args),
        },
      })),
    },
  };
});

// Import AFTER the mock is registered.
import {
  GDriveConnector,
  GDriveDocumentNotFoundError,
  UnsupportedGDriveMimeTypeError,
  __testing,
} from '../gdrive.js';
import type { RagFolder } from '@calame-ee/rag-core';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const FAKE_KEY = {
  client_email: 'rag@example-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
  token_uri: 'https://oauth2.googleapis.com/token',
};

const baseConfig = {
  serviceAccountKey: FAKE_KEY,
  rootFolderId: 'ROOT_FOLDER_ID',
};

beforeEach(() => {
  mockedFiles = {
    get: vi.fn(),
    list: vi.fn(),
    export: vi.fn(),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake SDK error with the given HTTP status. */
function sdkError(code: number, message = `error ${code}`): Error & { code: number } {
  const e = new Error(message) as Error & { code: number };
  e.code = code;
  return e;
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

describe('GDriveConnector.testConnection', () => {
  it('resolves silently when the root id is a folder', async () => {
    mockedFiles.get.mockResolvedValueOnce({
      data: {
        id: 'ROOT_FOLDER_ID',
        name: 'My Knowledge',
        mimeType: 'application/vnd.google-apps.folder',
      },
    });
    const connector = new GDriveConnector();
    await expect(connector.testConnection(baseConfig)).resolves.toBeUndefined();
    expect(mockedFiles.get).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'ROOT_FOLDER_ID' }),
    );
  });

  it('throws an admin-friendly 401 auth message', async () => {
    mockedFiles.get.mockRejectedValueOnce(sdkError(401));
    const connector = new GDriveConnector();
    await expect(connector.testConnection(baseConfig)).rejects.toThrow(/authentication failed/i);
  });

  it('throws an admin-friendly 403 message including the service account email', async () => {
    mockedFiles.get.mockRejectedValueOnce(sdkError(403));
    const connector = new GDriveConnector();
    await expect(connector.testConnection(baseConfig)).rejects.toThrow(
      /rag@example-project\.iam\.gserviceaccount\.com/,
    );
  });

  it('throws an admin-friendly 404 message when the folder id is wrong', async () => {
    mockedFiles.get.mockRejectedValueOnce(sdkError(404));
    const connector = new GDriveConnector();
    await expect(connector.testConnection(baseConfig)).rejects.toThrow(/not found/i);
  });

  it('rejects when the id resolves to a file (not a folder)', async () => {
    mockedFiles.get.mockResolvedValueOnce({
      data: { id: 'ROOT_FOLDER_ID', name: 'a.pdf', mimeType: 'application/pdf' },
    });
    const connector = new GDriveConnector();
    await expect(connector.testConnection(baseConfig)).rejects.toThrow(/not a folder/i);
  });
});

// ---------------------------------------------------------------------------
// listFolders
// ---------------------------------------------------------------------------

describe('GDriveConnector.listFolders', () => {
  it('returns the direct subfolders of the configured root', async () => {
    mockedFiles.list.mockResolvedValueOnce({
      data: {
        files: [
          { id: 'F1', name: 'Engineering', createdTime: '2026-04-01T10:00:00Z' },
          { id: 'F2', name: 'Marketing', createdTime: '2026-04-02T10:00:00Z' },
        ],
      },
    });
    const connector = new GDriveConnector();
    const folders = await connector.listFolders(baseConfig, 'src-1');
    expect(folders).toHaveLength(2);
    expect(folders[0]).toMatchObject({
      id: 'F1',
      sourceId: 'src-1',
      parentId: null,
      path: 'Engineering',
      name: 'Engineering',
    });
    // Confirm the query scoped to the configured root.
    const call = mockedFiles.list.mock.calls[0]?.[0] as { q?: string };
    expect(call?.q).toContain(`'ROOT_FOLDER_ID' in parents`);
    expect(call?.q).toContain(`trashed = false`);
  });

  it('paginates via nextPageToken', async () => {
    mockedFiles.list
      .mockResolvedValueOnce({
        data: {
          files: [{ id: 'F1', name: 'A' }],
          nextPageToken: 'PAGE-2',
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [{ id: 'F2', name: 'B' }],
        },
      });
    const connector = new GDriveConnector();
    const folders = await connector.listFolders(baseConfig, 'src-1');
    expect(folders.map((f) => f.id)).toEqual(['F1', 'F2']);
    expect(mockedFiles.list).toHaveBeenCalledTimes(2);
    expect((mockedFiles.list.mock.calls[1]?.[0] as { pageToken?: string }).pageToken).toBe(
      'PAGE-2',
    );
  });

  it('scopes listFolders under `parent.id` when supplied', async () => {
    mockedFiles.list.mockResolvedValueOnce({
      data: {
        files: [{ id: 'F3', name: 'sub' }],
      },
    });
    const connector = new GDriveConnector();
    const parent: RagFolder = {
      id: 'PARENT_ID',
      sourceId: 'src-1',
      parentId: null,
      path: 'Engineering',
      name: 'Engineering',
      createdAt: '',
    };
    const folders = await connector.listFolders(baseConfig, 'src-1', parent);
    expect(folders).toHaveLength(1);
    expect(folders[0]?.parentId).toBe('PARENT_ID');
    const call = mockedFiles.list.mock.calls[0]?.[0] as { q?: string };
    expect(call?.q).toContain(`'PARENT_ID' in parents`);
  });

  it('returns [] for sub-folders when recursive=false and a parent is supplied', async () => {
    const connector = new GDriveConnector();
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
    // No API call should have been made — the early return kicks in first.
    expect(mockedFiles.list).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listDocuments
// ---------------------------------------------------------------------------

describe('GDriveConnector.listDocuments', () => {
  it('paginates and maps files into RagDocument records', async () => {
    mockedFiles.list
      .mockResolvedValueOnce({
        data: {
          files: [
            {
              id: 'D1',
              name: 'spec.pdf',
              mimeType: 'application/pdf',
              size: '12345',
              md5Checksum: 'abc123',
              modifiedTime: '2026-05-01T00:00:00Z',
            },
          ],
          nextPageToken: 'NEXT',
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [
            {
              id: 'D2',
              name: 'README.md',
              mimeType: 'text/markdown',
              size: '500',
              md5Checksum: 'def456',
              modifiedTime: '2026-05-02T00:00:00Z',
            },
          ],
        },
      });
    const connector = new GDriveConnector();
    const docs = await connector.listDocuments(baseConfig, 'src-1');
    expect(docs).toHaveLength(2);
    const d1 = docs.find((d) => d.name === 'spec.pdf');
    expect(d1).toMatchObject({
      id: 'gdrive:D1',
      sourceId: 'src-1',
      folderId: null,
      path: 'spec.pdf',
      mimeType: 'application/pdf',
      size: 12345,
      etag: 'abc123',
    });
    expect(mockedFiles.list).toHaveBeenCalledTimes(2);
  });

  it('applies includeMimeTypes / excludeMimeTypes filters', async () => {
    mockedFiles.list.mockResolvedValueOnce({
      data: {
        files: [
          { id: 'D1', name: 'note.txt', mimeType: 'text/plain', size: '10' },
          { id: 'D2', name: 'spec.pdf', mimeType: 'application/pdf', size: '20' },
          { id: 'D3', name: 'temp.bin', mimeType: 'application/octet-stream', size: '30' },
        ],
      },
    });
    const connector = new GDriveConnector();
    const docs = await connector.listDocuments(
      {
        ...baseConfig,
        includeMimeTypes: ['application/pdf', 'text/plain'],
        excludeMimeTypes: ['text/plain'],
      },
      'src-1',
    );
    // text/plain is excluded; octet-stream is not in includes; only PDF passes.
    expect(docs.map((d) => d.name)).toEqual(['spec.pdf']);
  });

  it('falls back to modifiedTime when md5Checksum is missing (Google Docs)', async () => {
    mockedFiles.list.mockResolvedValueOnce({
      data: {
        files: [
          {
            id: 'GDOC1',
            name: 'Roadmap',
            mimeType: 'application/vnd.google-apps.document',
            modifiedTime: '2026-05-03T12:00:00Z',
            // No size, no md5Checksum.
          },
        ],
      },
    });
    const connector = new GDriveConnector();
    const docs = await connector.listDocuments(baseConfig, 'src-1');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: 'gdrive:GDOC1',
      mimeType: 'application/vnd.google-apps.document',
      size: 0,
      etag: '2026-05-03T12:00:00Z',
      hash: '',
    });
  });

  it('prefixes document paths with the parent folder path', async () => {
    mockedFiles.list.mockResolvedValueOnce({
      data: {
        files: [{ id: 'D1', name: 'guide.pdf', mimeType: 'application/pdf', size: '1' }],
      },
    });
    const connector = new GDriveConnector();
    const folder: RagFolder = {
      id: 'FOLDER_ID',
      sourceId: 'src-1',
      parentId: null,
      path: 'Engineering',
      name: 'Engineering',
      createdAt: '',
    };
    const docs = await connector.listDocuments(baseConfig, 'src-1', folder);
    expect(docs[0]?.path).toBe('Engineering/guide.pdf');
    expect(docs[0]?.folderId).toBe('FOLDER_ID');
  });
});

// ---------------------------------------------------------------------------
// fetchDocument
// ---------------------------------------------------------------------------

describe('GDriveConnector.fetchDocument', () => {
  it('streams a binary file via alt=media', async () => {
    // Two get() calls: first for metadata, second with alt=media for the body.
    mockedFiles.get
      .mockResolvedValueOnce({
        data: { id: 'D1', name: 'spec.pdf', mimeType: 'application/pdf' },
      })
      .mockResolvedValueOnce({
        data: Readable.from([Buffer.from('PDF-BYTES', 'utf8')]),
      });
    const connector = new GDriveConnector();
    const out = await connector.fetchDocument(baseConfig, 'src-1', 'gdrive:D1');
    expect(out.mimeType).toBe('application/pdf');
    expect(await drainToString(out.stream)).toBe('PDF-BYTES');
    // Second call must include `alt: 'media'`.
    const secondCall = mockedFiles.get.mock.calls[1]?.[0] as { alt?: string };
    expect(secondCall?.alt).toBe('media');
  });

  it('exports Google Docs to PDF', async () => {
    mockedFiles.get.mockResolvedValueOnce({
      data: {
        id: 'GDOC1',
        name: 'Roadmap',
        mimeType: 'application/vnd.google-apps.document',
      },
    });
    mockedFiles.export.mockResolvedValueOnce({
      data: Readable.from([Buffer.from('PDF-EXPORT', 'utf8')]),
    });
    const connector = new GDriveConnector();
    const out = await connector.fetchDocument(baseConfig, 'src-1', 'gdrive:GDOC1');
    expect(out.mimeType).toBe('application/pdf');
    expect(await drainToString(out.stream)).toBe('PDF-EXPORT');
    const exportArgs = mockedFiles.export.mock.calls[0]?.[0] as {
      fileId: string;
      mimeType: string;
    };
    expect(exportArgs.fileId).toBe('GDOC1');
    expect(exportArgs.mimeType).toBe('application/pdf');
  });

  it('exports Google Sheets to CSV', async () => {
    mockedFiles.get.mockResolvedValueOnce({
      data: {
        id: 'SHEET1',
        name: 'Budget',
        mimeType: 'application/vnd.google-apps.spreadsheet',
      },
    });
    mockedFiles.export.mockResolvedValueOnce({
      data: Readable.from([Buffer.from('a,b\n1,2\n', 'utf8')]),
    });
    const connector = new GDriveConnector();
    const out = await connector.fetchDocument(baseConfig, 'src-1', 'gdrive:SHEET1');
    expect(out.mimeType).toBe('text/csv');
    expect(await drainToString(out.stream)).toBe('a,b\n1,2\n');
  });

  it('throws UnsupportedGDriveMimeTypeError for unmapped Google Workspace types', async () => {
    mockedFiles.get.mockResolvedValueOnce({
      data: {
        id: 'DRAW1',
        name: 'Diagram',
        // We map document/spreadsheet/presentation only — drawings are not mapped.
        mimeType: 'application/vnd.google-apps.drawing',
      },
    });
    const connector = new GDriveConnector();
    await expect(
      connector.fetchDocument(baseConfig, 'src-1', 'gdrive:DRAW1'),
    ).rejects.toBeInstanceOf(UnsupportedGDriveMimeTypeError);
    expect(mockedFiles.export).not.toHaveBeenCalled();
  });

  it('throws GDriveDocumentNotFoundError on 404 metadata lookup', async () => {
    mockedFiles.get.mockRejectedValueOnce(sdkError(404));
    const connector = new GDriveConnector();
    await expect(
      connector.fetchDocument(baseConfig, 'src-1', 'gdrive:MISSING'),
    ).rejects.toBeInstanceOf(GDriveDocumentNotFoundError);
  });

  it('throws GDriveDocumentNotFoundError on docId with the wrong prefix', async () => {
    const connector = new GDriveConnector();
    await expect(
      connector.fetchDocument(baseConfig, 'src-1', 's3:not-a-gdrive-id'),
    ).rejects.toBeInstanceOf(GDriveDocumentNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Doc id round-trip
// ---------------------------------------------------------------------------

describe('doc id encode/decode', () => {
  it('round-trips Drive file ids verbatim with the gdrive: prefix', () => {
    const cases = [
      '1A2B3C4D5E6F7G8H9I0J',
      'abcdef-_1234567890',
      // Real-world Drive IDs are URL-safe base64 strings of variable length.
      'fakeId_with-special_characters',
    ];
    for (const id of cases) {
      const docId = __testing.encodeDocId(id);
      expect(docId).toBe(`gdrive:${id}`);
      expect(__testing.decodeDocId(docId)).toBe(id);
    }
  });

  it('rejects ids without the gdrive: prefix', () => {
    expect(() => __testing.decodeDocId('s3:abc')).toThrow(GDriveDocumentNotFoundError);
    expect(() => __testing.decodeDocId('garbage')).toThrow(GDriveDocumentNotFoundError);
    expect(() => __testing.decodeDocId('gdrive:')).toThrow(GDriveDocumentNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// narrowConfig
// ---------------------------------------------------------------------------

describe('narrowConfig', () => {
  it('accepts the service account key as a parsed object', () => {
    const out = __testing.narrowConfig(baseConfig);
    expect(out.rootFolderId).toBe('ROOT_FOLDER_ID');
    expect((out.serviceAccountKey as Record<string, unknown>).client_email).toBe(
      FAKE_KEY.client_email,
    );
    expect(out.recursive).toBe(true);
  });

  it('accepts the service account key as a JSON string', () => {
    const out = __testing.narrowConfig({
      ...baseConfig,
      serviceAccountKey: JSON.stringify(FAKE_KEY),
    });
    expect((out.serviceAccountKey as Record<string, unknown>).client_email).toBe(
      FAKE_KEY.client_email,
    );
  });

  it('throws on malformed JSON string', () => {
    expect(() =>
      __testing.narrowConfig({ ...baseConfig, serviceAccountKey: '{ not valid json' }),
    ).toThrow(/not valid JSON/i);
  });

  it('throws when serviceAccountKey is missing client_email', () => {
    const { client_email: _client_email, ...rest } = FAKE_KEY;
    void _client_email;
    expect(() => __testing.narrowConfig({ ...baseConfig, serviceAccountKey: rest })).toThrow(
      /client_email/,
    );
  });

  it('throws when rootFolderId is missing or empty', () => {
    expect(() => __testing.narrowConfig({ serviceAccountKey: FAKE_KEY })).toThrow(/rootFolderId/);
    expect(() => __testing.narrowConfig({ serviceAccountKey: FAKE_KEY, rootFolderId: '' })).toThrow(
      /rootFolderId/,
    );
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
  it('pickExportMime maps Workspace mimes to PDF/CSV', () => {
    expect(__testing.pickExportMime('application/vnd.google-apps.document')).toBe(
      'application/pdf',
    );
    expect(__testing.pickExportMime('application/vnd.google-apps.spreadsheet')).toBe('text/csv');
    expect(__testing.pickExportMime('application/vnd.google-apps.presentation')).toBe(
      'application/pdf',
    );
    expect(__testing.pickExportMime('application/vnd.google-apps.drawing')).toBeNull();
    expect(__testing.pickExportMime('application/pdf')).toBeNull();
  });

  it('isGoogleWorkspaceMime detects the vnd.google-apps prefix', () => {
    expect(__testing.isGoogleWorkspaceMime('application/vnd.google-apps.document')).toBe(true);
    expect(__testing.isGoogleWorkspaceMime('application/vnd.google-apps.unknown')).toBe(true);
    expect(__testing.isGoogleWorkspaceMime('application/pdf')).toBe(false);
  });

  it('matchMimeTypes applies include/exclude semantics', () => {
    expect(__testing.matchMimeTypes('application/pdf', undefined, undefined)).toBe(true);
    expect(__testing.matchMimeTypes('application/pdf', ['application/pdf'], undefined)).toBe(true);
    expect(__testing.matchMimeTypes('text/plain', ['application/pdf'], undefined)).toBe(false);
    expect(__testing.matchMimeTypes('text/plain', undefined, ['text/plain'])).toBe(false);
    // Exclude wins over include.
    expect(__testing.matchMimeTypes('text/plain', ['text/plain'], ['text/plain'])).toBe(false);
  });

  it('clientCacheKey ignores prefix/folderId/filters and only keys on email+pk+impersonate', () => {
    const k1 = __testing.clientCacheKey({
      serviceAccountKey: FAKE_KEY,
      rootFolderId: 'A',
    });
    const k2 = __testing.clientCacheKey({
      serviceAccountKey: FAKE_KEY,
      rootFolderId: 'B',
      includeMimeTypes: ['application/pdf'],
    });
    expect(k1).toBe(k2);
    const k3 = __testing.clientCacheKey({
      serviceAccountKey: FAKE_KEY,
      rootFolderId: 'A',
      impersonateAs: 'user@example.com',
    });
    expect(k3).not.toBe(k1);
  });

  it('mapTestConnectionError produces distinct messages per status', () => {
    expect(__testing.mapTestConnectionError(sdkError(401), 'sa@x', 'F').message).toMatch(
      /authentication failed/i,
    );
    expect(__testing.mapTestConnectionError(sdkError(403), 'sa@x', 'F').message).toMatch(/sa@x/);
    expect(__testing.mapTestConnectionError(sdkError(404), 'sa@x', 'F').message).toMatch(
      /not found/i,
    );
    expect(__testing.mapTestConnectionError(new Error('boom'), 'sa@x', 'F').message).toMatch(
      /API error/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Type discriminator
// ---------------------------------------------------------------------------

describe('GDriveConnector type discriminator', () => {
  it("exposes type === 'gdrive' so the registry can dispatch on it", () => {
    const c = new GDriveConnector();
    expect(c.type).toBe('gdrive');
  });
});
