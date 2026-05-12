// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScopeSelection } from '@calame/core';
import type { RagDocument, RagJob } from '../types.js';
import {
  ApiError,
  apiGet,
  apiPatch,
  apiPost,
  type RagDocumentListResponse,
  type RagFolderListResponse,
  type RagJobListResponse,
  type RagSourceListResponse,
  type RagSourcePublic,
} from './api.js';
import {
  applyToggleDocument,
  applyToggleFolder,
  buildDocumentScope,
  countSelected,
  deriveFolderCheckState,
  type CheckState,
  type FolderMap,
  type FolderMode,
} from '../rag-access-state.js';

// ---------------------------------------------------------------------------
// Public props interface
// ---------------------------------------------------------------------------

interface RagAccessSelectorProps {
  profileName: string;
  /** Full existing scope map for this profile. Only `kind: 'document'` entries are mutated. */
  initialScopes: Record<string, ScopeSelection>;
  /** Full list of sourceIds currently associated with this profile. */
  initialSources: string[];
  onSaved?: (newScopes: Record<string, ScopeSelection>, newSources: string[]) => void;
  onCancel?: () => void;
  /**
   * Override the POST endpoint used during save.
   * Defaults to `/api/profiles/:profileName/scopes` (the MCP-profile endpoint).
   * Callers that persist to a different resource (e.g. Data Profiles → `/api/configurations`)
   * pass their own URL here.
   */
  saveEndpoint?: string;
  /**
   * HTTP method for the save request. Defaults to `'POST'`.
   */
  saveMethod?: 'POST' | 'PATCH';
  /**
   * Transform the default save payload `{ sources, scopes }` before sending.
   * Useful when the target endpoint expects additional fields (e.g. `name`, `label`).
   * If omitted, the raw payload is sent as-is.
   */
  saveBodyTransform?: (payload: {
    sources: string[];
    scopes: Record<string, ScopeSelection>;
  }) => unknown;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Top-level source node.
 */
interface SourceNode {
  source: RagSourcePublic;
  /** Whether root folders have been loaded. */
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  expanded: boolean;
  /** Root-level folder ids (parentId === null). */
  rootFolderIds: string[];
  /** Root-level documents (not in any folder). */
  rootDocuments: RagDocument[];
  /** True when source is fully included (allowAll mode). */
  included: boolean;
  activeJob: RagJob | null;
  syncError: string | null;
}

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

let toastSeq = 0;

// ---------------------------------------------------------------------------
// Source-level check state helper
// ---------------------------------------------------------------------------

function deriveSourceCheckState(node: SourceNode, folderMap: FolderMap): CheckState {
  if (!node.included) return 'unchecked';

  const allFolderStates = node.rootFolderIds.map((fid) =>
    deriveFolderCheckState(fid, folderMap, true),
  );
  const hasPartial = allFolderStates.some((s) => s === 'partial');
  const allChecked =
    allFolderStates.length > 0 && allFolderStates.every((s) => s === 'checked');

  if (allChecked && node.rootDocuments.length === 0) return 'checked';
  if (hasPartial || allFolderStates.some((s) => s === 'unchecked')) return 'partial';
  return 'checked';
}

// ---------------------------------------------------------------------------
// Icons (file-internal)
// ---------------------------------------------------------------------------

function CheckIcon() {
  return (
    <svg
      className="w-3 h-3 text-white"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg
      className="w-3 h-3 text-white"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-3 h-3 text-gray-500 transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="w-4 h-4 text-os-400 flex-shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {open ? (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"
        />
      ) : (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
        />
      )}
    </svg>
  );
}

function FileIcon({ deleted }: { deleted: boolean }) {
  return (
    <svg
      className={`w-4 h-4 flex-shrink-0 ${deleted ? 'text-gray-600' : 'text-gray-500'}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="w-3 h-3 text-gray-500 animate-spin flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 22 6.477 22 12h-4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// TriStateCheckbox
// ---------------------------------------------------------------------------

interface TriStateCheckboxProps {
  state: CheckState;
  onChange: (next: CheckState) => void;
  label: string;
  disabled?: boolean;
}

function TriStateCheckbox({ state, onChange, label, disabled = false }: TriStateCheckboxProps) {
  const handleClick = () => {
    if (disabled) return;
    // checked → unchecked, partial → unchecked, unchecked → checked
    onChange(state === 'unchecked' ? 'checked' : 'unchecked');
  };

  const baseClasses =
    'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors focus:outline-none focus:ring-2 focus:ring-os-500/40 focus:ring-offset-1 focus:ring-offset-gray-900';
  const stateClasses =
    state === 'checked'
      ? 'bg-os-600 border-os-500'
      : state === 'partial'
        ? 'bg-os-700/60 border-os-500/60'
        : 'bg-gray-800 border-gray-600 hover:border-gray-400';

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'partial' ? 'mixed' : state === 'checked'}
      aria-label={label}
      onClick={handleClick}
      disabled={disabled}
      className={`${baseClasses} ${stateClasses} ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      {state === 'checked' && <CheckIcon />}
      {state === 'partial' && <MinusIcon />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// FolderModeBadge — inline button to revert a folder to auto-include
// ---------------------------------------------------------------------------

interface FolderModeBadgeProps {
  mode: FolderMode;
  onForceAutoInclude: () => void;
}

function FolderModeBadge({ mode, onForceAutoInclude }: FolderModeBadgeProps) {
  if (mode === 'auto-include') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-os-900/40 text-os-400 border border-os-700/40 flex-shrink-0">
        auto-include
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onForceAutoInclude}
      title="Basculer en mode auto-include pour ce dossier"
      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-400 border border-amber-700/40 flex-shrink-0 hover:bg-amber-800/30 transition-colors"
    >
      strict
    </button>
  );
}

// ---------------------------------------------------------------------------
// DocumentRow
// ---------------------------------------------------------------------------

interface DocumentRowProps {
  doc: RagDocument;
  checked: boolean;
  disabled: boolean;
  depth: number;
  onToggle: (docId: string) => void;
}

function DocumentRow({ doc, checked, disabled, depth, onToggle }: DocumentRowProps) {
  const isDeleted = doc.deletedAt !== null;
  const notIndexed = !doc.lastIndexedAt;

  return (
    <li
      className={`flex items-center gap-2 py-1 pr-2 rounded ${isDeleted ? 'opacity-40' : notIndexed ? 'opacity-60' : ''}`}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <TriStateCheckbox
        state={checked && !isDeleted ? 'checked' : 'unchecked'}
        onChange={() => !isDeleted && onToggle(doc.id)}
        label={`Inclure ${doc.name}`}
        disabled={disabled || isDeleted}
      />
      <FileIcon deleted={isDeleted} />
      <span
        className={`text-xs text-gray-300 truncate flex-1 ${isDeleted ? 'line-through text-gray-500' : ''}`}
        title={doc.path}
      >
        {doc.name}
      </span>
      {isDeleted && (
        <span className="text-[10px] px-1 py-0.5 rounded bg-red-950/40 text-red-400 border border-red-800/40 flex-shrink-0">
          supprimé
        </span>
      )}
      {!isDeleted && notIndexed && (
        <span
          className="text-[10px] px-1 py-0.5 rounded bg-gray-800/60 text-gray-500 flex-shrink-0"
          title="Pas encore indexé — sera disponible après la prochaine sync"
        >
          non indexé
        </span>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// FolderRow (recursive)
// ---------------------------------------------------------------------------

interface FolderRowProps {
  folderId: string;
  folderMap: FolderMap;
  sourceIncluded: boolean;
  depth: number;
  saving: boolean;
  onToggleFolder: (folderId: string, nextCheck: CheckState) => void;
  onToggleDocument: (folderId: string, docId: string) => void;
  onToggleExpand: (folderId: string) => void;
  onForceAutoInclude: (folderId: string) => void;
  toastFn: (msg: string, kind?: Toast['kind']) => void;
}

function FolderRow({
  folderId,
  folderMap,
  sourceIncluded,
  depth,
  saving,
  onToggleFolder,
  onToggleDocument,
  onToggleExpand,
  onForceAutoInclude,
}: FolderRowProps) {
  const node = folderMap[folderId];
  if (!node) return null;

  const checkState = deriveFolderCheckState(folderId, folderMap, sourceIncluded);
  const isActive = sourceIncluded && checkState !== 'unchecked';

  return (
    <li className="select-none">
      <div
        className="flex items-center gap-1.5 py-1 pr-2 rounded hover:bg-white/5 transition-colors"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {/* Expand toggle */}
        <button
          type="button"
          onClick={() => onToggleExpand(folderId)}
          className="flex-shrink-0 p-0.5 hover:text-gray-300 transition-colors"
          aria-label={node.expanded ? 'Réduire' : 'Développer'}
          aria-expanded={node.expanded}
        >
          {node.loading ? <SpinnerIcon /> : <ChevronIcon open={node.expanded} />}
        </button>

        {/* Checkbox */}
        <TriStateCheckbox
          state={checkState}
          onChange={(next) => onToggleFolder(folderId, next)}
          label={`Inclure le dossier ${node.folder.name}`}
          disabled={saving || !sourceIncluded}
        />

        <FolderIcon open={node.expanded} />

        <button
          type="button"
          onClick={() => onToggleExpand(folderId)}
          className="flex-1 text-left flex items-center gap-2 min-w-0"
        >
          <span className="text-sm text-gray-200 truncate">{node.folder.name}</span>
          {node.loaded && (
            <span className="text-xs text-gray-600 flex-shrink-0">
              ({node.documents.length + node.childFolderIds.length} éléments)
            </span>
          )}
        </button>

        {/* Mode badge (only shown when folder is included) */}
        {isActive && node.loaded && (
          <FolderModeBadge
            mode={node.mode}
            onForceAutoInclude={() => onForceAutoInclude(folderId)}
          />
        )}
      </div>

      {/* Load error */}
      {node.loadError && (
        <div
          className="text-xs text-red-400 py-1"
          style={{ paddingLeft: `${depth * 16 + 36}px` }}
        >
          {node.loadError}
        </div>
      )}

      {/* Children */}
      {node.expanded && !node.loading && node.loaded && (
        <ul className="space-y-0.5">
          {node.childFolderIds.map((cid) => (
            <FolderRow
              key={cid}
              folderId={cid}
              folderMap={folderMap}
              sourceIncluded={sourceIncluded}
              depth={depth + 1}
              saving={saving}
              onToggleFolder={onToggleFolder}
              onToggleDocument={onToggleDocument}
              onToggleExpand={onToggleExpand}
              onForceAutoInclude={onForceAutoInclude}
              toastFn={() => {
                // intentionally empty — toast is managed in parent
              }}
            />
          ))}
          {node.documents.map((doc) => {
            const checked = node.mode === 'auto-include' || node.checkedDocIds.has(doc.id);
            return (
              <DocumentRow
                key={doc.id}
                doc={doc}
                checked={checked}
                disabled={saving || !sourceIncluded}
                depth={depth + 1}
                onToggle={(docId) => onToggleDocument(folderId, docId)}
              />
            );
          })}
          {node.childFolderIds.length === 0 && node.documents.length === 0 && (
            <li
              className="text-xs text-gray-600 italic py-1"
              style={{ paddingLeft: `${depth * 16 + 36}px` }}
            >
              Dossier vide.
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// ToastList
// ---------------------------------------------------------------------------

interface ToastListProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

function ToastList({ toasts, onDismiss }: ToastListProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="space-y-1.5" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`p-2.5 rounded-lg text-xs border flex items-start justify-between gap-2 ${
            t.kind === 'error'
              ? 'bg-red-950/30 border-red-800/50 text-red-400'
              : 'bg-os-950/30 border-os-800/50 text-os-300'
          }`}
        >
          <span>{t.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            aria-label="Fermer la notification"
            className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SourceRow — header row for a single source + its expanded tree
// ---------------------------------------------------------------------------

interface SourceRowProps {
  node: SourceNode;
  checkState: CheckState;
  saving: boolean;
  folderMap: FolderMap;
  onToggleExpand: (sourceId: string) => void;
  onToggleIncluded: (sourceId: string, next: CheckState) => void;
  onToggleFolder: (folderId: string, next: CheckState) => void;
  onToggleDocument: (folderId: string, docId: string) => void;
  onToggleFolderExpand: (folderId: string) => void;
  onForceAutoInclude: (folderId: string) => void;
  pushToast: (msg: string, kind?: Toast['kind']) => void;
}

function SourceRow({
  node,
  checkState,
  saving,
  folderMap,
  onToggleExpand,
  onToggleIncluded,
  onToggleFolder,
  onToggleDocument,
  onToggleFolderExpand,
  onForceAutoInclude,
  pushToast,
}: SourceRowProps) {
  return (
    <li className="bg-gray-900/30">
      {/* Source header */}
      <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-white/5 transition-colors">
        {/* Expand toggle */}
        <button
          type="button"
          onClick={() => onToggleExpand(node.source.id)}
          className="flex-shrink-0 p-0.5 hover:text-gray-300 transition-colors"
          aria-label={node.expanded ? 'Réduire la source' : 'Développer la source'}
          aria-expanded={node.expanded}
        >
          {node.loading ? <SpinnerIcon /> : <ChevronIcon open={node.expanded} />}
        </button>

        {/* Checkbox */}
        <TriStateCheckbox
          state={checkState}
          onChange={(next) => onToggleIncluded(node.source.id, next)}
          label={`Inclure la source ${node.source.name}`}
          disabled={saving}
        />

        {/* Source name + type */}
        <button
          type="button"
          onClick={() => onToggleExpand(node.source.id)}
          className="flex-1 text-left flex items-center gap-2 min-w-0"
        >
          <span className="text-sm font-medium text-gray-200 truncate">{node.source.name}</span>
          <span className="text-xs text-gray-500 flex-shrink-0">{node.source.type}</span>
        </button>

        {/* Status badges */}
        {node.activeJob && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-os-900/40 text-os-300 border border-os-700/40 flex-shrink-0 flex items-center gap-1">
            <SpinnerIcon />
            indexation {node.activeJob.processedDocuments}/{node.activeJob.totalDocuments}
          </span>
        )}
        {node.syncError && !node.activeJob && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-red-950/40 text-red-400 border border-red-800/40 flex-shrink-0"
            title={node.syncError}
          >
            sync échouée
          </span>
        )}
      </div>

      {/* Source load error */}
      {node.loadError && (
        <div className="px-10 py-1.5 text-xs text-red-400">{node.loadError}</div>
      )}

      {/* Expanded tree */}
      {node.expanded && node.loaded && (
        <div className="bg-gray-900/20 border-t border-white/5 px-2 py-1.5">
          {node.rootFolderIds.length === 0 && node.rootDocuments.length === 0 ? (
            <p className="text-xs text-gray-600 italic py-1 px-2">Aucun contenu indexé.</p>
          ) : (
            <ul className="space-y-0.5">
              {node.rootFolderIds.map((fid) => (
                <FolderRow
                  key={fid}
                  folderId={fid}
                  folderMap={folderMap}
                  sourceIncluded={node.included}
                  depth={0}
                  saving={saving}
                  onToggleFolder={onToggleFolder}
                  onToggleDocument={onToggleDocument}
                  onToggleExpand={onToggleFolderExpand}
                  onForceAutoInclude={onForceAutoInclude}
                  toastFn={pushToast}
                />
              ))}
              {node.rootDocuments.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  checked={node.included}
                  disabled={saving || !node.included}
                  depth={0}
                  onToggle={() => {
                    // Root-level docs: inclusion controlled at source level only
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// SaveFooter — summary counts + cancel/save buttons
// ---------------------------------------------------------------------------

interface SaveFooterProps {
  counts: { folders: number; documents: number };
  saving: boolean;
  onCancel?: () => void;
  onSave: () => void;
}

function SaveFooter({ counts, saving, onCancel, onSave }: SaveFooterProps) {
  const total = counts.folders + counts.documents;

  return (
    <div className="flex items-center justify-between pt-1 border-t border-white/5">
      <p className="text-xs text-gray-500">
        {total > 0 ? (
          <>
            {counts.folders > 0 && (
              <span>
                {counts.folders} dossier{counts.folders > 1 ? 's' : ''}
              </span>
            )}
            {counts.folders > 0 && counts.documents > 0 && (
              <span className="mx-1 text-gray-600">·</span>
            )}
            {counts.documents > 0 && (
              <span>
                {counts.documents} document{counts.documents > 1 ? 's' : ''}
              </span>
            )}
            <span className="ml-1">sélectionné{total > 1 ? 's' : ''}</span>
          </>
        ) : (
          <span>Aucun élément sélectionné</span>
        )}
      </p>

      <div className="flex items-center gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50 transition-colors"
          >
            Annuler
          </button>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="px-4 py-1.5 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium disabled:opacity-50 transition-all duration-200 shadow-md shadow-os-900/20 focus:outline-none focus:ring-2 focus:ring-os-500/40"
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RagAccessSelector — main assembler component
// ---------------------------------------------------------------------------

export default function RagAccessSelector({
  profileName,
  initialScopes: rawInitialScopes,
  initialSources,
  onSaved,
  onCancel,
  saveEndpoint,
  saveMethod = 'POST',
  saveBodyTransform,
}: RagAccessSelectorProps) {
  // Defensive: a profile with no scopes yet passes `undefined` from the host.
  // Coerce to {} so `initialScopes[source.id]` lookups never throw.
  const initialScopes = rawInitialScopes ?? {};

  const [sourceNodes, setSourceNodes] = useState<SourceNode[]>([]);
  const [folderMap, setFolderMap] = useState<FolderMap>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  // ---------------------------------------------------------------------------
  // Toast helpers
  // ---------------------------------------------------------------------------

  const pushToast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ---------------------------------------------------------------------------
  // Initial load: fetch all sources + their jobs
  // ---------------------------------------------------------------------------

  const loadSources = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [sourcesRes, jobsRes] = await Promise.all([
        apiGet<RagSourceListResponse>('/api/rag/sources'),
        apiGet<RagJobListResponse>('/api/rag/jobs').catch(() => ({ jobs: [] })),
      ]);

      const allJobs: RagJob[] = jobsRes.jobs ?? [];

      const nodes: SourceNode[] = (sourcesRes.sources ?? []).map((source) => {
        const existingScope = initialScopes[source.id];
        const docScope = existingScope?.kind === 'document' ? existingScope : null;

        const activeJob =
          allJobs.find(
            (j) => j.sourceId === source.id && (j.status === 'running' || j.status === 'pending'),
          ) ?? null;

        const failedJob =
          allJobs.find((j) => j.sourceId === source.id && j.status === 'failed') ?? null;

        return {
          source,
          loaded: false,
          loading: false,
          loadError: null,
          expanded: false,
          rootFolderIds: [],
          rootDocuments: [],
          included:
            docScope !== null &&
            (docScope.allowedFolders.length > 0 || docScope.allowedDocuments.length > 0),
          activeJob,
          syncError: failedJob?.error ?? null,
        };
      });

      setSourceNodes(nodes);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Erreur.';
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [initialScopes]);

  useEffect(() => {
    void loadSources();
    return () => {
      abortRef.current?.abort();
    };
  }, [loadSources]);

  // ---------------------------------------------------------------------------
  // Lazy load root folders + documents for a source
  // ---------------------------------------------------------------------------

  const loadSourceContents = useCallback(
    async (sourceId: string) => {
      setSourceNodes((prev) =>
        prev.map((n) =>
          n.source.id === sourceId ? { ...n, loading: true, loadError: null } : n,
        ),
      );

      try {
        const [foldersRes, documentsRes] = await Promise.all([
          apiGet<RagFolderListResponse>(`/api/rag/sources/${encodeURIComponent(sourceId)}/folders`),
          apiGet<RagDocumentListResponse>(
            `/api/rag/sources/${encodeURIComponent(sourceId)}/documents`,
          ),
        ]);

        const rootFolders = (foldersRes.folders ?? []).filter((f) => f.parentId === null);
        const rootDocs = (documentsRes.documents ?? []).filter((d) => d.folderId === null);
        const rootFolderIds = rootFolders.map((f) => f.id);

        const existingScope = initialScopes[sourceId];
        const docScope = existingScope?.kind === 'document' ? existingScope : null;

        setFolderMap((prev) => {
          const next = { ...prev };
          for (const folder of rootFolders) {
            if (!next[folder.id]) {
              const mode: FolderMode =
                docScope?.allowedFolders.includes(folder.path) ? 'auto-include' : 'strict';
              next[folder.id] = {
                folder,
                loaded: false,
                loading: false,
                loadError: null,
                expanded: false,
                mode,
                checkedDocIds: new Set(),
                childFolderIds: [],
                documents: [],
              };
            }
          }
          return next;
        });

        setSourceNodes((prev) =>
          prev.map((n) =>
            n.source.id === sourceId
              ? { ...n, loading: false, loaded: true, rootFolderIds, rootDocuments: rootDocs }
              : n,
          ),
        );
      } catch (err) {
        const msg =
          err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Erreur.';
        setSourceNodes((prev) =>
          prev.map((n) =>
            n.source.id === sourceId ? { ...n, loading: false, loadError: msg } : n,
          ),
        );
      }
    },
    [initialScopes],
  );

  // ---------------------------------------------------------------------------
  // Lazy load folder children
  // ---------------------------------------------------------------------------

  const loadFolderChildren = useCallback(
    async (sourceId: string, folderId: string) => {
      setFolderMap((prev) => ({
        ...prev,
        [folderId]: { ...prev[folderId]!, loading: true, loadError: null },
      }));

      try {
        const [foldersRes, documentsRes] = await Promise.all([
          apiGet<RagFolderListResponse>(
            `/api/rag/sources/${encodeURIComponent(sourceId)}/folders?folder=${encodeURIComponent(folderId)}`,
          ),
          apiGet<RagDocumentListResponse>(
            `/api/rag/sources/${encodeURIComponent(sourceId)}/documents?folder=${encodeURIComponent(folderId)}`,
          ),
        ]);

        const childFolders = foldersRes.folders ?? [];
        const documents = documentsRes.documents ?? [];
        const childFolderIds = childFolders.map((f) => f.id);

        const existingScope = initialScopes[sourceId];
        const docScope = existingScope?.kind === 'document' ? existingScope : null;

        setFolderMap((prev) => {
          const next = { ...prev };

          for (const folder of childFolders) {
            if (!next[folder.id]) {
              const mode: FolderMode =
                docScope?.allowedFolders.includes(folder.path) ? 'auto-include' : 'strict';
              next[folder.id] = {
                folder,
                loaded: false,
                loading: false,
                loadError: null,
                expanded: false,
                mode,
                checkedDocIds: new Set<string>(),
                childFolderIds: [],
                documents: [],
              };
            }
          }

          const checkedDocIds = new Set<string>();
          if (docScope) {
            for (const doc of documents) {
              if (docScope.allowedDocuments.includes(doc.path)) {
                checkedDocIds.add(doc.id);
              }
            }
          }

          next[folderId] = {
            ...next[folderId]!,
            loaded: true,
            loading: false,
            loadError: null,
            childFolderIds,
            documents,
            checkedDocIds,
          };

          return next;
        });
      } catch (err) {
        const msg =
          err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Erreur.';
        setFolderMap((prev) => ({
          ...prev,
          [folderId]: { ...prev[folderId]!, loading: false, loadError: msg },
        }));
      }
    },
    [initialScopes],
  );

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  const handleToggleSourceExpand = (sourceId: string) => {
    const node = sourceNodes.find((n) => n.source.id === sourceId);
    if (!node) return;

    if (!node.loaded && !node.loading) {
      void loadSourceContents(sourceId);
    }

    setSourceNodes((prev) =>
      prev.map((n) => (n.source.id === sourceId ? { ...n, expanded: !n.expanded } : n)),
    );
  };

  const handleToggleSourceIncluded = (sourceId: string, next: CheckState) => {
    setSourceNodes((prev) =>
      prev.map((n) => {
        if (n.source.id !== sourceId) return n;
        const included = next === 'checked';
        if (included && !n.loaded && !n.loading) {
          void loadSourceContents(sourceId);
        }
        return { ...n, included, expanded: included || n.expanded };
      }),
    );
  };

  const handleToggleFolderExpand = (folderId: string) => {
    const node = folderMap[folderId];
    if (!node) return;

    const sourceId = node.folder.sourceId;
    if (!node.loaded && !node.loading) {
      void loadFolderChildren(sourceId, folderId);
    }

    setFolderMap((prev) => ({
      ...prev,
      [folderId]: { ...prev[folderId]!, expanded: !prev[folderId]!.expanded },
    }));
  };

  const handleToggleFolder = useCallback((folderId: string, nextCheck: CheckState) => {
    setFolderMap((prev) => applyToggleFolder(folderId, nextCheck, prev));
  }, []);

  const handleToggleDocument = useCallback(
    (folderId: string, docId: string) => {
      setFolderMap((prev) => {
        const { folderMap: nextMap, toastMessage } = applyToggleDocument(folderId, docId, prev);
        if (toastMessage) pushToast(toastMessage, 'info');
        return nextMap;
      });
    },
    [pushToast],
  );

  const handleForceAutoInclude = useCallback((folderId: string) => {
    setFolderMap((prev) => ({
      ...prev,
      [folderId]: { ...prev[folderId]!, mode: 'auto-include', checkedDocIds: new Set() },
    }));
  }, []);

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  const handleSave = async () => {
    setSaving(true);
    try {
      const updatedScopes: Record<string, ScopeSelection> = { ...initialScopes };
      const updatedSources = [...initialSources];

      for (const sourceNode of sourceNodes) {
        const sid = sourceNode.source.id;

        if (!sourceNode.included) {
          const idx = updatedSources.indexOf(sid);
          if (idx !== -1) updatedSources.splice(idx, 1);
          delete updatedScopes[sid];
          continue;
        }

        if (!updatedSources.includes(sid)) {
          updatedSources.push(sid);
        }

        updatedScopes[sid] = buildDocumentScope(
          sourceNode.included,
          sourceNode.rootFolderIds,
          sourceNode.rootDocuments,
          folderMap,
        );
      }

      const endpoint = saveEndpoint ?? `/api/profiles/${encodeURIComponent(profileName)}/scopes`;
      const rawPayload = { sources: updatedSources, scopes: updatedScopes };
      const body = saveBodyTransform ? saveBodyTransform(rawPayload) : rawPayload;

      if (saveMethod === 'PATCH') {
        await apiPatch<{ success: boolean }>(endpoint, body);
      } else {
        await apiPost<{ success: boolean }>(endpoint, body);
      }

      pushToast(`Accès RAG mis à jour pour le profile "${profileName}".`, 'info');
      onSaved?.(updatedScopes, updatedSources);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Erreur.';
      pushToast(`Échec de la sauvegarde : ${msg}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Summary counts
  // ---------------------------------------------------------------------------

  const totalCounts = sourceNodes.reduce(
    (acc, node) => {
      const { folders, documents } = countSelected(
        node.included,
        node.rootFolderIds,
        node.rootDocuments,
        folderMap,
      );
      return { folders: acc.folders + folders, documents: acc.documents + documents };
    },
    { folders: 0, documents: 0 },
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="p-6 text-sm text-gray-500 italic flex items-center gap-2">
        <SpinnerIcon />
        Chargement des bases de connaissance…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-4 rounded-lg bg-red-950/30 border border-red-800/50 text-sm text-red-400">
        {loadError}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h3 className="text-sm font-semibold text-gray-200">
          Scopes RAG — profile{' '}
          <span className="text-os-400 font-mono">"{profileName}"</span>
        </h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Sélectionnez les bases de connaissance et dossiers accessibles pour ce profile.
        </p>
      </div>

      <ToastList toasts={toasts} onDismiss={dismissToast} />

      {/* Source tree */}
      {sourceNodes.length === 0 ? (
        <div className="text-sm text-gray-500 italic px-3 py-6 text-center border border-dashed border-white/5 rounded-lg">
          Aucune base de connaissance configurée.
        </div>
      ) : (
        <div className="border border-white/5 rounded-lg overflow-hidden">
          <ul className="divide-y divide-white/5">
            {sourceNodes.map((node) => (
              <SourceRow
                key={node.source.id}
                node={node}
                checkState={deriveSourceCheckState(node, folderMap)}
                saving={saving}
                folderMap={folderMap}
                onToggleExpand={handleToggleSourceExpand}
                onToggleIncluded={handleToggleSourceIncluded}
                onToggleFolder={handleToggleFolder}
                onToggleDocument={handleToggleDocument}
                onToggleFolderExpand={handleToggleFolderExpand}
                onForceAutoInclude={handleForceAutoInclude}
                pushToast={pushToast}
              />
            ))}
          </ul>
        </div>
      )}

      <SaveFooter
        counts={totalCounts}
        saving={saving}
        onCancel={onCancel}
        onSave={() => void handleSave()}
      />
    </div>
  );
}
