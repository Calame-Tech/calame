// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useEffect, useRef, useState } from 'react';
import type { RagJob } from '../types.js';
import { apiGet, type RagJobListResponse } from './api.js';

interface IngestionStatusCardProps {
	/** Optional source filter — when set, only jobs for this source are shown. */
	sourceId?: string;
	/** Polling interval in ms. Defaults to 2000ms. */
	pollIntervalMs?: number;
}

/** Statuses that mean we should keep polling. */
const ACTIVE_STATUSES: ReadonlyArray<RagJob['status']> = ['pending', 'running'];

function isActive(job: RagJob): boolean {
	return ACTIVE_STATUSES.includes(job.status);
}

function statusLabel(status: RagJob['status']): string {
	switch (status) {
		case 'pending':
			return 'En attente';
		case 'running':
			return 'En cours';
		case 'completed':
			return 'Terminé';
		case 'failed':
			return 'Échec';
	}
}

function statusBadgeClasses(status: RagJob['status']): string {
	switch (status) {
		case 'pending':
			return 'bg-gray-700/40 text-gray-300';
		case 'running':
			return 'bg-os-700/30 text-os-300';
		case 'completed':
			return 'bg-green-950/40 text-green-400 border border-green-800/50';
		case 'failed':
			return 'bg-red-950/40 text-red-400 border border-red-800/50';
	}
}

export default function IngestionStatusCard({
	sourceId,
	pollIntervalMs = 2000,
}: IngestionStatusCardProps) {
	const [jobs, setJobs] = useState<RagJob[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelledRef = useRef(false);

	useEffect(() => {
		cancelledRef.current = false;

		const fetchJobs = async (): Promise<void> => {
			try {
				const url = sourceId
					? `/api/rag/jobs?sourceId=${encodeURIComponent(sourceId)}`
					: '/api/rag/jobs';
				const data = await apiGet<RagJobListResponse>(url);
				if (cancelledRef.current) return;
				setJobs(data.jobs ?? []);
				setError(null);
				setLoading(false);

				// Stop polling once nothing is active.
				const stillActive = (data.jobs ?? []).some(isActive);
				if (stillActive) {
					timerRef.current = setTimeout(() => void fetchJobs(), pollIntervalMs);
				}
			} catch (err) {
				if (cancelledRef.current) return;
				setError(err instanceof Error ? err.message : 'Erreur de chargement.');
				setLoading(false);
				// Retry once after the interval — transient failures shouldn't
				// freeze the UI permanently.
				timerRef.current = setTimeout(() => void fetchJobs(), pollIntervalMs);
			}
		};

		void fetchJobs();

		return () => {
			cancelledRef.current = true;
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
	}, [sourceId, pollIntervalMs]);

	if (loading) {
		return (
			<div className="card-primary p-4">
				<p className="text-sm text-gray-500">Chargement des jobs d'indexation…</p>
			</div>
		);
	}

	if (error) {
		return (
			<div className="card-primary p-4 border border-red-800/50">
				<p className="text-sm text-red-400">{error}</p>
			</div>
		);
	}

	if (jobs.length === 0) {
		return (
			<div className="card-primary p-4">
				<p className="text-sm text-gray-500">Aucun job d'indexation en cours.</p>
			</div>
		);
	}

	return (
		<div className="card-primary p-4 space-y-3">
			<div className="flex items-center justify-between">
				<h3 className="eyebrow">Indexation</h3>
				<span className="text-xs text-gray-500">
					{jobs.length} job{jobs.length > 1 ? 's' : ''}
				</span>
			</div>
			<ul className="space-y-2">
				{jobs.map((job) => {
					const total = Math.max(job.totalDocuments, 1);
					const percent = Math.round(
						Math.min(Math.max(job.progress, 0), 1) * 100,
					);
					return (
						<li
							key={job.id}
							className="card-nested p-3 space-y-2"
						>
							<div className="flex items-center justify-between gap-2">
								<span className="text-sm text-gray-200 font-mono-plex truncate">
									{job.sourceId}
								</span>
								<span
									className={`text-xs px-2 py-0.5 rounded-full ${statusBadgeClasses(job.status)}`}
								>
									{statusLabel(job.status)}
								</span>
							</div>
							<div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
								<div
									className={`h-full transition-all duration-300 ${
										job.status === 'failed' ? 'bg-red-500' : 'bg-os-500'
									}`}
									style={{ width: `${percent}%` }}
								/>
							</div>
							<div className="flex items-center justify-between text-xs text-gray-500">
								<span>
									{job.processedDocuments} / {total} documents
								</span>
								<span>{percent}%</span>
							</div>
							{job.error && (
								<p className="text-xs text-red-400 break-words">
									{job.error}
								</p>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
