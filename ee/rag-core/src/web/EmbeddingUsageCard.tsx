// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, ApiError, type RagUsageResponse } from './api.js';

interface EmbeddingUsageCardProps {
	/** Polling interval in ms. Defaults to 30s. */
	pollIntervalMs?: number;
	/** Period token sent to the API. Defaults to `'month'`. */
	period?: 'month' | 'week' | 'all';
}

/**
 * Compact integer formatter — `1234567 → "1.2M"`, `234567 → "235K"`. Keeps
 * the card tight without losing magnitude. Numbers below 1000 are shown as-is.
 */
function compactNumber(n: number): string {
	if (!Number.isFinite(n)) return '0';
	if (n >= 1_000_000) {
		const v = n / 1_000_000;
		return `${v >= 10 ? v.toFixed(1) : v.toFixed(2)}M`;
	}
	if (n >= 1_000) {
		const v = n / 1_000;
		return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}K`;
	}
	return n.toLocaleString('fr-CA');
}

function formatUsd(amount: number): string {
	if (!Number.isFinite(amount) || amount <= 0) return '$0';
	if (amount < 0.01) return '< $0.01';
	if (amount < 1) return `$${amount.toFixed(3)}`;
	if (amount < 100) return `$${amount.toFixed(2)}`;
	return `$${amount.toFixed(0)}`;
}

function periodLabel(p: 'month' | 'week' | 'all'): string {
	switch (p) {
		case 'month':
			return '30 derniers jours';
		case 'week':
			return '7 derniers jours';
		case 'all':
			return "depuis l'origine";
	}
}

/**
 * Tiny inline sparkline rendered with flex+heights — no SVG dep. Each bar's
 * height is normalized against the max token count in `values`. Looks sober
 * enough to match the Tailwind dashboard cards above; the visual goal is
 * "you can see if usage is trending up", not a precision chart.
 */
function Sparkline({ values }: { values: number[] }) {
	if (values.length === 0) {
		return (
			<div className="text-xs text-gray-600 italic">
				Aucune activité récente.
			</div>
		);
	}
	const max = Math.max(1, ...values);
	return (
		<div
			className="flex items-end gap-px h-10"
			role="img"
			aria-label="Activité par jour"
		>
			{values.map((v, i) => {
				const ratio = v / max;
				// Floor at 8% so a tiny non-zero day is still visible against
				// the dark background. Cap top at 100%.
				const pct = v === 0 ? 0 : Math.max(8, Math.min(100, ratio * 100));
				return (
					<div
						key={i}
						className="flex-1 bg-os-600/60 rounded-sm transition-all"
						style={{ height: `${pct}%` }}
						title={`${compactNumber(v)} tokens`}
					/>
				);
			})}
		</div>
	);
}

export default function EmbeddingUsageCard({
	pollIntervalMs = 30_000,
	period = 'month',
}: EmbeddingUsageCardProps) {
	const [usage, setUsage] = useState<RagUsageResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelledRef = useRef(false);

	const fetchUsage = useCallback(async (): Promise<void> => {
		try {
			const data = await apiGet<RagUsageResponse>(
				`/api/rag/usage?period=${encodeURIComponent(period)}`,
			);
			if (cancelledRef.current) return;
			setUsage(data);
			setError(null);
		} catch (err) {
			if (cancelledRef.current) return;
			const message =
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: 'Erreur de chargement.';
			setError(message);
		} finally {
			if (!cancelledRef.current) setLoading(false);
		}
	}, [period]);

	useEffect(() => {
		cancelledRef.current = false;
		void fetchUsage();
		// Poll on a low cadence — embedding usage is a slow-moving counter,
		// and we don't want a noisy tab to thrash the API or the SQLite WAL.
		timerRef.current = setInterval(() => void fetchUsage(), pollIntervalMs);
		return () => {
			cancelledRef.current = true;
			if (timerRef.current) clearInterval(timerRef.current);
		};
	}, [fetchUsage, pollIntervalMs]);

	if (loading && !usage) {
		return (
			<div className="card-primary p-4">
				<p className="text-sm text-gray-500 italic">
					Chargement de la consommation…
				</p>
			</div>
		);
	}

	if (error && !usage) {
		return (
			<div className="card-primary p-4 border border-red-800/40">
				<p className="text-sm text-red-400">
					Impossible de charger la consommation : {error}
				</p>
			</div>
		);
	}

	if (!usage) return null;

	const topSources = usage.perSource.slice(0, 3);
	const sparklineValues = usage.perDay.map((d) => d.tokens);

	// Cap rollup — always defined by the contract, but tolerate older
	// backends (or fixtures that hand-roll the response) by guarding with
	// optional chaining + a 0 default. The whole cap block is hidden when
	// `monthlyTokenCap` is 0 (unlimited), with a single discreet note so
	// operators can tell the cap is intentionally unset rather than missing.
	const cap = usage.cap;
	const capActive = !!cap && cap.monthlyTokenCap > 0;
	const fractionUsed = cap ? cap.fractionUsed : 0;
	const capExceeded = capActive && fractionUsed >= 1;
	const capWarning = capActive && !capExceeded && cap.nearingThreshold;
	// Progress bar colour ramps green → amber → red, matching the
	// banner state. Clamp the visible width at 100% so an over-cap run
	// (which can briefly report >1.0 in fractionUsed) doesn't overflow.
	const barPct = Math.max(0, Math.min(100, fractionUsed * 100));
	const barColor = capExceeded
		? 'bg-red-500'
		: capWarning
			? 'bg-yellow-500'
			: 'bg-os-500';

	return (
		<div className="card-primary p-4 space-y-3">
			<div className="flex items-baseline justify-between gap-2">
				<div>
					<h3 className="text-sm font-semibold text-gray-200">
						Consommation embeddings
					</h3>
					<p className="text-xs text-gray-500 mt-0.5">
						{periodLabel(usage.period)}
					</p>
				</div>
				<div className="text-right">
					<div className="text-2xl font-semibold text-os-300">
						{compactNumber(usage.totalTokens)}
						<span className="text-sm text-gray-500 ml-1">tokens</span>
					</div>
					<div className="text-xs text-gray-400">
						≈ {formatUsd(usage.totalCostUsd)}
					</div>
				</div>
			</div>

			{capActive && cap && (
				<div className="space-y-1.5">
					<div className="flex items-baseline justify-between gap-2">
						<div className="eyebrow">Cap mensuel</div>
						<div className="text-xs text-gray-400">
							{cap.currentMonthTokens.toLocaleString('fr-CA')} /{' '}
							{cap.monthlyTokenCap.toLocaleString('fr-CA')}
							<span className="text-gray-500 ml-1">
								({(fractionUsed * 100).toFixed(1)}%)
							</span>
						</div>
					</div>
					<div
						className="h-1.5 w-full rounded-full bg-gray-800 overflow-hidden"
						role="progressbar"
						aria-valuenow={Math.round(fractionUsed * 100)}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-label="Consommation mensuelle d'embeddings"
					>
						<div
							className={`h-full ${barColor} transition-all`}
							style={{ width: `${barPct}%` }}
						/>
					</div>
					{capExceeded && (
						<div className="text-xs text-red-300 bg-red-900/30 border border-red-800/40 rounded px-2 py-1.5">
							Cap mensuel atteint. Les synchronisations vont
							échouer jusqu&apos;à la fin du mois ou jusqu&apos;à
							ce que le cap soit relevé.
						</div>
					)}
					{capWarning && (
						<div className="text-xs text-yellow-300 bg-yellow-900/30 border border-yellow-800/40 rounded px-2 py-1.5">
							Approche du cap mensuel
							{cap.warningThreshold > 0 && (
								<>
									{' '}
									(seuil {Math.round(cap.warningThreshold * 100)}
									%)
								</>
							)}
							.
						</div>
					)}
				</div>
			)}
			{!capActive && (
				<p className="text-[11px] text-gray-500 italic">
					Pas de cap mensuel configuré (CALAME_RAG_MONTHLY_TOKEN_CAP).
				</p>
			)}

			{usage.perProvider.length > 0 && (
				<div className="space-y-1.5">
					<div className="eyebrow">Par fournisseur</div>
					<ul className="space-y-1">
						{usage.perProvider.map((p) => (
							<li
								key={p.model}
								className="flex items-center justify-between text-xs gap-2"
							>
								<span
									className="text-gray-300 truncate font-mono-plex"
									title={p.model}
								>
									{p.model || '(modèle inconnu)'}
									{!p.known && (
										<span
											className="ml-1 text-yellow-500/70"
											title="Tarif inconnu — coût non estimé"
										>
											?
										</span>
									)}
								</span>
								<span className="text-gray-400 flex-shrink-0">
									{compactNumber(p.tokens)}{' '}
									<span className="text-gray-500">
										({formatUsd(p.costUsd)})
									</span>
								</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{topSources.length > 0 && (
				<div className="space-y-1.5">
					<div className="eyebrow">Top sources</div>
					<ul className="space-y-1">
						{topSources.map((s) => (
							<li
								key={s.sourceId}
								className="flex items-center justify-between text-xs gap-2"
							>
								<span
									className="text-gray-300 truncate"
									title={s.name}
								>
									{s.name}
								</span>
								<span className="text-gray-400 flex-shrink-0">
									{compactNumber(s.tokens)}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{sparklineValues.length > 0 && (
				<div className="space-y-1.5">
					<div className="eyebrow">Activité quotidienne</div>
					<Sparkline values={sparklineValues} />
				</div>
			)}

			{usage.totalTokens === 0 && (
				<p className="text-xs text-gray-500 italic">
					Aucun embedding facturé sur la période. Les chiffres
					apparaîtront après la première synchronisation.
				</p>
			)}
		</div>
	);
}
