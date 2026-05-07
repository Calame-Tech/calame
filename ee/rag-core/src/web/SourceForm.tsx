// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useMemo, useState } from 'react';
import type { RagSourceType } from '../types.js';
import type { RagSourcePublic } from '../routes/api-types.js';
import { apiPost, apiPatch, ApiError } from './api.js';

/**
 * Minimal projection of `AiSetting` needed by the embeddings dropdown. The
 * host (packages/web) owns the full type — we accept just the fields we need
 * to keep this package decoupled from the AI Settings module.
 */
export interface AiSettingOption {
	name: string;
	label: string;
	capabilities?: string[];
	embeddingModel?: string;
}

interface SourceFormProps {
	/** Pre-filled values when editing an existing source (API projection — decrypted). */
	initial?: Partial<RagSourcePublic>;
	onSave: (source: RagSourcePublic) => void;
	onCancel: () => void;
	aiSettings: AiSettingOption[];
}

interface SourceTypeMeta {
	value: RagSourceType;
	label: string;
	available: boolean;
}

/**
 * Phase 1 only ships the `local` connector. The remaining types are listed
 * as "Bientôt" (coming soon) so admins can preview the roadmap.
 */
const SOURCE_TYPES: readonly SourceTypeMeta[] = [
	{ value: 'local', label: 'Local (dossier)', available: true },
	{ value: 's3', label: 'S3 / R2 / MinIO', available: false },
	{ value: 'http', label: 'HTTP / URL', available: false },
	{ value: 'gdrive', label: 'Google Drive', available: false },
	{ value: 'gsheets', label: 'Google Sheets', available: false },
	{ value: 'sharepoint', label: 'SharePoint', available: false },
	{ value: 'notion', label: 'Notion', available: false },
	{ value: 'git', label: 'Git', available: false },
];

interface LocalConfig {
	rootPath: string;
}

/**
 * Extract the rootPath from the decrypted `config` object returned by the API.
 * Falls back to an empty string so the admin can re-enter the path when the
 * config object is null (decryption failure surfaced via `configError`).
 */
function extractRootPath(config: Record<string, unknown> | null | undefined): string {
	if (!config) return '';
	return typeof config.rootPath === 'string' ? config.rootPath : '';
}

export default function SourceForm({ initial, onSave, onCancel, aiSettings }: SourceFormProps) {
	const isEditing = Boolean(initial?.id);

	const [name, setName] = useState(initial?.name ?? '');
	const [type, setType] = useState<RagSourceType>(initial?.type ?? 'local');
	// Read rootPath from the decrypted `config` object — the API no longer
	// returns `configEncrypted`; it always returns `config: object | null`.
	const [rootPath, setRootPath] = useState(extractRootPath(initial?.config));
	const [embeddingSettingName, setEmbeddingSettingName] = useState(
		initial?.embeddingSettingName ?? '',
	);
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Server-provided detail message shown below the main 409 error text.
	const [serverError, setServerError] = useState<string | null>(null);

	const embeddingsCapableSettings = useMemo(
		() => aiSettings.filter((s) => s.capabilities?.includes('embeddings')),
		[aiSettings],
	);

	const selectedSetting = useMemo(
		() => aiSettings.find((s) => s.name === embeddingSettingName) ?? null,
		[aiSettings, embeddingSettingName],
	);

	const selectedSettingSupportsEmbeddings = Boolean(
		selectedSetting?.capabilities?.includes('embeddings'),
	);

	const validate = (): string | null => {
		if (!name.trim()) return 'Le nom de la source est requis.';
		if (type === 'local' && !rootPath.trim()) {
			return 'Le chemin du dossier est requis.';
		}
		if (!embeddingSettingName) {
			return 'Sélectionnez une configuration IA pour les embeddings.';
		}
		if (!selectedSettingSupportsEmbeddings) {
			return "La configuration IA sélectionnée ne supporte pas les embeddings.";
		}
		return null;
	};

	const buildPayload = () => {
		// Send `config` as a plain object — the server encrypts it server-side.
		// Do NOT send `embeddingModelVersion`: the server derives it from
		// `embeddingSettingName`.
		const config: LocalConfig = { rootPath: rootPath.trim() };
		return {
			name: name.trim(),
			type,
			config,
			embeddingSettingName,
		};
	};

	const handleSave = async () => {
		setError(null);
		setServerError(null);
		setTestResult(null);
		const validationError = validate();
		if (validationError) {
			setError(validationError);
			return;
		}
		setSaving(true);
		try {
			const payload = buildPayload();
			const saved = isEditing && initial?.id
				? await apiPatch<RagSourcePublic>(
						`/api/rag/sources/${encodeURIComponent(initial.id)}`,
						payload,
					)
				: await apiPost<RagSourcePublic>('/api/rag/sources', payload);
			onSave(saved);
		} catch (err) {
			if (err instanceof ApiError && err.status === 409) {
				setError(
					"Toutes les sources RAG doivent utiliser le même modèle d'embeddings (dimension fixe). " +
					"Réessaie avec une config IA dont le modèle a la même dimension que les sources existantes.",
				);
				setServerError(err.message);
			} else {
				const message =
					err instanceof ApiError
						? err.message
						: err instanceof Error
							? err.message
							: "Échec de l'enregistrement.";
				setError(message);
			}
		} finally {
			setSaving(false);
		}
	};

	const handleTest = async () => {
		setError(null);
		setTestResult(null);
		const validationError = validate();
		if (validationError) {
			setError(validationError);
			return;
		}
		setTesting(true);
		try {
			if (isEditing && initial?.id) {
				// Save current values first so the test runs against them.
				await apiPatch<RagSourcePublic>(
					`/api/rag/sources/${encodeURIComponent(initial.id)}`,
					buildPayload(),
				);
				await apiPost(
					`/api/rag/sources/${encodeURIComponent(initial.id)}/test`,
					{},
				);
				setTestResult({ success: true, message: 'Connexion validée.' });
			} else {
				// For a new source there is no id yet; create-then-test.
				const created = await apiPost<RagSourcePublic>('/api/rag/sources', buildPayload());
				try {
					await apiPost(
						`/api/rag/sources/${encodeURIComponent(created.id)}/test`,
						{},
					);
					setTestResult({ success: true, message: 'Source créée et connexion validée.' });
				} catch (testErr) {
					const message =
						testErr instanceof ApiError
							? testErr.message
							: testErr instanceof Error
								? testErr.message
								: 'Échec du test.';
					setTestResult({
						success: false,
						message: `Source créée, mais test échoué : ${message}`,
					});
				}
				onSave(created);
			}
		} catch (err) {
			const message =
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: 'Échec du test.';
			setTestResult({ success: false, message });
		} finally {
			setTesting(false);
		}
	};

	return (
		<div className="card-primary p-5 space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="heading-md text-xl">
					{isEditing ? 'Modifier la source' : 'Nouvelle source'}
				</h3>
				<button
					type="button"
					onClick={onCancel}
					className="text-xs text-gray-400 hover:text-gray-200"
				>
					Fermer
				</button>
			</div>

			{/* Name */}
			<div>
				<label htmlFor="rag-source-name" className="text-sm text-gray-400">
					Nom de la source <span className="text-red-400">*</span>
				</label>
				<input
					id="rag-source-name"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Documentation produit"
					className="input-editorial w-full text-sm mt-1"
				/>
			</div>

			{/* Type */}
			<div>
				<label htmlFor="rag-source-type" className="text-sm text-gray-400">
					Type <span className="text-red-400">*</span>
				</label>
				<select
					id="rag-source-type"
					value={type}
					onChange={(e) => setType(e.target.value as RagSourceType)}
					disabled={isEditing}
					className="input-editorial w-full text-sm mt-1 disabled:opacity-60"
				>
					{SOURCE_TYPES.map((t) => (
						<option key={t.value} value={t.value} disabled={!t.available} className="bg-gray-800">
							{t.label}
							{!t.available ? ' — Bientôt' : ''}
						</option>
					))}
				</select>
				{isEditing && (
					<p className="text-xs text-gray-600 mt-1">
						Le type d'une source ne peut pas être modifié après création.
					</p>
				)}
			</div>

			{/* Type-specific config */}
			{type === 'local' && (
				<div>
					<label htmlFor="rag-source-rootpath" className="text-sm text-gray-400">
						Chemin absolu du dossier <span className="text-red-400">*</span>
					</label>
					<div className="flex items-center gap-2 mt-1">
						<input
							id="rag-source-rootpath"
							type="text"
							value={rootPath}
							onChange={(e) => setRootPath(e.target.value)}
							placeholder="/data/kb/produit"
							className="input-editorial flex-1 text-sm"
						/>
						<button
							type="button"
							onClick={handleTest}
							disabled={testing || saving}
							className="px-3 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200 disabled:opacity-50"
						>
							{testing ? 'Test…' : 'Tester'}
						</button>
					</div>
					<p className="text-xs text-gray-600 mt-1">
						Le serveur doit pouvoir lire ce chemin. Les fichiers ajoutés ultérieurement
						sont indexés à la prochaine synchronisation.
					</p>
				</div>
			)}

			{/* Embeddings AI setting */}
			<div>
				<label htmlFor="rag-source-embedding" className="text-sm text-gray-400">
					Configuration d'embeddings <span className="text-red-400">*</span>
				</label>
				{aiSettings.length === 0 ? (
					<p className="text-xs text-amber-400 mt-1">
						Aucune configuration IA enregistrée. Créez-en une dans la section "AI Settings"
						avec la capacité <span className="font-mono-plex">embeddings</span>.
					</p>
				) : (
					<select
						id="rag-source-embedding"
						value={embeddingSettingName}
						onChange={(e) => setEmbeddingSettingName(e.target.value)}
						className="input-editorial w-full text-sm mt-1"
					>
						<option value="" className="bg-gray-800">
							Sélectionner une configuration IA…
						</option>
						{aiSettings.map((s) => {
							const supports = s.capabilities?.includes('embeddings');
							return (
								<option
									key={s.name}
									value={s.name}
									disabled={!supports}
									title={
										supports
											? undefined
											: 'Cette config IA ne supporte pas les embeddings'
									}
									className="bg-gray-800"
								>
									{s.label}
									{supports
										? s.embeddingModel
											? ` — ${s.embeddingModel}`
											: ''
										: ' — embeddings non supportés'}
								</option>
							);
						})}
					</select>
				)}
				{embeddingsCapableSettings.length === 0 && aiSettings.length > 0 && (
					<p className="text-xs text-amber-400 mt-1">
						Aucune configuration IA disponible ne supporte les embeddings. Activez la capacité
						<span className="font-mono-plex"> embeddings</span> sur l'une de vos configurations.
					</p>
				)}
				{selectedSetting && selectedSettingSupportsEmbeddings && (
					<div className="flex items-center gap-4 mt-1">
						<p className="text-xs text-gray-500">
							Modèle :{' '}
							<span className="font-mono-plex text-gray-400">
								{selectedSetting.embeddingModel ?? '(non spécifié)'}
							</span>
						</p>
						{/* Show the dimension from the existing source when editing. */}
						{initial?.embeddingDimensions !== undefined && (
							<p className="text-xs text-gray-500">
								Dimension :{' '}
								<span className="font-mono-plex text-gray-400">
									{initial.embeddingDimensions} tokens
								</span>
							</p>
						)}
					</div>
				)}
			</div>

			{error && (
				<div className="p-2.5 rounded-lg text-sm bg-red-950/30 border border-red-800/50 text-red-400 space-y-1">
					<p>{error}</p>
					{serverError && (
						<p className="text-xs text-red-300 opacity-80">{serverError}</p>
					)}
				</div>
			)}
			{testResult && (
				<div
					className={`p-2.5 rounded-lg text-sm ${
						testResult.success
							? 'bg-green-950/30 border border-green-800/50 text-green-400'
							: 'bg-red-950/30 border border-red-800/50 text-red-400'
					}`}
				>
					{testResult.message}
				</div>
			)}

			<div className="flex items-center gap-3 pt-2">
				<button
					type="button"
					onClick={handleSave}
					disabled={saving}
					className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50 shadow-md shadow-os-900/20"
				>
					{saving ? 'Enregistrement…' : 'Enregistrer'}
				</button>
				<button
					type="button"
					onClick={onCancel}
					className="px-4 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200"
				>
					Annuler
				</button>
			</div>
		</div>
	);
}
