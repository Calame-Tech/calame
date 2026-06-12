// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mock googleapis.
//
// The Sheets resource exposes `spreadsheets.get` and `spreadsheets.values.get`.
// The Drive resource exposes `files.get` and `files.list`. Each test
// re-binds the per-method mocks via `mockedSheets` / `mockedFiles`, which
// the factory closes over.
// ---------------------------------------------------------------------------

interface MockedSheets {
  get: ReturnType<typeof vi.fn>;
  valuesGet: ReturnType<typeof vi.fn>;
}

interface MockedFiles {
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

let mockedSheets: MockedSheets;
let mockedFiles: MockedFiles;

vi.mock('googleapis', () => {
  return {
    google: {
      auth: {
        JWT: vi.fn().mockImplementation(function (this: unknown) {
          return this;
        }),
      },
      sheets: vi.fn(() => ({
        spreadsheets: {
          get: (...args: unknown[]) => mockedSheets.get(...args),
          values: {
            get: (...args: unknown[]) => mockedSheets.valuesGet(...args),
          },
        },
      })),
      drive: vi.fn(() => ({
        files: {
          get: (...args: unknown[]) => mockedFiles.get(...args),
          list: (...args: unknown[]) => mockedFiles.list(...args),
        },
      })),
    },
  };
});

// Import AFTER the mock is registered.
import {
  GSheetsConnector,
  GSheetsDocumentNotFoundError,
  __testing,
} from '../gsheets.js';
import type { RagFolder } from '@calame-ee/rag-core';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const FAKE_KEY = {
  client_email: 'rag@example-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
  token_uri: 'https://oauth2.googleapis.com/token',
};

const baseIdsConfig = {
  serviceAccountKey: FAKE_KEY,
  spreadsheetIds: ['SS_1'],
};

const baseFolderConfig = {
  serviceAccountKey: FAKE_KEY,
  driveFolderId: 'FOLDER_1',
};

beforeEach(() => {
  mockedSheets = { get: vi.fn(), valuesGet: vi.fn() };
  mockedFiles = { get: vi.fn(), list: vi.fn() };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sdkError(code: number, message = `error ${code}`): Error & { code: number } {
  const e = new Error(message) as Error & { code: number };
  e.code = code;
  return e;
}

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

describe('GSheetsConnector.testConnection', () => {
  it('resolves silently when the first spreadsheet id is reachable (IDs mode)', async () => {
    mockedSheets.get.mockResolvedValueOnce({
      data: { spreadsheetId: 'SS_1', properties: { title: 'Q1 Budget' } },
    });
    const connector = new GSheetsConnector();
    await expect(connector.testConnection(baseIdsConfig)).resolves.toBeUndefined();
    expect(mockedSheets.get).toHaveBeenCalledWith(
      expect.objectContaining({ spreadsheetId: 'SS_1' }),
    );
  });

  it('resolves silently when the folder id resolves to a Drive folder (folder mode)', async () => {
    mockedFiles.get.mockResolvedValueOnce({
      data: { id: 'FOLDER_1', name: 'KB', mimeType: 'application/vnd.google-apps.folder' },
    });
    const connector = new GSheetsConnector();
    await expect(connector.testConnection(baseFolderConfig)).resolves.toBeUndefined();
    expect(mockedFiles.get).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'FOLDER_1' }),
    );
  });

  it('throws an admin-friendly 401 auth message', async () => {
    mockedSheets.get.mockRejectedValueOnce(sdkError(401));
    const connector = new GSheetsConnector();
    await expect(connector.testConnection(baseIdsConfig)).rejects.toThrow(
      /authentication failed/i,
    );
  });

  it('throws an admin-friendly 403 message including the service account email', async () => {
    mockedSheets.get.mockRejectedValueOnce(sdkError(403));
    const connector = new GSheetsConnector();
    await expect(connector.testConnection(baseIdsConfig)).rejects.toThrow(
      /rag@example-project\.iam\.gserviceaccount\.com/,
    );
  });

  it('throws an admin-friendly 404 message when the spreadsheet id is wrong', async () => {
    mockedSheets.get.mockRejectedValueOnce(sdkError(404));
    const connector = new GSheetsConnector();
    await expect(connector.testConnection(baseIdsConfig)).rejects.toThrow(/not found/i);
  });

  it('rejects when the folder id resolves to a file (not a folder)', async () => {
    mockedFiles.get.mockResolvedValueOnce({
      data: {
        id: 'FOLDER_1',
        name: 'budget.xlsx',
        mimeType: 'application/vnd.google-apps.spreadsheet',
      },
    });
    const connector = new GSheetsConnector();
    await expect(connector.testConnection(baseFolderConfig)).rejects.toThrow(/not a folder/i);
  });
});

// ---------------------------------------------------------------------------
// listFolders
// ---------------------------------------------------------------------------

describe('GSheetsConnector.listFolders', () => {
  it('returns one synthetic folder per explicit spreadsheet id', async () => {
    mockedSheets.get.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'SS_1',
        properties: { title: 'Q1 Budget' },
        sheets: [{ properties: { sheetId: 0, title: 'Plan' } }],
      },
    });
    mockedFiles.get.mockResolvedValueOnce({
      data: { modifiedTime: '2026-05-01T00:00:00Z' },
    });
    const connector = new GSheetsConnector();
    const folders = await connector.listFolders(baseIdsConfig, 'src-1');
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({
      id: 'gsheets:ss:SS_1',
      sourceId: 'src-1',
      parentId: null,
      path: 'Q1 Budget',
      name: 'Q1 Budget',
    });
  });

  it('deduplicates spreadsheet ids and surfaces multiple workbooks in order', async () => {
    mockedSheets.get
      .mockResolvedValueOnce({
        data: {
          spreadsheetId: 'SS_1',
          properties: { title: 'A' },
          sheets: [{ properties: { sheetId: 0, title: 'Tab' } }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          spreadsheetId: 'SS_2',
          properties: { title: 'B' },
          sheets: [{ properties: { sheetId: 0, title: 'Tab' } }],
        },
      });
    mockedFiles.get
      .mockResolvedValueOnce({ data: { modifiedTime: '2026-05-01T00:00:00Z' } })
      .mockResolvedValueOnce({ data: { modifiedTime: '2026-05-02T00:00:00Z' } });
    const connector = new GSheetsConnector();
    const folders = await connector.listFolders(
      { ...baseIdsConfig, spreadsheetIds: ['SS_1', 'SS_2', 'SS_1'] },
      'src-1',
    );
    expect(folders.map((f) => f.id)).toEqual(['gsheets:ss:SS_1', 'gsheets:ss:SS_2']);
  });

  it('enumerates spreadsheets in folder mode and paginates correctly', async () => {
    mockedFiles.list
      .mockResolvedValueOnce({
        data: {
          files: [
            { id: 'SS_A', name: 'Sheet A', modifiedTime: '2026-05-01T00:00:00Z' },
          ],
          nextPageToken: 'NEXT',
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [{ id: 'SS_B', name: 'Sheet B', modifiedTime: '2026-05-02T00:00:00Z' }],
        },
      });
    const connector = new GSheetsConnector();
    const folders = await connector.listFolders(baseFolderConfig, 'src-1');
    expect(folders.map((f) => f.id)).toEqual(['gsheets:ss:SS_A', 'gsheets:ss:SS_B']);
    expect(mockedFiles.list).toHaveBeenCalledTimes(2);
    // The list filter must restrict to spreadsheet mime types under the folder.
    const firstCall = mockedFiles.list.mock.calls[0]?.[0] as { q?: string };
    expect(firstCall?.q).toContain("'FOLDER_1' in parents");
    expect(firstCall?.q).toContain("application/vnd.google-apps.spreadsheet");
  });

  it('returns [] when called with a parent folder (no sub-folder concept)', async () => {
    const connector = new GSheetsConnector();
    const parent: RagFolder = {
      id: 'gsheets:ss:SS_X',
      sourceId: 'src-1',
      parentId: null,
      path: 'X',
      name: 'X',
      createdAt: '',
    };
    const folders = await connector.listFolders(baseIdsConfig, 'src-1', parent);
    expect(folders).toEqual([]);
    expect(mockedSheets.get).not.toHaveBeenCalled();
  });

  it('skips a forbidden / missing spreadsheet id rather than failing the whole listing', async () => {
    mockedSheets.get.mockRejectedValueOnce(sdkError(404));
    const connector = new GSheetsConnector();
    const folders = await connector.listFolders(baseIdsConfig, 'src-1');
    expect(folders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listDocuments
// ---------------------------------------------------------------------------

describe('GSheetsConnector.listDocuments', () => {
  it('emits one RagDocument per tab (single-tab spreadsheet)', async () => {
    mockedSheets.get.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'SS_1',
        properties: { title: 'Q1 Budget' },
        sheets: [{ properties: { sheetId: 0, title: 'Plan' } }],
      },
    });
    mockedFiles.get.mockResolvedValueOnce({
      data: { modifiedTime: '2026-05-01T00:00:00Z' },
    });
    const connector = new GSheetsConnector();
    const folder: RagFolder = {
      id: 'gsheets:ss:SS_1',
      sourceId: 'src-1',
      parentId: null,
      path: 'Q1 Budget',
      name: 'Q1 Budget',
      createdAt: '',
    };
    const docs = await connector.listDocuments(baseIdsConfig, 'src-1', folder);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: 'gsheets:tab:SS_1:0',
      sourceId: 'src-1',
      folderId: 'gsheets:ss:SS_1',
      path: 'Q1 Budget/Plan',
      name: 'Plan',
      mimeType: 'text/csv',
      etag: '2026-05-01T00:00:00Z',
      hash: '',
      size: 0,
    });
  });

  it('emits N RagDocuments for a multi-tab spreadsheet', async () => {
    mockedSheets.get.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'SS_1',
        properties: { title: 'Books' },
        sheets: [
          { properties: { sheetId: 0, title: 'Sales' } },
          { properties: { sheetId: 123, title: 'Forecast' } },
          { properties: { sheetId: 999, title: 'Notes' } },
        ],
      },
    });
    mockedFiles.get.mockResolvedValueOnce({ data: { modifiedTime: '2026-05-01T00:00:00Z' } });
    const connector = new GSheetsConnector();
    const folder: RagFolder = {
      id: 'gsheets:ss:SS_1',
      sourceId: 'src-1',
      parentId: null,
      path: 'Books',
      name: 'Books',
      createdAt: '',
    };
    const docs = await connector.listDocuments(baseIdsConfig, 'src-1', folder);
    expect(docs.map((d) => d.id)).toEqual([
      'gsheets:tab:SS_1:0',
      'gsheets:tab:SS_1:123',
      'gsheets:tab:SS_1:999',
    ]);
  });

  it('skips archived-looking tabs by default', async () => {
    mockedSheets.get.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'SS_1',
        properties: { title: 'Books' },
        sheets: [
          { properties: { sheetId: 0, title: 'Sales' } },
          { properties: { sheetId: 1, title: 'archive_2024' } },
          { properties: { sheetId: 2, title: '_old' } },
          { properties: { sheetId: 3, title: 'Forecast' } },
        ],
      },
    });
    mockedFiles.get.mockResolvedValueOnce({ data: { modifiedTime: '2026-05-01T00:00:00Z' } });
    const connector = new GSheetsConnector();
    const folder: RagFolder = {
      id: 'gsheets:ss:SS_1',
      sourceId: 'src-1',
      parentId: null,
      path: 'Books',
      name: 'Books',
      createdAt: '',
    };
    const docs = await connector.listDocuments(baseIdsConfig, 'src-1', folder);
    expect(docs.map((d) => d.name)).toEqual(['Sales', 'Forecast']);
  });

  it('includes archived tabs when includeArchived=true', async () => {
    mockedSheets.get.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'SS_1',
        properties: { title: 'Books' },
        sheets: [
          { properties: { sheetId: 0, title: 'archive_2024' } },
          { properties: { sheetId: 1, title: 'Sales' } },
        ],
      },
    });
    mockedFiles.get.mockResolvedValueOnce({ data: { modifiedTime: '2026-05-01T00:00:00Z' } });
    const connector = new GSheetsConnector();
    const folder: RagFolder = {
      id: 'gsheets:ss:SS_1',
      sourceId: 'src-1',
      parentId: null,
      path: 'Books',
      name: 'Books',
      createdAt: '',
    };
    const docs = await connector.listDocuments(
      { ...baseIdsConfig, includeArchived: true },
      'src-1',
      folder,
    );
    expect(docs.map((d) => d.name)).toEqual(['archive_2024', 'Sales']);
  });

  it('returns [] when listDocuments is called without a parent folder', async () => {
    const connector = new GSheetsConnector();
    const docs = await connector.listDocuments(baseIdsConfig, 'src-1');
    expect(docs).toEqual([]);
    expect(mockedSheets.get).not.toHaveBeenCalled();
  });

  it('translates a 404 from the spreadsheet metadata fetch into GSheetsDocumentNotFoundError', async () => {
    mockedSheets.get.mockRejectedValueOnce(sdkError(404));
    const connector = new GSheetsConnector();
    const folder: RagFolder = {
      id: 'gsheets:ss:MISSING',
      sourceId: 'src-1',
      parentId: null,
      path: 'X',
      name: 'X',
      createdAt: '',
    };
    await expect(
      connector.listDocuments(baseIdsConfig, 'src-1', folder),
    ).rejects.toBeInstanceOf(GSheetsDocumentNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// fetchDocument
// ---------------------------------------------------------------------------

describe('GSheetsConnector.fetchDocument', () => {
  it('returns CSV with the header row and rows, properly escaped', async () => {
    mockedSheets.get.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'SS_1',
        properties: { title: 'Books' },
        sheets: [{ properties: { sheetId: 0, title: 'Sales' } }],
      },
    });
    mockedFiles.get.mockResolvedValueOnce({ data: { modifiedTime: '2026-05-01T00:00:00Z' } });
    mockedSheets.valuesGet.mockResolvedValueOnce({
      data: {
        range: "'Sales'!A:ZZ",
        values: [
          ['name', 'sales', 'note'],
          ['Alice', 100, 'top of "Q1"'],
          ['Bob, sr.', 95, 'second'],
        ],
      },
    });
    const connector = new GSheetsConnector();
    const out = await connector.fetchDocument(baseIdsConfig, 'src-1', 'gsheets:tab:SS_1:0');
    expect(out.mimeType).toBe('text/csv');
    const csv = await drainToString(out.stream);
    expect(csv).toBe(
      '"name","sales","note"\n' +
        '"Alice","100","top of ""Q1"""\n' +
        '"Bob, sr.","95","second"',
    );
  });

  it('honors the configured defaultRange (range body only)', async () => {
    mockedSheets.get.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'SS_1',
        properties: { title: 'Books' },
        sheets: [{ properties: { sheetId: 0, title: 'Sales' } }],
      },
    });
    mockedFiles.get.mockResolvedValueOnce({ data: { modifiedTime: '2026-05-01T00:00:00Z' } });
    mockedSheets.valuesGet.mockResolvedValueOnce({
      data: { values: [['a']] },
    });
    const connector = new GSheetsConnector();
    await connector.fetchDocument(
      { ...baseIdsConfig, defaultRange: 'A1:D100' },
      'src-1',
      'gsheets:tab:SS_1:0',
    );
    const call = mockedSheets.valuesGet.mock.calls[0]?.[0] as { range?: string };
    expect(call?.range).toBe("'Sales'!A1:D100");
  });

  it('quotes sheet titles containing spaces and apostrophes', async () => {
    mockedSheets.get.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'SS_1',
        properties: { title: 'Books' },
        sheets: [{ properties: { sheetId: 7, title: "Q1 'Forecast'" } }],
      },
    });
    mockedFiles.get.mockResolvedValueOnce({ data: { modifiedTime: '2026-05-01T00:00:00Z' } });
    mockedSheets.valuesGet.mockResolvedValueOnce({ data: { values: [['x']] } });
    const connector = new GSheetsConnector();
    await connector.fetchDocument(baseIdsConfig, 'src-1', 'gsheets:tab:SS_1:7');
    const call = mockedSheets.valuesGet.mock.calls[0]?.[0] as { range?: string };
    expect(call?.range).toBe("'Q1 ''Forecast'''!A:ZZ");
  });

  it('emits an empty CSV when the sheet has no values', async () => {
    mockedSheets.get.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'SS_1',
        properties: { title: 'Books' },
        sheets: [{ properties: { sheetId: 0, title: 'Empty' } }],
      },
    });
    mockedFiles.get.mockResolvedValueOnce({ data: { modifiedTime: '2026-05-01T00:00:00Z' } });
    mockedSheets.valuesGet.mockResolvedValueOnce({ data: {} });
    const connector = new GSheetsConnector();
    const out = await connector.fetchDocument(baseIdsConfig, 'src-1', 'gsheets:tab:SS_1:0');
    expect(await drainToString(out.stream)).toBe('');
  });

  it('throws GSheetsDocumentNotFoundError on a docId with the wrong prefix', async () => {
    const connector = new GSheetsConnector();
    await expect(
      connector.fetchDocument(baseIdsConfig, 'src-1', 'gdrive:NOT-A-SHEETS-ID'),
    ).rejects.toBeInstanceOf(GSheetsDocumentNotFoundError);
  });

  it('throws GSheetsDocumentNotFoundError when the sheetId is unknown for the workbook', async () => {
    mockedSheets.get.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'SS_1',
        properties: { title: 'Books' },
        sheets: [{ properties: { sheetId: 0, title: 'Plan' } }],
      },
    });
    mockedFiles.get.mockResolvedValueOnce({ data: { modifiedTime: '2026-05-01T00:00:00Z' } });
    const connector = new GSheetsConnector();
    await expect(
      connector.fetchDocument(baseIdsConfig, 'src-1', 'gsheets:tab:SS_1:42'),
    ).rejects.toBeInstanceOf(GSheetsDocumentNotFoundError);
  });

  it('throws GSheetsDocumentNotFoundError on a 404 from spreadsheets.get', async () => {
    mockedSheets.get.mockRejectedValueOnce(sdkError(404));
    const connector = new GSheetsConnector();
    await expect(
      connector.fetchDocument(baseIdsConfig, 'src-1', 'gsheets:tab:SS_MISSING:0'),
    ).rejects.toBeInstanceOf(GSheetsDocumentNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Doc / folder id round-trip
// ---------------------------------------------------------------------------

describe('id encode/decode', () => {
  it('round-trips spreadsheetId + sheetId through encodeDocId / decodeDocId', () => {
    const cases: Array<[string, number]> = [
      ['1A2B3C4D5E6F7G8H9I0J', 0],
      ['abc-_xyz', 123],
      ['fakeId_with-special_characters', 4294967295],
    ];
    for (const [ssid, sid] of cases) {
      const docId = __testing.encodeDocId(ssid, sid);
      expect(docId).toBe(`gsheets:tab:${ssid}:${sid}`);
      const decoded = __testing.decodeDocId(docId);
      expect(decoded.spreadsheetId).toBe(ssid);
      expect(decoded.sheetId).toBe(sid);
    }
  });

  it('rejects ids without the gsheets:tab: prefix', () => {
    expect(() => __testing.decodeDocId('gdrive:abc')).toThrow(GSheetsDocumentNotFoundError);
    expect(() => __testing.decodeDocId('gsheets:ss:abc')).toThrow(
      GSheetsDocumentNotFoundError,
    );
    expect(() => __testing.decodeDocId('garbage')).toThrow(GSheetsDocumentNotFoundError);
    expect(() => __testing.decodeDocId('gsheets:tab:')).toThrow(GSheetsDocumentNotFoundError);
    expect(() => __testing.decodeDocId('gsheets:tab:SS:not-a-number')).toThrow(
      GSheetsDocumentNotFoundError,
    );
  });

  it('round-trips folder ids', () => {
    const fid = __testing.encodeFolderId('SS_42');
    expect(fid).toBe('gsheets:ss:SS_42');
    expect(__testing.decodeFolderId(fid)).toBe('SS_42');
    expect(() => __testing.decodeFolderId('gsheets:tab:SS:0')).toThrow();
    expect(() => __testing.decodeFolderId('gsheets:ss:')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// narrowConfig
// ---------------------------------------------------------------------------

describe('narrowConfig', () => {
  it('accepts the service account key as a parsed object', () => {
    const out = __testing.narrowConfig(baseIdsConfig);
    expect(out.spreadsheetIds).toEqual(['SS_1']);
    expect((out.serviceAccountKey as Record<string, unknown>).client_email).toBe(
      FAKE_KEY.client_email,
    );
  });

  it('accepts the service account key as a JSON string', () => {
    const out = __testing.narrowConfig({
      ...baseIdsConfig,
      serviceAccountKey: JSON.stringify(FAKE_KEY),
    });
    expect((out.serviceAccountKey as Record<string, unknown>).client_email).toBe(
      FAKE_KEY.client_email,
    );
  });

  it('throws on malformed JSON string', () => {
    expect(() =>
      __testing.narrowConfig({ ...baseIdsConfig, serviceAccountKey: '{ not valid json' }),
    ).toThrow(/not valid JSON/i);
  });

  it('throws when serviceAccountKey is missing client_email', () => {
    const { client_email: _client_email, ...rest } = FAKE_KEY;
    void _client_email;
    expect(() =>
      __testing.narrowConfig({ ...baseIdsConfig, serviceAccountKey: rest }),
    ).toThrow(/client_email/);
  });

  it('throws when neither spreadsheetIds nor driveFolderId is set', () => {
    expect(() => __testing.narrowConfig({ serviceAccountKey: FAKE_KEY })).toThrow(
      /at least one of/i,
    );
  });

  it('accepts a configuration with both spreadsheetIds and driveFolderId', () => {
    const out = __testing.narrowConfig({
      serviceAccountKey: FAKE_KEY,
      spreadsheetIds: ['A'],
      driveFolderId: 'F',
    });
    expect(out.spreadsheetIds).toEqual(['A']);
    expect(out.driveFolderId).toBe('F');
  });

  it('drops empty / whitespace entries from spreadsheetIds and treats empty arrays as absent', () => {
    expect(() =>
      __testing.narrowConfig({
        serviceAccountKey: FAKE_KEY,
        spreadsheetIds: ['  ', ''],
      }),
    ).toThrow(/at least one of/i);
  });

  it('coerces includeArchived to a strict boolean and rejects non-booleans', () => {
    expect(__testing.narrowConfig({ ...baseIdsConfig }).includeArchived).toBe(false);
    expect(
      __testing.narrowConfig({ ...baseIdsConfig, includeArchived: true }).includeArchived,
    ).toBe(true);
    expect(() =>
      __testing.narrowConfig({
        ...baseIdsConfig,
        includeArchived: 'yes' as unknown as boolean,
      }),
    ).toThrow(/includeArchived/);
  });
});

// ---------------------------------------------------------------------------
// Helpers (csv, archive predicate, cache key, error mapper)
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('valuesToCsv emits empty string for empty input', () => {
    expect(__testing.valuesToCsv([])).toBe('');
  });

  it('valuesToCsv escapes commas, quotes, and newlines via RFC 4180', () => {
    const csv = __testing.valuesToCsv([
      ['plain', 'with, comma', 'with "quote"'],
      ['multi\nline', '', null],
    ]);
    expect(csv).toBe(
      '"plain","with, comma","with ""quote"""\n' + '"multi\nline","",""',
    );
  });

  it('isArchivedSheetTitle catches archive_ and _old prefixes case-insensitively', () => {
    expect(__testing.isArchivedSheetTitle('archive_2024')).toBe(true);
    expect(__testing.isArchivedSheetTitle('Archive_legacy')).toBe(true);
    expect(__testing.isArchivedSheetTitle('_old')).toBe(true);
    expect(__testing.isArchivedSheetTitle('_OLD')).toBe(true);
    expect(__testing.isArchivedSheetTitle('Sales')).toBe(false);
    expect(__testing.isArchivedSheetTitle('Archive')).toBe(false);
  });

  it('quoteSheetTitle escapes embedded apostrophes', () => {
    expect(__testing.quoteSheetTitle('Plain')).toBe("'Plain'");
    expect(__testing.quoteSheetTitle("Q1 'Forecast'")).toBe("'Q1 ''Forecast'''");
  });

  it("clientCacheKey is stable across spreadsheetIds / folder / range and tied to credentials", () => {
    const k1 = __testing.clientCacheKey({
      serviceAccountKey: FAKE_KEY,
      spreadsheetIds: ['A'],
    });
    const k2 = __testing.clientCacheKey({
      serviceAccountKey: FAKE_KEY,
      driveFolderId: 'B',
      defaultRange: 'A:C',
    });
    expect(k1).toBe(k2);
    const k3 = __testing.clientCacheKey({
      serviceAccountKey: FAKE_KEY,
      spreadsheetIds: ['A'],
      impersonateAs: 'user@example.com',
    });
    expect(k3).not.toBe(k1);
  });

  it('mapTestConnectionError produces distinct messages per status', () => {
    expect(
      __testing.mapTestConnectionError(sdkError(401), 'sa@x', 'F', 'folder').message,
    ).toMatch(/authentication failed/i);
    expect(
      __testing.mapTestConnectionError(sdkError(403), 'sa@x', 'F', 'spreadsheet').message,
    ).toMatch(/sa@x/);
    expect(
      __testing.mapTestConnectionError(sdkError(404), 'sa@x', 'F', 'folder').message,
    ).toMatch(/not found/i);
    expect(
      __testing.mapTestConnectionError(new Error('boom'), 'sa@x', 'F', 'folder').message,
    ).toMatch(/API error/i);
  });
});

// ---------------------------------------------------------------------------
// Type discriminator
// ---------------------------------------------------------------------------

describe('GSheetsConnector type discriminator', () => {
  it("exposes type === 'gsheets' so the registry can dispatch on it", () => {
    const c = new GSheetsConnector();
    expect(c.type).toBe('gsheets');
  });
});
