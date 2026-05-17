// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Pure state-management helpers for RagAccessSelector.
 *
 * Extracted into a separate module so they can be unit-tested without a
 * browser / React / JSX environment.
 */

import type { ScopeSelection } from '@calame/core';
import type { RagDocument, RagFolder } from './types.js';

// ---------------------------------------------------------------------------
// Shared types (re-exported so the component can import from here)
// ---------------------------------------------------------------------------

export type CheckState = 'checked' | 'partial' | 'unchecked';
export type FolderMode = 'auto-include' | 'strict';

/**
 * Runtime node representing a folder within a source.
 * All fields are plain data — no React state primitives.
 */
export interface FolderNode {
  folder: RagFolder;
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  expanded: boolean;
  mode: FolderMode;
  /** IDs of documents checked individually (only meaningful in strict mode). */
  checkedDocIds: Set<string>;
  childFolderIds: string[];
  documents: RagDocument[];
}

/** Flat map of all folder nodes, keyed by folder.id. */
export type FolderMap = Record<string, FolderNode>;

// ---------------------------------------------------------------------------
// Derive check state (recursive)
// ---------------------------------------------------------------------------

/**
 * Derive the tri-state checkbox value for a folder node.
 *
 * - If the source is not included → always `unchecked`
 * - If mode is `auto-include` → `checked` (the whole folder is allowed)
 * - If mode is `strict` → computed from individual doc selections + child folder states
 */
export function deriveFolderCheckState(
  folderId: string,
  folderMap: FolderMap,
  sourceIncluded: boolean,
): CheckState {
  const node = folderMap[folderId];
  if (!node) return 'unchecked';
  if (!sourceIncluded) return 'unchecked';

  if (node.mode === 'auto-include') {
    return 'checked';
  }

  // strict mode
  const docCount = node.documents.length;
  const checkedDocs = node.checkedDocIds.size;

  const childStates = node.childFolderIds.map((cid) =>
    deriveFolderCheckState(cid, folderMap, sourceIncluded),
  );
  const hasCheckedChild = childStates.some((s) => s === 'checked' || s === 'partial');
  const noChildren = node.childFolderIds.length === 0;
  const allChildrenChecked = !noChildren && childStates.every((s) => s === 'checked');
  const allDocsChecked = docCount > 0 && docCount === checkedDocs;
  const noDocsSelected = checkedDocs === 0;

  // Empty folder
  if (docCount === 0 && noChildren) return 'unchecked';

  // All content selected
  if ((noChildren || allChildrenChecked) && (docCount === 0 || allDocsChecked)) {
    // Only return checked if there's at least something selected
    if (!noChildren || allDocsChecked) return 'checked';
  }

  // Partial: something but not all selected
  if (checkedDocs > 0 || hasCheckedChild) return 'partial';

  // Nothing selected
  if (noDocsSelected && !hasCheckedChild) return 'unchecked';
  return 'unchecked';
}

// ---------------------------------------------------------------------------
// Build ScopeSelection payload from current tree state
// ---------------------------------------------------------------------------

/**
 * Build a `ScopeSelection { kind: 'document' }` from the current tree state for
 * a given source. Called at save time to produce the POST body.
 */
export function buildDocumentScope(
  sourceIncluded: boolean,
  rootFolderIds: string[],
  rootDocuments: RagDocument[],
  folderMap: FolderMap,
  piiMaskingMode?: 'inherit' | 'off',
): Extract<ScopeSelection, { kind: 'document' }> {
  if (!sourceIncluded) {
    return { kind: 'document', mode: 'allowAll', allowedFolders: [], allowedDocuments: [] };
  }

  const allowedFolders: string[] = [];
  const allowedDocuments: string[] = [];

  const walkFolder = (folderId: string): void => {
    const node = folderMap[folderId];
    if (!node) return;

    if (node.mode === 'auto-include') {
      allowedFolders.push(node.folder.path);
      // Do not recurse — folder inclusion is recursive server-side
    } else {
      // strict: collect individually checked docs
      for (const doc of node.documents) {
        if (node.checkedDocIds.has(doc.id)) {
          allowedDocuments.push(doc.path);
        }
      }
      // Recurse into child folders (each has its own mode)
      for (const cid of node.childFolderIds) {
        walkFolder(cid);
      }
    }
  };

  for (const fid of rootFolderIds) {
    walkFolder(fid);
  }
  // Root-level documents are always included when source is included
  for (const doc of rootDocuments) {
    allowedDocuments.push(doc.path);
  }

  const mode: 'allowAll' | 'allowList' =
    allowedFolders.length === 0 && allowedDocuments.length === 0
      ? 'allowAll'
      : 'allowList';
  return {
    kind: 'document',
    mode,
    allowedFolders,
    allowedDocuments,
    ...(piiMaskingMode === 'off' ? { piiMaskingMode: 'off' } : {}),
  };
}

// ---------------------------------------------------------------------------
// Toggle helpers
//
// Pure state transitions extracted from RagAccessSelector.tsx so the bascule
// logic (auto-include ↔ strict) can be unit-tested without React/JSX. The
// component is a thin wrapper that calls these helpers and threads the result
// into setState + the toast push.
// ---------------------------------------------------------------------------

/**
 * Compute the new `FolderMap` after a user clicks a folder-level checkbox.
 *
 * - `nextCheck === 'checked'` → switch to `auto-include` mode and clear any
 *   individual doc selections. Future docs ingested into this folder become
 *   accessible automatically.
 * - Anything else (`'unchecked'` / `'partial'`) → switch to `strict` mode with
 *   an empty allowlist. The folder is effectively excluded until the user
 *   explicitly re-checks individual docs.
 *
 * Returns the same `folderMap` reference when `folderId` is unknown (no-op,
 * lets the component skip a setState round-trip).
 */
export function applyToggleFolder(
	folderId: string,
	nextCheck: CheckState,
	folderMap: FolderMap,
): FolderMap {
	const node = folderMap[folderId];
	if (!node) return folderMap;
	const nextMode: FolderMode = nextCheck === 'checked' ? 'auto-include' : 'strict';
	return {
		...folderMap,
		[folderId]: { ...node, mode: nextMode, checkedDocIds: new Set() },
	};
}

/** Result of {@link applyToggleDocument}. */
export interface ApplyToggleDocumentResult {
	folderMap: FolderMap;
	/**
	 * Set to a non-null string when the helper triggered the auto-include →
	 * strict bascule. The component is expected to surface the message as a
	 * toast so the user is aware that future docs in this folder will NOT be
	 * auto-included anymore.
	 */
	toastMessage: string | null;
}

/**
 * Compute the new `FolderMap` after a user clicks an individual doc checkbox.
 *
 * Two cases:
 *
 * 1. Folder is `auto-include` → bascule into `strict`. Pre-check every OTHER
 *    doc in the folder so the user's intent is preserved (they wanted to
 *    *exclude* one doc, not nuke the whole folder). Returns a `toastMessage`
 *    so the caller can warn that future docs won't be auto-allowed anymore.
 *
 * 2. Folder is already `strict` → simple add/remove on the explicit allowlist.
 *    No mode change, no toast.
 *
 * Returns the same `folderMap` reference (and `toastMessage: null`) when
 * `folderId` is unknown — no-op, lets the component skip a setState round-trip.
 */
export function applyToggleDocument(
	folderId: string,
	docId: string,
	folderMap: FolderMap,
): ApplyToggleDocumentResult {
	const node = folderMap[folderId];
	if (!node) return { folderMap, toastMessage: null };

	if (node.mode === 'auto-include') {
		// Pre-check every doc except the one being unchecked, then flip mode.
		const allDocIds = new Set(node.documents.map((d) => d.id));
		allDocIds.delete(docId);
		return {
			folderMap: {
				...folderMap,
				[folderId]: { ...node, mode: 'strict', checkedDocIds: allDocIds },
			},
			toastMessage: `Le dossier "${node.folder.name}" est maintenant en mode strict. Les nouveaux fichiers ne seront pas accessibles automatiquement.`,
		};
	}

	// strict mode: toggle individual doc
	const nextChecked = new Set(node.checkedDocIds);
	if (nextChecked.has(docId)) {
		nextChecked.delete(docId);
	} else {
		nextChecked.add(docId);
	}
	return {
		folderMap: {
			...folderMap,
			[folderId]: { ...node, checkedDocIds: nextChecked },
		},
		toastMessage: null,
	};
}

// ---------------------------------------------------------------------------
// Count selected folders and documents
// ---------------------------------------------------------------------------

export function countSelected(
  sourceIncluded: boolean,
  rootFolderIds: string[],
  rootDocuments: RagDocument[],
  folderMap: FolderMap,
): { folders: number; documents: number } {
  if (!sourceIncluded) return { folders: 0, documents: 0 };

  let folders = 0;
  let documents = 0;

  const walkFolder = (folderId: string): void => {
    const node = folderMap[folderId];
    if (!node) return;
    if (node.mode === 'auto-include') {
      folders += 1;
    } else {
      documents += node.checkedDocIds.size;
      for (const cid of node.childFolderIds) walkFolder(cid);
    }
  };

  for (const fid of rootFolderIds) walkFolder(fid);
  documents += rootDocuments.length;

  return { folders, documents };
}
