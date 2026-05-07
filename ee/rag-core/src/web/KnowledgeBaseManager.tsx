// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useCallback, useEffect, useState } from 'react';
import {
	apiDelete,
	apiGet,
	apiPost,
	ApiError,
	type RagSourceListResponse,
	type RagSourcePublic,
	type RagSourceWithCounts,
} from './api.js';
import SourceForm, { type AiSettingOption } from './SourceForm.js';
import FolderTreeView from './FolderTreeView.js';
import DocumentUploader from './DocumentUploader.js';
import IngestionStatusCard from './IngestionStatusCard.js';

interface KnowledgeBaseManagerProps {
	onClose?: () => void;
}

function formatDate(value?: string): string {
	if (!value) return 'Jamais';
	try {
		return new Date(value).toLocaleString('fr-CA', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	} catch {
		return value;
	}
}

export default function KnowledgeBaseManager({ onClose }: KnowledgeBaseManagerProps) {
	const [sources, setSources] = useState<RagSourceWithCounts[]>([]);
	const [aiSettings, setAiSettings] = useState<AiSettingOption[]>([]);
	const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
	const [showCreateForm, setShowCreateForm] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [actionMessage, setActionMessage] = useState<string | null>(null);
	const [syncingId, setSyncingId] = useState<string | null>(null);

	const refreshSources = useCallback(async (): Promise<void> => {
		try {
			const data = await apiGet<RagSourceListResponse>('/api/rag/sources');
			setSources(data.sources ?? []);
			setError(null);
		} catch (err) {
			const message =
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: 'Erreur de chargement.';
			setError(message);
		}
	}, []);

	const refreshAiSettings = useCallback(async (): Promise<void> => {
		// The host's `/api/ai-settings` returns `{ success, settings: [...] }`.
		// We only consume `name`, `label`, `capabilities`, `embeddingModel`.
		try {
			const res = await fetch('/api/ai-settings', { credentials: 'include' });
			if (!res.ok) return;
			const data = (await res.json()) as {
				success?: boolean;
				settings?: AiSettingOption[];
			};
			if (data.success && Array.isArray(data.settings)) {
				setAiSettings(data.settings);
			}
		} catch {
			// Soft fail — the SourceForm will show an explanatory message.
		}
	}, []);

	useEffect(() => {
		void (async () => {
			setLoading(true);
			await Promise.all([refreshSources(), refreshAiSettings()]);
			setLoading(false);
		})();
	}, [refreshSources, refreshAiSettings]);

	const selectedSource = sources.find((s) => s.id === selectedSourceId) ?? null;

	const handleCreated = (source: RagSourcePublic) => {
		setShowCreateForm(false);
		setSelectedSourceId(source.id);
		setActionMessage(`Source "${source.name}" enregistrée.`);
		setTimeout(() => setActionMessage(null), 3000);
		void refreshSources();
	};

	const handleSync = async (source: RagSourcePublic) => {
		setSyncingId(source.id);
		setError(null);
		try {
			await apiPost(`/api/rag/sources/${encodeURIComponent(source.id)}/sync`);
			setActionMessage(`Synchronisation de "${source.name}" lancée.`);
			setTimeout(() => setActionMessage(null), 3000);
			await refreshSources();
		} catch (err) {
			const message =
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: 'Échec de la synchronisation.';
			setError(message);
		} finally {
			setSyncingId(null);
		}
	};

	const handleDelete = async (source: RagSourcePublic) => {
		if (
			!window.confirm(
				`Supprimer la source "${source.name}" ? Tous les documents indexés seront retirés.`,
			)
		) {
			return;
		}
		try {
			await apiDelete(`/api/rag/sources/${encodeURIComponent(source.id)}`);
			if (selectedSourceId === source.id) setSelectedSourceId(null);
			setActionMessage(`Source "${source.name}" supprimée.`);
			setTimeout(() => setActionMessage(null), 3000);
			await refreshSources();
		} catch (err) {
			const message =
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: 'Échec de la suppression.';
			setError(message);
		}
	};

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h2 className="heading-md">Bases de connaissance</h2>
					<p className="text-sm text-gray-500 mt-1">
						Configurez les sources documentaires qui alimentent le RAG.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => setShowCreateForm((v) => !v)}
						className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 shadow-md shadow-os-900/20 ${
							showCreateForm
								? 'bg-gray-700/40 hover:bg-gray-700/60 text-gray-300'
								: 'bg-os-700 hover:bg-os-600 text-white'
						}`}
					>
						{showCreateForm ? 'Annuler' : '+ Nouvelle source'}
					</button>
					{onClose && (
						<button
							type="button"
							onClick={onClose}
							className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors"
						>
							Fermer
						</button>
					)}
				</div>
			</div>

			{actionMessage && (
				<div className="p-2.5 rounded-lg text-sm bg-green-950/30 border border-green-800/50 text-green-400">
					{actionMessage}
				</div>
			)}
			{error && (
				<div className="p-2.5 rounded-lg text-sm bg-red-950/30 border border-red-800/50 text-red-400">
					{error}
				</div>
			)}

			{showCreateForm && (
				<SourceForm
					aiSettings={aiSettings}
					onSave={handleCreated}
					onCancel={() => setShowCreateForm(false)}
				/>
			)}

			{/* Two-column layout: source list (left) and details (right). */}
			<div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 items-start">
				{/* Source list */}
				<div className="space-y-2">
					{loading && (
						<p className="text-sm text-gray-500 italic">Chargement des sources…</p>
					)}
					{!loading && sources.length === 0 && !showCreateForm && (
						<div className="text-sm text-gray-500 italic px-3 py-6 text-center border border-dashed border-white/5 rounded-lg">
							Aucune source. Cliquez sur{' '}
							<span className="text-os-400">+ Nouvelle source</span> pour en créer une.
						</div>
					)}
					{sources.map((source) => {
						const isSelected = source.id === selectedSourceId;
						return (
							<div
								key={source.id}
								role="button"
								tabIndex={0}
								onClick={() => setSelectedSourceId(source.id)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										setSelectedSourceId(source.id);
									}
								}}
								className={`p-3 rounded-lg border bg-gray-900/40 transition-colors cursor-pointer hover:border-white/10 focus:outline-none focus:ring-2 focus:ring-os-500/40 ${
									isSelected ? 'border-os-600/40' : 'border-white/5'
								}`}
							>
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2 flex-wrap">
											<span className="text-sm font-medium text-gray-200 truncate">
												{source.name}
											</span>
											<span className="text-xs text-gray-500">·</span>
											<span className="text-xs text-gray-500">{source.type}</span>
											{source.configError && (
												<span
													className="text-xs bg-red-900/40 text-red-400 px-1.5 py-0.5 rounded border border-red-800/40"
													title={source.configError}
												>
													Configuration illisible
												</span>
											)}
										</div>
										{/* Show decrypted config summary for local sources */}
										{source.type === 'local' && source.config && !source.configError && (
											<div className="text-xs text-gray-600 mt-0.5 font-mono-plex truncate">
												{typeof source.config.rootPath === 'string'
													? `Dossier : ${source.config.rootPath}`
													: null}
											</div>
										)}
										<div className="text-xs text-gray-500 mt-0.5">
											{source.documentCount} document
											{source.documentCount > 1 ? 's' : ''} ·{' '}
											{source.folderCount} dossier
											{source.folderCount > 1 ? 's' : ''}
										</div>
										<div className="text-xs text-gray-600 mt-0.5">
											Dernière sync : {formatDate(source.lastSyncAt)}
										</div>
									</div>
								</div>
								<div className="flex items-center gap-2 mt-3">
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											setSelectedSourceId(source.id);
										}}
										className="px-2 py-1 rounded text-xs text-gray-300 hover:bg-gray-700/40"
									>
										Ouvrir
									</button>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											void handleSync(source);
										}}
										disabled={syncingId === source.id}
										className="px-2 py-1 rounded text-xs text-os-300 hover:bg-os-700/20 disabled:opacity-50"
									>
										{syncingId === source.id ? 'Sync…' : 'Synchroniser'}
									</button>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											void handleDelete(source);
										}}
										className="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-950/40 ml-auto"
									>
										Supprimer
									</button>
								</div>
							</div>
						);
					})}
				</div>

				{/* Detail panel */}
				<div className="space-y-4">
					{selectedSource ? (
						<>
							<FolderTreeView source={selectedSource} />
							{selectedSource.type === 'local' && (
								<div className="card-primary p-4 space-y-2">
									<h3 className="eyebrow">Téléverser des fichiers</h3>
									<DocumentUploader
										source={selectedSource}
										onUploaded={() => void refreshSources()}
									/>
								</div>
							)}
							<IngestionStatusCard sourceId={selectedSource.id} />
						</>
					) : (
						<div className="card-primary p-6 text-center text-sm text-gray-500 italic">
							Sélectionnez une source à gauche pour explorer son contenu.
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
