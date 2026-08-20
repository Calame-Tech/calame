import { describe, it, expect } from 'vitest';
import { normaliseFolderArg, resolveFolderId, type FolderResolverDb } from '../folder-helpers.js';

describe('normaliseFolderArg', () => {
  it('undefined stays undefined (no folder constraint)', () => {
    expect(normaliseFolderArg(undefined)).toBeUndefined();
  });

  it('empty string normalises to root ("")', () => {
    expect(normaliseFolderArg('')).toBe('');
  });

  it('whitespace-only normalises to root', () => {
    expect(normaliseFolderArg('   ')).toBe('');
  });

  it('a single slash normalises to root', () => {
    expect(normaliseFolderArg('/')).toBe('');
  });

  it('leading/trailing slashes are stripped', () => {
    expect(normaliseFolderArg('/docs/faq/')).toBe('docs/faq');
  });

  // Regression: an LLM tool-caller's most natural guess for "the root",
  // once "" and "/" are ruled out, is "." — real-world testing found this
  // silently returned an empty result indistinguishable from "root really
  // is empty" instead of being recognized as root.
  it('a bare "." normalises to root', () => {
    expect(normaliseFolderArg('.')).toBe('');
  });

  it('"." surrounded by whitespace still normalises to root', () => {
    expect(normaliseFolderArg('  .  ')).toBe('');
  });

  it('does NOT special-case "./something" — only the bare "." is root', () => {
    expect(normaliseFolderArg('./docs')).toBe('./docs');
  });

  it('a real path is trimmed but otherwise passed through unchanged', () => {
    expect(normaliseFolderArg('  docs/faq  ')).toBe('docs/faq');
  });

  it('a path-traversal attempt is passed through as an opaque, unresolvable string — not specially interpreted', () => {
    expect(normaliseFolderArg('../')).toBe('..');
    expect(normaliseFolderArg('..')).toBe('..');
  });
});

describe('resolveFolderId', () => {
  function makeFakeDb(
    rows: Array<{ id: string; source_id: string; path: string }>,
  ): FolderResolverDb {
    return {
      prepare: (_sql: string) => ({
        get: (...params: unknown[]) => {
          const [sourceId, byId, byPath] = params as [string, string, string];
          const match = rows.find(
            (r) => r.source_id === sourceId && (r.id === byId || r.path === byPath),
          );
          return match ? { id: match.id } : undefined;
        },
      }),
    };
  }

  it('resolves by exact path match', () => {
    const db = makeFakeDb([{ id: 'folder-1', source_id: 'src-1', path: 'docs/faq' }]);
    expect(resolveFolderId(db, 'src-1', 'docs/faq')).toBe('folder-1');
  });

  it('resolves by exact id match', () => {
    const db = makeFakeDb([{ id: 'folder-1', source_id: 'src-1', path: 'docs/faq' }]);
    expect(resolveFolderId(db, 'src-1', 'folder-1')).toBe('folder-1');
  });

  it('returns null for a folder that does not exist in this source', () => {
    const db = makeFakeDb([{ id: 'folder-1', source_id: 'src-1', path: 'docs/faq' }]);
    expect(resolveFolderId(db, 'src-1', 'docs/nonexistent')).toBeNull();
  });

  it('returns null for a folder that exists but in a DIFFERENT source (no cross-source leakage)', () => {
    const db = makeFakeDb([{ id: 'folder-1', source_id: 'src-other', path: 'docs/faq' }]);
    expect(resolveFolderId(db, 'src-1', 'docs/faq')).toBeNull();
  });
});
