// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { ChangeEvent, DragEvent } from 'react';
import { useRef, useState } from 'react';
import type { RagDocument } from '../types.js';
import { apiUpload, ApiError, type RagSourcePublic } from './api.js';

/**
 * Maximum file size accepted by the uploader, in bytes. Backend MUST mirror
 * this cap — keep them in sync. Phase 1 deliberately uses a fixed constant;
 * a per-instance setting can be added later via the host's settings page.
 */
export const MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Whitelist of MIME types accepted by the upload endpoint. The list mirrors
 * the parsers shipped with `ee/rag-core` (PDF via unpdf, DOCX via mammoth,
 * Markdown via unified, CSV via papaparse, plain text + HTML).
 */
const ACCEPTED_MIME_TYPES: readonly string[] = [
	'application/pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'text/markdown',
	'text/csv',
	'text/plain',
	'text/html',
];

/** HTML `accept` attribute for the file input. Mirrors ACCEPTED_MIME_TYPES + common extensions. */
const ACCEPT_ATTR =
	'.pdf,.docx,.md,.markdown,.csv,.txt,.html,.htm,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/csv,text/plain,text/html';

interface DocumentUploaderProps {
	source: RagSourcePublic;
	onUploaded?: (docs: RagDocument[]) => void;
}

interface UploadResponse {
	documents: RagDocument[];
}

interface RejectedFile {
	name: string;
	reason: string;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} o`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Kio`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} Mio`;
}

/**
 * Best-effort MIME validation. Some browsers leave `file.type` empty for
 * Markdown and unusual extensions — fall back to extension matching to keep
 * the UX reasonable. The backend remains the source of truth.
 */
function isAcceptedFile(file: File): boolean {
	if (file.type && ACCEPTED_MIME_TYPES.includes(file.type)) return true;
	const lower = file.name.toLowerCase();
	if (lower.endsWith('.pdf')) return true;
	if (lower.endsWith('.docx')) return true;
	if (lower.endsWith('.md') || lower.endsWith('.markdown')) return true;
	if (lower.endsWith('.csv')) return true;
	if (lower.endsWith('.txt')) return true;
	if (lower.endsWith('.html') || lower.endsWith('.htm')) return true;
	return false;
}

export default function DocumentUploader({ source, onUploaded }: DocumentUploaderProps) {
	const [isDragging, setIsDragging] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [rejected, setRejected] = useState<RejectedFile[]>([]);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const validate = (files: File[]): { accepted: File[]; rejected: RejectedFile[] } => {
		const accepted: File[] = [];
		const rejectedList: RejectedFile[] = [];
		for (const f of files) {
			if (f.size > MAX_UPLOAD_SIZE_BYTES) {
				rejectedList.push({
					name: f.name,
					reason: `Trop volumineux (${formatBytes(f.size)} > ${formatBytes(MAX_UPLOAD_SIZE_BYTES)})`,
				});
				continue;
			}
			if (!isAcceptedFile(f)) {
				rejectedList.push({
					name: f.name,
					reason: `Type non supporté (${f.type || 'inconnu'})`,
				});
				continue;
			}
			accepted.push(f);
		}
		return { accepted, rejected: rejectedList };
	};

	const upload = async (files: File[]): Promise<void> => {
		setError(null);
		setSuccess(null);
		setRejected([]);
		if (files.length === 0) return;

		const { accepted, rejected: rejectedList } = validate(files);
		setRejected(rejectedList);
		if (accepted.length === 0) {
			setError('Aucun fichier valide à téléverser.');
			return;
		}

		setUploading(true);
		try {
			// Phase 1: no per-file XHR progress; the backend processes uploads
			// synchronously and returns the indexed document records. Per-file
			// progress will be added in Phase 2 once the backend exposes a
			// streaming/job-based ingestion endpoint.
			const formData = new FormData();
			for (const file of accepted) {
				formData.append('files', file, file.name);
			}
			const data = await apiUpload<UploadResponse>(
				`/api/rag/sources/${encodeURIComponent(source.id)}/upload`,
				formData,
			);
			const docs = data.documents ?? [];
			setSuccess(`${docs.length} fichier${docs.length > 1 ? 's' : ''} téléversé${docs.length > 1 ? 's' : ''}.`);
			onUploaded?.(docs);
		} catch (err) {
			const message =
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: 'Échec du téléversement.';
			setError(message);
		} finally {
			setUploading(false);
			if (inputRef.current) inputRef.current.value = '';
		}
	};

	const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		if (!uploading) setIsDragging(true);
	};

	const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragging(false);
	};

	const handleDrop = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragging(false);
		if (uploading) return;
		const files = Array.from(e.dataTransfer.files);
		void upload(files);
	};

	const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		void upload(files);
	};

	const handleClick = () => {
		if (uploading) return;
		inputRef.current?.click();
	};

	return (
		<div className="space-y-3">
			<div
				role="button"
				tabIndex={0}
				onClick={handleClick}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						handleClick();
					}
				}}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
				className={`flex flex-col items-center justify-center gap-2 px-6 py-10 rounded-2xl border-2 border-dashed transition-all duration-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-os-500/40 ${
					isDragging
						? 'border-os-500 bg-os-700/10'
						: 'border-white/10 bg-gray-900/40 hover:border-white/20'
				} ${uploading ? 'opacity-60 cursor-wait' : ''}`}
			>
				<svg
					className="w-8 h-8 text-gray-500"
					fill="none"
					stroke="currentColor"
					strokeWidth={1.5}
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
					/>
				</svg>
				<p className="text-sm text-gray-300">
					{uploading ? 'Téléversement…' : 'Glissez-déposez des fichiers ici, ou cliquez pour parcourir.'}
				</p>
				<p className="text-xs text-gray-500">
					PDF, DOCX, MD, CSV, TXT, HTML — {formatBytes(MAX_UPLOAD_SIZE_BYTES)} max par fichier.
				</p>
				<input
					ref={inputRef}
					type="file"
					multiple
					accept={ACCEPT_ATTR}
					onChange={handleFileChange}
					className="hidden"
					aria-label="Sélectionner des fichiers à téléverser"
				/>
			</div>

			{success && (
				<div className="p-2.5 rounded-lg text-sm bg-green-950/30 border border-green-800/50 text-green-400">
					{success}
				</div>
			)}
			{error && (
				<div className="p-2.5 rounded-lg text-sm bg-red-950/30 border border-red-800/50 text-red-400">
					{error}
				</div>
			)}
			{rejected.length > 0 && (
				<div className="p-2.5 rounded-lg text-sm bg-amber-950/30 border border-amber-800/50 text-amber-300 space-y-1">
					<p className="font-medium">Fichiers ignorés :</p>
					<ul className="list-disc list-inside text-xs space-y-0.5">
						{rejected.map((r) => (
							<li key={r.name}>
								<span className="font-mono-plex">{r.name}</span> — {r.reason}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
