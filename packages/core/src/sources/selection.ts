import type { ScopeSelection } from './types.js';

export function narrowSelection<K extends ScopeSelection['kind']>(
  sel: ScopeSelection,
  kind: K,
): Extract<ScopeSelection, { kind: K }> | null {
  if (sel.kind === kind) {
    return sel as Extract<ScopeSelection, { kind: K }>;
  }
  return null;
}

export function isRelationalSelection(
  sel: ScopeSelection,
): sel is Extract<ScopeSelection, { kind: 'relational' }> {
  return sel.kind === 'relational';
}

export function isDocumentSelection(
  sel: ScopeSelection,
): sel is Extract<ScopeSelection, { kind: 'document' }> {
  return sel.kind === 'document';
}

export function emptyRelationalSelection(): Extract<ScopeSelection, { kind: 'relational' }> {
  return { kind: 'relational', selectedTables: {} };
}

export function emptyDocumentSelection(): Extract<ScopeSelection, { kind: 'document' }> {
  return { kind: 'document', mode: 'allowList', allowedFolders: [], allowedDocuments: [] };
}
