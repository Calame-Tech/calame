// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import {
  applyLoadedChildren,
  applyToggleDocument,
  applyToggleFolder,
  buildDocumentScope,
  countSelected,
  deriveFolderCheckState,
  makeUnloadedFolderNode,
  preserveUnloadedScope,
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
    tenantId: 'default',
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
    tenantId: 'default',
    lastIndexedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ingestError: null,
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
      parent: makeFolderNode({
        folder: makeFolder({ id: 'parent', path: 'docs' }),
        mode: 'strict',
        childFolderIds: ['child'],
        documents: [],
        checkedDocIds: new Set(),
      }),
      child: makeFolderNode({
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

  it('returns allowAll when source is included but no folders or documents are picked', () => {
    const scope = buildDocumentScope(true, [], [], {});
    expect(scope).toEqual({
      kind: 'document',
      mode: 'allowAll',
      allowedFolders: [],
      allowedDocuments: [],
    });
  });

  it('includes piiMaskingMode: off in the scope when specified', () => {
    const scope = buildDocumentScope(true, [], [], {}, 'off');
    expect(scope.piiMaskingMode).toBe('off');
  });

  it('omits piiMaskingMode when value is inherit', () => {
    const scope = buildDocumentScope(true, [], [], {}, 'inherit');
    expect(scope.piiMaskingMode).toBeUndefined();
  });

  it('builds allowedFolders for auto-include folders', () => {
    const folderMap: FolderMap = {
      'folder-1': makeFolderNode({
        folder: makeFolder({ id: 'folder-1', path: 'docs/faq' }),
        mode: 'auto-include',
      }),
      'folder-2': makeFolderNode({
        folder: makeFolder({ id: 'folder-2', path: 'docs/other' }),
        mode: 'strict',
      }),
    };
    const scope = buildDocumentScope(true, ['folder-1', 'folder-2'], [], folderMap);
    expect(scope.kind).toBe('document');
    expect(scope.allowedFolders).toContain('docs/faq');
    expect(scope.allowedDocuments).toHaveLength(0);
    // Folders were picked → allowList (restricted to those folders)
    expect(scope.mode).toBe('allowList');
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
      parent: makeFolderNode({
        folder: makeFolder({ id: 'parent', path: 'docs' }),
        mode: 'auto-include',
        childFolderIds: ['child'],
      }),
      child: makeFolderNode({
        folder: makeFolder({ id: 'child', path: 'docs/faq', parentId: 'parent' }),
        mode: 'strict',
        documents: [makeDocument({ id: 'doc-1' })],
        checkedDocIds: new Set(['doc-1']),
      }),
      other: makeFolderNode({
        folder: makeFolder({ id: 'other', path: 'other' }),
        mode: 'strict',
      }),
    };
    const scope = buildDocumentScope(true, ['parent', 'other'], [], folderMap);
    // Only parent is in allowedFolders, child docs NOT in allowedDocuments
    expect(scope.allowedFolders).toEqual(['docs']);
    expect(scope.allowedDocuments).toHaveLength(0);
  });

  it('returns allowAll when every root folder is fully included (whole source checked)', () => {
    const folderMap: FolderMap = {
      a: makeFolderNode({ folder: makeFolder({ id: 'a', path: 'a' }), mode: 'auto-include' }),
      b: makeFolderNode({ folder: makeFolder({ id: 'b', path: 'b' }), mode: 'auto-include' }),
    };
    const rootDocs = [makeDocument({ id: 'r1', folderId: null, path: 'r1.md' })];
    const scope = buildDocumentScope(true, ['a', 'b'], rootDocs, folderMap, 'off');
    // Not a frozen list of today's folders/files: content added later stays covered.
    expect(scope).toEqual({
      kind: 'document',
      mode: 'allowAll',
      allowedFolders: [],
      allowedDocuments: [],
      piiMaskingMode: 'off',
    });
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
      f1: makeFolderNode({ mode: 'auto-include' }),
      f2: makeFolderNode({
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
      f1: makeFolderNode({
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

// ---------------------------------------------------------------------------
// applyToggleFolder
// ---------------------------------------------------------------------------

describe('applyToggleFolder', () => {
  it('switches to auto-include and clears checkedDocIds when nextCheck=checked', () => {
    const folderMap: FolderMap = {
      f1: makeFolderNode({
        mode: 'strict',
        documents: [makeDocument({ id: 'd1' }), makeDocument({ id: 'd2' })],
        checkedDocIds: new Set(['d1']),
      }),
    };
    const next = applyToggleFolder('f1', 'checked', folderMap);
    expect(next['f1']!.mode).toBe('auto-include');
    expect(next['f1']!.checkedDocIds.size).toBe(0);
    // Other fields are preserved
    expect(next['f1']!.documents).toHaveLength(2);
  });

  it('switches to strict and clears checkedDocIds when nextCheck=unchecked', () => {
    const folderMap: FolderMap = {
      f1: makeFolderNode({
        mode: 'auto-include',
        documents: [makeDocument({ id: 'd1' })],
        checkedDocIds: new Set(),
      }),
    };
    const next = applyToggleFolder('f1', 'unchecked', folderMap);
    expect(next['f1']!.mode).toBe('strict');
    expect(next['f1']!.checkedDocIds.size).toBe(0);
  });

  it('treats partial check state as unchecked (folds to strict)', () => {
    // The component never emits `partial` as a direct user intent — but the
    // helper must be deterministic on every possible CheckState value.
    const folderMap: FolderMap = {
      f1: makeFolderNode({ mode: 'auto-include' }),
    };
    const next = applyToggleFolder('f1', 'partial', folderMap);
    expect(next['f1']!.mode).toBe('strict');
  });

  it('returns the same folderMap reference for an unknown folderId', () => {
    const folderMap: FolderMap = { f1: makeFolderNode() };
    const next = applyToggleFolder('missing', 'checked', folderMap);
    expect(next).toBe(folderMap);
  });

  it('does not mutate the input map', () => {
    const node = makeFolderNode({ mode: 'strict', checkedDocIds: new Set(['d1']) });
    const folderMap: FolderMap = { f1: node };
    applyToggleFolder('f1', 'checked', folderMap);
    // Original node must still carry the pre-toggle state.
    expect(folderMap['f1']!.mode).toBe('strict');
    expect(folderMap['f1']!.checkedDocIds.has('d1')).toBe(true);
  });

  // Tree: root ─┬─ a (doc a1) ─ a-sub (doc s1)
  //             └─ b (doc b1)   + doc r1 directly in root
  function tree(): FolderMap {
    const docs = (folderId: string, ids: string[]) =>
      ids.map((id) => makeDocument({ id, folderId, path: `${folderId}/${id}`, name: id }));
    return {
      root: makeFolderNode({
        folder: makeFolder({ id: 'root', parentId: null, path: 'root', name: 'root' }),
        mode: 'strict',
        childFolderIds: ['a', 'b'],
        documents: docs('root', ['r1']),
      }),
      a: makeFolderNode({
        folder: makeFolder({ id: 'a', parentId: 'root', path: 'root/a', name: 'a' }),
        mode: 'strict',
        childFolderIds: ['a-sub'],
        documents: docs('a', ['a1']),
      }),
      'a-sub': makeFolderNode({
        folder: makeFolder({ id: 'a-sub', parentId: 'a', path: 'root/a/sub', name: 'sub' }),
        mode: 'strict',
        documents: docs('a-sub', ['s1']),
      }),
      b: makeFolderNode({
        folder: makeFolder({ id: 'b', parentId: 'root', path: 'root/b', name: 'b' }),
        mode: 'strict',
        documents: docs('b', ['b1']),
      }),
    };
  }
  const stateOf = (id: string, map: FolderMap) => deriveFolderCheckState(id, map, true);

  it('checking a folder selects its whole content, sub-folders and files included', () => {
    const next = applyToggleFolder('root', 'checked', tree());
    for (const id of ['root', 'a', 'a-sub', 'b']) expect(stateOf(id, next)).toBe('checked');
    // 'other' is an unchecked sibling root folder, so the scope stays an allowlist.
    expect(buildDocumentScope(true, ['root', 'other'], [], next).allowedFolders).toEqual(['root']);
  });

  it('unchecking a folder deselects everything below it, even a previously checked child', () => {
    const checkedChild = applyToggleFolder('a-sub', 'checked', tree());
    expect(stateOf('root', checkedChild)).toBe('partial');
    const next = applyToggleFolder('root', 'unchecked', checkedChild);
    for (const id of ['root', 'a', 'a-sub', 'b']) expect(stateOf(id, next)).toBe('unchecked');
    const scope = buildDocumentScope(true, ['root'], [], next);
    expect(scope.allowedFolders).toEqual([]);
    expect(scope.allowedDocuments).toEqual([]);
  });

  it('unchecking a sub-folder of a checked folder leaves the parent visibly partial', () => {
    const next = applyToggleFolder('a', 'unchecked', applyToggleFolder('root', 'checked', tree()));
    expect(stateOf('a', next)).toBe('unchecked');
    expect(stateOf('a-sub', next)).toBe('unchecked');
    expect(stateOf('b', next)).toBe('checked');
    expect(stateOf('root', next)).toBe('partial');
    const scope = buildDocumentScope(true, ['root'], [], next);
    expect(scope.allowedFolders).toEqual(['root/b']);
    expect(scope.allowedDocuments).toEqual(['root/r1']);
  });

  it('unchecking a file inside a checked folder keeps the rest selected', () => {
    const { folderMap: next } = applyToggleDocument(
      'a-sub',
      's1',
      applyToggleFolder('root', 'checked', tree()),
    );
    expect(stateOf('a-sub', next)).toBe('unchecked');
    expect(stateOf('b', next)).toBe('checked');
    expect(stateOf('root', next)).toBe('partial');
    const scope = buildDocumentScope(true, ['root'], [], next);
    expect(scope.allowedFolders).toEqual(['root/b']);
    expect([...scope.allowedDocuments].sort()).toEqual(['a/a1', 'root/r1']);
  });
});

// ---------------------------------------------------------------------------
// applyToggleDocument
// ---------------------------------------------------------------------------

describe('applyToggleDocument', () => {
  it('bascule auto-include → strict and pre-checks all OTHER docs (with toast)', () => {
    const docs = [
      makeDocument({ id: 'd1', path: 'docs/faq/a.md' }),
      makeDocument({ id: 'd2', path: 'docs/faq/b.md' }),
      makeDocument({ id: 'd3', path: 'docs/faq/c.md' }),
    ];
    const folderMap: FolderMap = {
      f1: makeFolderNode({
        folder: makeFolder({ id: 'f1', name: 'faq' }),
        mode: 'auto-include',
        documents: docs,
        checkedDocIds: new Set(),
      }),
    };
    const result = applyToggleDocument('f1', 'd2', folderMap);
    expect(result.folderMap['f1']!.mode).toBe('strict');
    // d2 was the one unchecked → not in the allowlist; d1 and d3 stay.
    expect(result.folderMap['f1']!.checkedDocIds.has('d1')).toBe(true);
    expect(result.folderMap['f1']!.checkedDocIds.has('d2')).toBe(false);
    expect(result.folderMap['f1']!.checkedDocIds.has('d3')).toBe(true);
    // Toast surfaces the bascule + the folder name.
    expect(result.toastMessage).toBeTruthy();
    expect(result.toastMessage).toContain('faq');
    expect(result.toastMessage).toContain('strict');
  });

  it('bascule on a single-doc auto-include folder produces an empty strict allowlist', () => {
    const folderMap: FolderMap = {
      f1: makeFolderNode({
        mode: 'auto-include',
        documents: [makeDocument({ id: 'only-doc' })],
        checkedDocIds: new Set(),
      }),
    };
    const result = applyToggleDocument('f1', 'only-doc', folderMap);
    expect(result.folderMap['f1']!.mode).toBe('strict');
    expect(result.folderMap['f1']!.checkedDocIds.size).toBe(0);
    expect(result.toastMessage).toBeTruthy();
  });

  it('in strict mode, adds a doc to the allowlist (no mode change, no toast)', () => {
    const folderMap: FolderMap = {
      f1: makeFolderNode({
        mode: 'strict',
        documents: [makeDocument({ id: 'd1' }), makeDocument({ id: 'd2' })],
        checkedDocIds: new Set(['d1']),
      }),
    };
    const result = applyToggleDocument('f1', 'd2', folderMap);
    expect(result.folderMap['f1']!.mode).toBe('strict');
    expect(result.folderMap['f1']!.checkedDocIds.has('d1')).toBe(true);
    expect(result.folderMap['f1']!.checkedDocIds.has('d2')).toBe(true);
    expect(result.toastMessage).toBeNull();
  });

  it('in strict mode, removes a doc from the allowlist (no mode change, no toast)', () => {
    const folderMap: FolderMap = {
      f1: makeFolderNode({
        mode: 'strict',
        documents: [makeDocument({ id: 'd1' }), makeDocument({ id: 'd2' })],
        checkedDocIds: new Set(['d1', 'd2']),
      }),
    };
    const result = applyToggleDocument('f1', 'd1', folderMap);
    expect(result.folderMap['f1']!.checkedDocIds.has('d1')).toBe(false);
    expect(result.folderMap['f1']!.checkedDocIds.has('d2')).toBe(true);
    expect(result.toastMessage).toBeNull();
  });

  it('returns the same folderMap and null toast for an unknown folderId', () => {
    const folderMap: FolderMap = { f1: makeFolderNode() };
    const result = applyToggleDocument('missing', 'd1', folderMap);
    expect(result.folderMap).toBe(folderMap);
    expect(result.toastMessage).toBeNull();
  });

  it('does not mutate the input map', () => {
    const folderMap: FolderMap = {
      f1: makeFolderNode({
        mode: 'auto-include',
        documents: [makeDocument({ id: 'd1' }), makeDocument({ id: 'd2' })],
      }),
    };
    applyToggleDocument('f1', 'd1', folderMap);
    // Original folder remains untouched.
    expect(folderMap['f1']!.mode).toBe('auto-include');
    expect(folderMap['f1']!.checkedDocIds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Descendants loaded on demand (tester feedback #10)
// ---------------------------------------------------------------------------

describe('selection of descendants loaded on demand', () => {
  // Tree on the server: root ─ a ─ sub (doc s1), root also holds doc r1.
  // Only `root` is known until the user expands folders one by one.
  const folder = (id: string, parentId: string | null, path: string) =>
    makeFolder({ id, parentId, path, name: id });
  const doc = (id: string, folderId: string, path: string) =>
    makeDocument({ id, folderId, path, name: id });
  const ROOT = folder('root', null, 'root');
  const A = folder('a', 'root', 'root/a');
  const SUB = folder('sub', 'a', 'root/a/sub');
  const R1 = doc('r1', 'root', 'root/r1.md');
  const S1 = doc('s1', 'sub', 'root/a/sub/s1.md');

  const initial = (saved: { folders: string[]; documents: string[] }): FolderMap => ({
    root: makeUnloadedFolderNode(ROOT, saved),
  });
  const expandAll = (map: FolderMap): FolderMap => {
    let next = applyLoadedChildren('root', [A], [R1], map);
    next = applyLoadedChildren('a', [SUB], [], next);
    return applyLoadedChildren('sub', [], [S1], next);
  };
  const stateOf = (id: string, map: FolderMap) => deriveFolderCheckState(id, map, true);
  const scopeOf = (map: FolderMap) => buildDocumentScope(true, ['root'], [], map);

  it('shows a saved nested selection as partial before its folders are expanded', () => {
    const map = initial({ folders: ['root/a/sub'], documents: [] });
    expect(map['root']!.mode).toBe('strict');
    expect(stateOf('root', map)).toBe('partial');
  });

  it('keeps a saved nested selection when saving without expanding', () => {
    const map = initial({ folders: ['root/a/sub'], documents: ['root/a/x.md'] });
    const scope = scopeOf(map);
    expect(scope.mode).toBe('allowList');
    expect(scope.allowedFolders).toEqual(['root/a/sub']);
    expect(scope.allowedDocuments).toEqual(['root/a/x.md']);
    expect(countSelected(true, ['root'], [], map)).toEqual({ folders: 1, documents: 1 });
  });

  it('hands the saved selection down as descendants load', () => {
    const map = expandAll(initial({ folders: ['root/a/sub'], documents: ['root/r1.md'] }));
    expect(map['sub']!.mode).toBe('auto-include');
    expect(map['root']!.checkedDocIds).toEqual(new Set(['r1']));
    expect(stateOf('sub', map)).toBe('checked');
    expect(stateOf('a', map)).toBe('checked');
    expect(stateOf('root', map)).toBe('checked');
    const scope = scopeOf(map);
    expect(scope.allowedFolders).toEqual(['root/a/sub']);
    expect(scope.allowedDocuments).toEqual(['root/r1.md']);
  });

  it('checking a folder before expanding covers every descendant loaded later', () => {
    const map = expandAll(
      applyToggleFolder('root', 'checked', initial({ folders: [], documents: [] })),
    );
    for (const id of ['root', 'a', 'sub']) expect(stateOf(id, map)).toBe('checked');
    // 'other' is an unchecked sibling root folder, so the scope stays an allowlist.
    const scope = buildDocumentScope(true, ['root', 'other'], [], map);
    expect(scope.allowedFolders).toEqual(['root']);
    expect(scope.allowedDocuments).toEqual([]);
  });

  it('unchecking a folder before expanding is not undone by the lazy load', () => {
    const saved = { folders: ['root/a/sub'], documents: ['root/r1.md'] };
    const map = expandAll(applyToggleFolder('root', 'unchecked', initial(saved)));
    for (const id of ['root', 'a', 'sub']) expect(stateOf(id, map)).toBe('unchecked');
    expect(map['root']!.checkedDocIds.size).toBe(0);
    const scope = scopeOf(map);
    expect(scope.allowedFolders).toEqual([]);
    expect(scope.allowedDocuments).toEqual([]);
  });

  it('unchecking a partially selected unloaded sub-folder drops its saved selection', () => {
    let map = applyLoadedChildren(
      'root',
      [A],
      [R1],
      initial({ folders: ['root/a/sub'], documents: [] }),
    );
    expect(stateOf('a', map)).toBe('partial');
    map = applyToggleFolder('a', 'unchecked', map);
    expect(stateOf('a', map)).toBe('unchecked');
    expect(scopeOf(map).allowedFolders).toEqual([]);
  });

  it('selecting every sub-folder one by one selects the parent', () => {
    const B = folder('b', 'root', 'root/b');
    let map = applyLoadedChildren('root', [A, B], [], initial({ folders: [], documents: [] }));
    map = applyToggleFolder('a', 'checked', map);
    expect(stateOf('root', map)).toBe('partial');
    map = applyToggleFolder('b', 'checked', map);
    expect(stateOf('root', map)).toBe('checked');
    expect(scopeOf(map).allowedFolders).toEqual(['root/a', 'root/b']);
    // Descendants loaded afterwards stay covered.
    map = applyLoadedChildren('a', [SUB], [], map);
    expect(stateOf('sub', map)).toBe('checked');
  });
});

describe('preserveUnloadedScope', () => {
  it('keeps a saved allowlist and applies the current profile-wide flags', () => {
    const saved = {
      kind: 'document' as const,
      mode: 'allowList' as const,
      allowedFolders: ['root/a'],
      allowedDocuments: ['root/r1.md'],
      directFetchDisabled: true,
    };
    expect(preserveUnloadedScope(saved, 'off', false)).toEqual({
      kind: 'document',
      mode: 'allowList',
      allowedFolders: ['root/a'],
      allowedDocuments: ['root/r1.md'],
      piiMaskingMode: 'off',
    });
  });
});
