// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useActiveSyncJobs } from './useActiveSyncJobs.js';
import type { RagDocument, RagFolder } from '../types.js';
import {
	apiGet,
	apiPost,
	ApiError,
	type RagDocumentListResponse,
	type RagFolderListResponse,
	type RagSourcePublic,
} from './api.js';

interface FolderTreeViewProps {
	source: RagSourcePublic;
	/**
	 * Bumping this value triggers a re-fetch of the source root so freshly
	 * uploaded documents become visible without a full page reload. Currently
	 * the upload route always lands files at the root folder (cf.
	 * `ee/rag-core/src/routes/rag-upload.ts` — `folder: null`), so we only
	 * refresh the root level on bump. The user's `expanded` set and the
	 * cached child folders are preserved so the tree doesn't collapse.
	 */
	refreshKey?: number;
}

/** Children of a folder (or of the source root, when key is `__root__`). */
interface FolderChildren {
	folders: RagFolder[];
	documents: RagDocument[];
	loading: boolean;
	error: string | null;
}

const ROOT_KEY = '__root__' as const;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} o`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Kio`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} Mio`;
}

function FileIcon() {
	return (
		<svg
			className="w-4 h-4 text-gray-500 flex-shrink-0"
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

function ChevronIcon({ open }: { open: boolean }) {
	return (
		<svg
			className={`w-3 h-3 text-gray-500 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
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

export default function FolderTreeView({ source, refreshKey = 0 }: FolderTreeViewProps) {
	// Map keyed by folderId, or ROOT_KEY for the source root.
	const [children, setChildren] = useState<Record<string, FolderChildren>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [syncing, setSyncing] = useState(false);
	const [syncError, setSyncError] = useState<string | null>(null);
	const [syncMessage, setSyncMessage] = useState<string | null>(null);

	// Poll for active sync jobs for this source so we can render live progress
	// while the worker is processing files. The hook auto-throttles to 5s when
	// an active job exists and stops polling otherwise. `triggerPoll` is used
	// after the manual Synchroniser action to re-arm the loop without remounting.
	const sourceIds = useMemo(() => [source.id], [source.id]);
	const { jobMap, triggerPoll } = useActiveSyncJobs(sourceIds);
	const activeJob = jobMap.get(source.id)?.activeJob ?? null;

	const loadChildren = useCallback(
		async (folderId: string | null): Promise<void> => {
			const key = folderId ?? ROOT_KEY;
			setChildren((prev) => ({
				...prev,
				[key]: {
					folders: prev[key]?.folders ?? [],
					documents: prev[key]?.documents ?? [],
					loading: true,
					error: null,
				},
			}));
			try {
				const folderQuery = folderId ? `?folder=${encodeURIComponent(folderId)}` : '';
				const [foldersRes, documentsRes] = await Promise.all([
					apiGet<RagFolderListResponse>(
						`/api/rag/sources/${encodeURIComponent(source.id)}/folders${folderQuery}`,
					),
					apiGet<RagDocumentListResponse>(
						`/api/rag/sources/${encodeURIComponent(source.id)}/documents${folderQuery}`,
					),
				]);
				setChildren((prev) => ({
					...prev,
					[key]: {
						folders: foldersRes.folders ?? [],
						documents: documentsRes.documents ?? [],
						loading: false,
						error: null,
					},
				}));
			} catch (err) {
				const message =
					err instanceof ApiError
						? err.message
						: err instanceof Error
							? err.message
							: 'Erreur de chargement.';
				setChildren((prev) => ({
					...prev,
					[key]: {
						folders: prev[key]?.folders ?? [],
						documents: prev[key]?.documents ?? [],
						loading: false,
						error: message,
					},
				}));
			}
		},
		[source.id],
	);

	// Reset state when the source changes.
	useEffect(() => {
		setChildren({});
		setExpanded(new Set());
		setSyncError(null);
		setSyncMessage(null);
		void loadChildren(null);
	}, [source.id, loadChildren]);

	// Re-fetch the root level when the parent bumps `refreshKey` (typically
	// after an upload completes). We skip the initial render (refreshKey === 0
	// by default) because the source-change effect above already loaded it.
	// `expanded` and the cached subfolders are intentionally preserved so the
	// tree doesn't collapse under the user's feet on every upload.
	useEffect(() => {
		if (refreshKey === 0) return;
		void loadChildren(null);
	}, [refreshKey, loadChildren]);

	const toggle = (folder: RagFolder) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(folder.id)) {
				next.delete(folder.id);
			} else {
				next.add(folder.id);
				// Lazy load on first expand.
				if (!children[folder.id]) {
					void loadChildren(folder.id);
				}
			}
			return next;
		});
	};

	const handleSync = async () => {
		setSyncing(true);
		setSyncError(null);
		setSyncMessage(null);
		try {
			await apiPost(`/api/rag/sources/${encodeURIComponent(source.id)}/sync`);
			setSyncMessage('Synchronisation lancée.');
			// Re-arm the polling loop so the live progress block appears right
			// away — without this the user has to switch tabs and come back to
			// see the new active job (the hook self-suspends when nothing was
			// active at mount time).
			triggerPoll();
			// Refresh root view; nested folders will refetch if the user re-expands.
			await loadChildren(null);
			// Drop cached children so re-expansion fetches fresh data.
			setChildren((prev) => ({ [ROOT_KEY]: prev[ROOT_KEY] ?? { folders: [], documents: [], loading: false, error: null } }));
			setExpanded(new Set());
		} catch (err) {
			const message =
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: 'Échec de la synchronisation.';
			setSyncError(message);
		} finally {
			setSyncing(false);
			setTimeout(() => setSyncMessage(null), 3000);
		}
	};

	const renderFolder = (folder: RagFolder, depth: number): ReactNode => {
		const isOpen = expanded.has(folder.id);
		const folderChildren = children[folder.id];
		return (
			<li key={folder.id} className="select-none">
				<button
					type="button"
					onClick={() => toggle(folder)}
					className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md hover:bg-white/5 transition-colors"
					style={{ paddingLeft: `${depth * 16 + 8}px` }}
					aria-expanded={isOpen}
				>
					<ChevronIcon open={isOpen} />
					<FolderIcon open={isOpen} />
					<span className="text-sm text-gray-200 truncate">{folder.name}</span>
					<span className="text-xs text-gray-600 font-mono-plex truncate ml-1">
						{folder.path}
					</span>
				</button>
				{isOpen && (
					<>
						{folderChildren?.loading && (
							<div
								className="text-xs text-gray-500 italic py-1"
								style={{ paddingLeft: `${depth * 16 + 32}px` }}
							>
								Chargement…
							</div>
						)}
						{folderChildren?.error && (
							<div
								className="text-xs text-red-400 py-1"
								style={{ paddingLeft: `${depth * 16 + 32}px` }}
							>
								{folderChildren.error}
							</div>
						)}
						{folderChildren && !folderChildren.loading && !folderChildren.error && (
							<ul className="space-y-0.5">
								{folderChildren.folders.map((child) => renderFolder(child, depth + 1))}
								{folderChildren.documents.map((doc) => renderDocument(doc, depth + 1))}
								{folderChildren.folders.length === 0 &&
									folderChildren.documents.length === 0 && (
										<li
											className="text-xs text-gray-600 italic py-1"
											style={{ paddingLeft: `${depth * 16 + 32}px` }}
										>
											Dossier vide.
										</li>
									)}
							</ul>
						)}
					</>
				)}
			</li>
		);
	};

	const renderDocument = (doc: RagDocument, depth: number): ReactNode => {
		const isDeleted = doc.deletedAt !== null;
		const hasIngestError = doc.ingestError !== null;
		return (
			<li
				key={doc.id}
				className={`flex items-center gap-2 px-2 py-1.5 rounded-md ${
					isDeleted ? 'opacity-50 line-through' : hasIngestError ? 'opacity-70' : ''
				}`}
				style={{ paddingLeft: `${depth * 16 + 24}px` }}
			>
				<FileIcon />
				<span
					className={`text-sm truncate ${
						hasIngestError ? 'text-gray-400' : 'text-gray-300'
					}`}
				>
					{doc.name}
				</span>
				{hasIngestError && (
					<span
						className="text-[10px] uppercase tracking-wide text-amber-400 bg-amber-950/40 border border-amber-800/40 px-1.5 py-0.5 rounded flex-shrink-0"
						title={doc.ingestError ?? ''}
					>
						Non supporté
					</span>
				)}
				<span className="text-xs text-gray-600 ml-auto pl-2 flex-shrink-0">
					{formatBytes(doc.size)}
				</span>
			</li>
		);
	};

	const root = children[ROOT_KEY];

	return (
		<div className="card-primary p-4 space-y-3">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<h3 className="eyebrow truncate">{source.name}</h3>
					<p className="text-xs text-gray-500 mt-0.5">{source.type}</p>
				</div>
				<button
					type="button"
					onClick={handleSync}
					disabled={syncing || activeJob !== null}
					className="px-3 py-1.5 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
				>
					{activeJob ? 'Synchronisation en cours…' : syncing ? 'Synchronisation…' : 'Synchroniser'}
				</button>
			</div>

			{activeJob && (
				<div className="text-xs text-gray-300 bg-gray-900/30 border border-gray-700/40 rounded px-3 py-2 flex items-center gap-2">
					<svg
						className="w-3 h-3 animate-spin flex-shrink-0"
						fill="none"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<circle
							className="opacity-25"
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							strokeWidth="4"
						/>
						<path
							className="opacity-75"
							fill="currentColor"
							d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
						/>
					</svg>
					{activeJob.totalDocuments === 0 ? (
						<span>Préparation de la synchronisation…</span>
					) : (
						<span>
							Synchronisation en cours : {activeJob.processedDocuments}/{activeJob.totalDocuments} (
							{Math.round((activeJob.progress ?? 0) * 100)}%)
						</span>
					)}
				</div>
			)}
			{syncMessage && (
				<div className="p-2 rounded-lg text-xs bg-green-950/30 border border-green-800/50 text-green-400">
					{syncMessage}
				</div>
			)}
			{syncError && (
				<div className="p-2 rounded-lg text-xs bg-red-950/30 border border-red-800/50 text-red-400">
					{syncError}
				</div>
			)}

			<div className="border-t border-white/5" />

			{!root || root.loading ? (
				<p className="text-sm text-gray-500 italic">Chargement de l'arborescence…</p>
			) : root.error ? (
				<p className="text-sm text-red-400">{root.error}</p>
			) : root.folders.length === 0 && root.documents.length === 0 ? (
				<p className="text-sm text-gray-500 italic">Aucun fichier indexé pour le moment.</p>
			) : (
				<ul className="space-y-0.5">
					{root.folders.map((f) => renderFolder(f, 0))}
					{root.documents.map((d) => renderDocument(d, 0))}
				</ul>
			)}
		</div>
	);
}
