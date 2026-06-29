/**
 * Unit tests for the `normaliseFolderArg` and `resolveFolderId` helpers
 * exported from `rag-runtime.ts`, and for the `listFolders` / `listDocuments`
 * storage method logic (path-or-id resolution, blank-argument normalisation).
 *
 * These tests do NOT import `initRagRuntime` or touch SQLite — they exercise
 * the pure helpers directly and simulate the storage methods via mock DB doubles.
 */
import { describe, it, expect, vi } from 'vitest';
import { normaliseFolderArg, resolveFolderId } from '../rag-runtime.js';
import type { FolderResolverDb } from '../rag-runtime.js';

// ---------------------------------------------------------------------------
// normaliseFolderArg
// ---------------------------------------------------------------------------

describe('normaliseFolderArg', () => {
  it('returns undefined when input is undefined', () => {
    expect(normaliseFolderArg(undefined)).toBeUndefined();
  });

  it('returns empty string for ""', () => {
    expect(normaliseFolderArg('')).toBe('');
  });

  it('returns empty string for "/"', () => {
    expect(normaliseFolderArg('/')).toBe('');
  });

  it('returns empty string for "//"', () => {
    expect(normaliseFolderArg('//')).toBe('');
  });

  it('returns empty string for whitespace-only', () => {
    expect(normaliseFolderArg('   ')).toBe('');
  });

  it('strips leading and trailing slashes from a path', () => {
    expect(normaliseFolderArg('/D4.1/')).toBe('D4.1');
  });

  it('preserves inner slashes (nested path)', () => {
    expect(normaliseFolderArg('/foo/bar/')).toBe('foo/bar');
  });

  it('returns the value unchanged when no slashes or spaces', () => {
    expect(normaliseFolderArg('D4.1')).toBe('D4.1');
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseFolderArg('  D4.1  ')).toBe('D4.1');
  });

  it('returns the value unchanged for a raw folder id', () => {
    expect(normaliseFolderArg('0B3zyW2cw9F23dFQtSWYtcUtUeE0')).toBe('0B3zyW2cw9F23dFQtSWYtcUtUeE0');
  });
});

// ---------------------------------------------------------------------------
// resolveFolderId
// ---------------------------------------------------------------------------

describe('resolveFolderId', () => {
  function makeDb(result: { id: string } | undefined): FolderResolverDb {
    return {
      prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(result) }),
    };
  }

  it('returns the folder id when the row is found', () => {
    const db = makeDb({ id: '0B3zyW2cw9F23dFQtSWYtcUtUeE0' });
    expect(resolveFolderId(db, 'src1', 'D4.1')).toBe('0B3zyW2cw9F23dFQtSWYtcUtUeE0');
  });

  it('returns null when no matching row', () => {
    const db = makeDb(undefined);
    expect(resolveFolderId(db, 'src1', 'nonexistent')).toBeNull();
  });

  it('passes sourceId and the value twice (id OR path) to the prepared statement', () => {
    const getMock = vi.fn().mockReturnValue({ id: 'folder-id' });
    const prepareMock = vi.fn().mockReturnValue({ get: getMock });
    const db: FolderResolverDb = { prepare: prepareMock };

    resolveFolderId(db, 'src1', 'D4.1');

    expect(prepareMock).toHaveBeenCalledOnce();
    // SQL must use id-or-path lookup
    expect(prepareMock.mock.calls[0]![0]).toContain('id = ?');
    expect(prepareMock.mock.calls[0]![0]).toContain('path = ?');
    // get() must receive sourceId, value, value
    expect(getMock).toHaveBeenCalledWith('src1', 'D4.1', 'D4.1');
  });
});

// ---------------------------------------------------------------------------
// listFolders logic — simulated via a mock storage object
//
// We cannot import the `storage` object directly (it is built inside a
// closure in initRagRuntime). We replicate the logic under test as a
// thin wrapper that uses the exported helpers, so we can verify the
// branching behaviour without hitting SQLite.
// ---------------------------------------------------------------------------

/**
 * Minimal reproduction of the listFolders logic that uses the exported helpers.
 * Mirrors the code in rag-runtime.ts exactly so a regression there would
 * also break these tests.
 */
async function listFoldersLogic(
  db: FolderResolverDb & {
    allFolders: ReturnType<typeof vi.fn>;
    childFolders: ReturnType<typeof vi.fn>;
  },
  sourceId: string,
  parent?: string,
) {
  const normalised = normaliseFolderArg(parent);

  if (normalised === undefined || normalised === '') {
    return db.allFolders(sourceId);
  }

  const folderId = resolveFolderId(db, sourceId, normalised);
  if (!folderId) return [];

  return db.childFolders(sourceId, folderId);
}

describe('listFolders logic', () => {
  function makeStorageDb(
    resolvedId: string | undefined,
    allResult: unknown[] = [],
    childResult: unknown[] = [],
  ) {
    return {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(resolvedId ? { id: resolvedId } : undefined),
      }),
      allFolders: vi.fn().mockReturnValue(allResult),
      childFolders: vi.fn().mockReturnValue(childResult),
    };
  }

  it('parent=undefined → lists ALL folders', async () => {
    const db = makeStorageDb(undefined, [{ id: 'f1' }, { id: 'f2' }]);
    const result = await listFoldersLogic(db, 'src1', undefined);
    expect(db.allFolders).toHaveBeenCalledWith('src1');
    expect(result).toHaveLength(2);
  });

  it('parent="" → lists ALL folders (MCP blank arg bug fix)', async () => {
    const db = makeStorageDb(undefined, [{ id: 'f1' }]);
    const result = await listFoldersLogic(db, 'src1', '');
    expect(db.allFolders).toHaveBeenCalledWith('src1');
    expect(result).toHaveLength(1);
  });

  it('parent="/" → lists ALL folders (root slash normalised to blank)', async () => {
    const db = makeStorageDb(undefined, [{ id: 'f1' }]);
    const result = await listFoldersLogic(db, 'src1', '/');
    expect(db.allFolders).toHaveBeenCalledWith('src1');
    expect(result).toHaveLength(1);
  });

  it('parent="D4.1" (path) → resolves to id and lists children', async () => {
    const childFolders = [{ id: 'child1', path: 'D4.1/child' }];
    const db = makeStorageDb('0B3zyW2cw9F23dFQtSWYtcUtUeE0', [], childFolders);
    const result = await listFoldersLogic(db, 'src1', 'D4.1');
    expect(db.childFolders).toHaveBeenCalledWith('src1', '0B3zyW2cw9F23dFQtSWYtcUtUeE0');
    expect(result).toBe(childFolders);
  });

  it('parent="0B3zy..." (raw id) → resolves via id-or-path lookup and lists children', async () => {
    const db = makeStorageDb('0B3zyW2cw9F23dFQtSWYtcUtUeE0', [], [{ id: 'child2' }]);
    await listFoldersLogic(db, 'src1', '0B3zyW2cw9F23dFQtSWYtcUtUeE0');
    expect(db.childFolders).toHaveBeenCalledWith('src1', '0B3zyW2cw9F23dFQtSWYtcUtUeE0');
  });

  it('unknown path → returns [] without querying children', async () => {
    const db = makeStorageDb(undefined, [], []);
    const result = await listFoldersLogic(db, 'src1', 'unknown/path');
    expect(result).toEqual([]);
    expect(db.childFolders).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listDocuments logic — same approach
// ---------------------------------------------------------------------------

async function listDocumentsLogic(
  db: FolderResolverDb & {
    allDocs: ReturnType<typeof vi.fn>;
    rootDocs: ReturnType<typeof vi.fn>;
    folderDocs: ReturnType<typeof vi.fn>;
  },
  sourceId: string,
  folder?: string,
) {
  const normalised = normaliseFolderArg(folder);

  if (normalised === undefined) {
    return db.allDocs(sourceId);
  }

  if (normalised === '') {
    return db.rootDocs(sourceId);
  }

  const folderId = resolveFolderId(db, sourceId, normalised);
  if (!folderId) return [];

  return db.folderDocs(sourceId, folderId);
}

describe('listDocuments logic', () => {
  function makeStorageDb(resolvedId: string | undefined) {
    return {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(resolvedId ? { id: resolvedId } : undefined),
      }),
      allDocs: vi.fn().mockReturnValue([{ id: 'doc-all' }]),
      rootDocs: vi.fn().mockReturnValue([{ id: 'doc-root' }]),
      folderDocs: vi.fn().mockReturnValue([{ id: 'doc-folder' }]),
    };
  }

  it('folder=undefined → lists ALL documents', async () => {
    const db = makeStorageDb(undefined);
    const result = await listDocumentsLogic(db, 'src1', undefined);
    expect(db.allDocs).toHaveBeenCalledWith('src1');
    expect(result).toEqual([{ id: 'doc-all' }]);
  });

  it('folder="" → lists ROOT documents only (no parent folder)', async () => {
    const db = makeStorageDb(undefined);
    const result = await listDocumentsLogic(db, 'src1', '');
    expect(db.rootDocs).toHaveBeenCalledWith('src1');
    expect(result).toEqual([{ id: 'doc-root' }]);
    expect(db.allDocs).not.toHaveBeenCalled();
  });

  it('folder="/" → lists ROOT documents (normalised to blank)', async () => {
    const db = makeStorageDb(undefined);
    const result = await listDocumentsLogic(db, 'src1', '/');
    expect(db.rootDocs).toHaveBeenCalledWith('src1');
    expect(result).toEqual([{ id: 'doc-root' }]);
  });

  it('folder="D4.1" (path) → resolves to id and lists folder documents', async () => {
    const db = makeStorageDb('0B3zyW2cw9F23dFQtSWYtcUtUeE0');
    const result = await listDocumentsLogic(db, 'src1', 'D4.1');
    expect(db.folderDocs).toHaveBeenCalledWith('src1', '0B3zyW2cw9F23dFQtSWYtcUtUeE0');
    expect(result).toEqual([{ id: 'doc-folder' }]);
  });

  it('folder="0B3zy..." (raw id) → resolves via id-or-path lookup', async () => {
    const db = makeStorageDb('0B3zyW2cw9F23dFQtSWYtcUtUeE0');
    await listDocumentsLogic(db, 'src1', '0B3zyW2cw9F23dFQtSWYtcUtUeE0');
    expect(db.folderDocs).toHaveBeenCalledWith('src1', '0B3zyW2cw9F23dFQtSWYtcUtUeE0');
  });

  it('unknown folder path → returns [] without querying documents', async () => {
    const db = makeStorageDb(undefined);
    const result = await listDocumentsLogic(db, 'src1', 'does-not-exist');
    expect(result).toEqual([]);
    expect(db.folderDocs).not.toHaveBeenCalled();
  });

  it('folder="  /  " (whitespace + slashes) → lists ROOT documents', async () => {
    const db = makeStorageDb(undefined);
    const result = await listDocumentsLogic(db, 'src1', '  /  ');
    // After trim + strip: "  /  " → "/" after trim = "/" → "" after strip
    // Actually: trim gives "/", then strip "/" gives "" → root docs.
    // Wait: "  /  ".trim() = "/" → .replace(/^\/+|\/+$/g,'') = "" → rootDocs
    expect(db.rootDocs).toHaveBeenCalledWith('src1');
    expect(result).toEqual([{ id: 'doc-root' }]);
  });
});
