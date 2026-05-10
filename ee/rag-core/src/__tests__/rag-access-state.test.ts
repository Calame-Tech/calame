// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import {
  buildDocumentScope,
  countSelected,
  deriveFolderCheckState,
  type FolderMap,
  type FolderNode,
} from '../rag-access-state.js';
import type { RagDocument, RagFolder } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFolder(overrides?: Partial<RagFolder>): RagFolder {
  return {
    id: 'folder-1',
    sourceId: 'src-1',
    parentId: null,
    path: 'docs/faq',
    name: 'faq',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDocument(overrides?: Partial<RagDocument>): RagDocument {
  return {
    id: 'doc-1',
    sourceId: 'src-1',
    folderId: 'folder-1',
    path: 'docs/faq/intro.pdf',
    name: 'intro.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    hash: 'abc123',
    etag: null,
    lastIndexedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function makeFolderNode(overrides?: Partial<FolderNode>): FolderNode {
  return {
    folder: makeFolder(),
    loaded: true,
    loading: false,
    loadError: null,
    expanded: false,
    mode: 'auto-include',
    checkedDocIds: new Set(),
    childFolderIds: [],
    documents: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveFolderCheckState
// ---------------------------------------------------------------------------

describe('deriveFolderCheckState', () => {
  it('returns unchecked when source is not included', () => {
    const folderMap: FolderMap = {
      'folder-1': makeFolderNode({ mode: 'auto-include' }),
    };
    expect(deriveFolderCheckState('folder-1', folderMap, false)).toBe('unchecked');
  });

  it('returns checked when mode is auto-include and source is included', () => {
    const folderMap: FolderMap = {
      'folder-1': makeFolderNode({ mode: 'auto-include' }),
    };
    expect(deriveFolderCheckState('folder-1', folderMap, true)).toBe('checked');
  });

  it('returns unchecked for empty strict folder', () => {
    const folderMap: FolderMap = {
      'folder-1': makeFolderNode({
        mode: 'strict',
        documents: [],
        childFolderIds: [],
        checkedDocIds: new Set(),
      }),
    };
    expect(deriveFolderCheckState('folder-1', folderMap, true)).toBe('unchecked');
  });

  it('returns partial when only some documents are checked', () => {
    const docs = [
      makeDocument({ id: 'doc-1', path: 'docs/faq/intro.pdf' }),
      makeDocument({ id: 'doc-2', path: 'docs/faq/outro.pdf' }),
    ];
    const folderMap: FolderMap = {
      'folder-1': makeFolderNode({
        mode: 'strict',
        documents: docs,
        checkedDocIds: new Set(['doc-1']),
      }),
    };
    expect(deriveFolderCheckState('folder-1', folderMap, true)).toBe('partial');
  });

  it('returns checked when all documents are checked in strict mode', () => {
    const docs = [
      makeDocument({ id: 'doc-1', path: 'docs/faq/intro.pdf' }),
      makeDocument({ id: 'doc-2', path: 'docs/faq/outro.pdf' }),
    ];
    const folderMap: FolderMap = {
      'folder-1': makeFolderNode({
        mode: 'strict',
        documents: docs,
        checkedDocIds: new Set(['doc-1', 'doc-2']),
      }),
    };
    expect(deriveFolderCheckState('folder-1', folderMap, true)).toBe('checked');
  });

  it('returns partial when child folder is partial', () => {
    const folderMap: FolderMap = {
      'parent': makeFolderNode({
        folder: makeFolder({ id: 'parent', path: 'docs' }),
        mode: 'strict',
        childFolderIds: ['child'],
        documents: [],
        checkedDocIds: new Set(),
      }),
      'child': makeFolderNode({
        folder: makeFolder({ id: 'child', path: 'docs/faq', parentId: 'parent' }),
        mode: 'strict',
        documents: [makeDocument({ id: 'doc-1' }), makeDocument({ id: 'doc-2' })],
        checkedDocIds: new Set(['doc-1']), // partial
      }),
    };
    expect(deriveFolderCheckState('parent', folderMap, true)).toBe('partial');
  });

  it('returns unchecked for unknown folderId', () => {
    expect(deriveFolderCheckState('nonexistent', {}, true)).toBe('unchecked');
  });
});

// ---------------------------------------------------------------------------
// buildDocumentScope
// ---------------------------------------------------------------------------

describe('buildDocumentScope', () => {
  it('returns empty scope when source is not included', () => {
    const scope = buildDocumentScope(false, [], [], {});
    expect(scope).toEqual({
      kind: 'document',
      mode: 'allowAll',
      allowedFolders: [],
      allowedDocuments: [],
    });
  });

  it('builds allowedFolders for auto-include folders', () => {
    const folderMap: FolderMap = {
      'folder-1': makeFolderNode({
        folder: makeFolder({ id: 'folder-1', path: 'docs/faq' }),
        mode: 'auto-include',
      }),
    };
    const scope = buildDocumentScope(true, ['folder-1'], [], folderMap);
    expect(scope.kind).toBe('document');
    expect(scope.allowedFolders).toContain('docs/faq');
    expect(scope.allowedDocuments).toHaveLength(0);
    expect(scope.mode).toBe('allowAll');
  });

  it('builds allowedDocuments for strict folders', () => {
    const doc1 = makeDocument({ id: 'doc-1', path: 'docs/faq/intro.pdf' });
    const doc2 = makeDocument({ id: 'doc-2', path: 'docs/faq/outro.pdf' });
    const folderMap: FolderMap = {
      'folder-1': makeFolderNode({
        folder: makeFolder({ id: 'folder-1', path: 'docs/faq' }),
        mode: 'strict',
        documents: [doc1, doc2],
        checkedDocIds: new Set(['doc-1']),
      }),
    };
    const scope = buildDocumentScope(true, ['folder-1'], [], folderMap);
    expect(scope.allowedFolders).toHaveLength(0);
    expect(scope.allowedDocuments).toContain('docs/faq/intro.pdf');
    expect(scope.allowedDocuments).not.toContain('docs/faq/outro.pdf');
    expect(scope.mode).toBe('allowList');
  });

  it('does not recurse into children of auto-include folders', () => {
    const folderMap: FolderMap = {
      'parent': makeFolderNode({
        folder: makeFolder({ id: 'parent', path: 'docs' }),
        mode: 'auto-include',
        childFolderIds: ['child'],
      }),
      'child': makeFolderNode({
        folder: makeFolder({ id: 'child', path: 'docs/faq', parentId: 'parent' }),
        mode: 'strict',
        documents: [makeDocument({ id: 'doc-1' })],
        checkedDocIds: new Set(['doc-1']),
      }),
    };
    const scope = buildDocumentScope(true, ['parent'], [], folderMap);
    // Only parent is in allowedFolders, child docs NOT in allowedDocuments
    expect(scope.allowedFolders).toEqual(['docs']);
    expect(scope.allowedDocuments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// countSelected
// ---------------------------------------------------------------------------

describe('countSelected', () => {
  it('returns zeroes when not included', () => {
    expect(countSelected(false, [], [], {})).toEqual({ folders: 0, documents: 0 });
  });

  it('counts auto-include folders', () => {
    const folderMap: FolderMap = {
      'f1': makeFolderNode({ mode: 'auto-include' }),
      'f2': makeFolderNode({
        folder: makeFolder({ id: 'f2', path: 'docs/guides' }),
        mode: 'auto-include',
      }),
    };
    const counts = countSelected(true, ['f1', 'f2'], [], folderMap);
    expect(counts.folders).toBe(2);
    expect(counts.documents).toBe(0);
  });

  it('counts checked documents in strict mode', () => {
    const folderMap: FolderMap = {
      'f1': makeFolderNode({
        mode: 'strict',
        documents: [makeDocument({ id: 'd1' }), makeDocument({ id: 'd2' })],
        checkedDocIds: new Set(['d1', 'd2']),
      }),
    };
    const counts = countSelected(true, ['f1'], [], folderMap);
    expect(counts.folders).toBe(0);
    expect(counts.documents).toBe(2);
  });

  it('counts root documents when source is included', () => {
    const rootDocs = [makeDocument({ id: 'root-doc', folderId: null })];
    const counts = countSelected(true, [], rootDocs, {});
    expect(counts.documents).toBe(1);
  });
});
