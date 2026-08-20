// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useEffect, useState } from 'react';
import {
  apiGet,
  apiPost,
  ApiError,
  type RagReindexJobPublic,
  type RagReindexStartResponse,
  type RagReindexStatusResponse,
} from './api.js';

interface ReindexDialogProps {
  /** The embedding setting every existing source should be migrated to. */
  targetSettingName: string;
  /** Human label for display, e.g. "Embeddings locaux (inclus)". Falls back to the raw name. */
  targetLabel?: string;
  onClose: () => void;
  /** Called once the migration is confirmed started (or was already a no-op) — lets the caller refresh its own source list. */
  onStarted?: () => void;
}

type Step =
  | { kind: 'loading' }
  | { kind: 'confirm' }
  | { kind: 'starting' }
  | { kind: 'no-op'; message: string }
  | { kind: 'awaiting-restart'; job: RagReindexJobPublic | null }
  | { kind: 'error'; message: string; code?: string };

/**
 * Triggered from the 409 dimension-conflict path in SourceForm — lets the
 * user migrate every existing RAG source to a new embedding dimension
 * instead of hitting a dead end. See routes/rag-reindex.ts for the full
 * purge → reconfigure → rebuild-index → restart sequence this drives.
 */
export default function ReindexDialog({
  targetSettingName,
  targetLabel,
  onClose,
  onStarted,
}: ReindexDialogProps) {
  const [step, setStep] = useState<Step>({ kind: 'loading' });

  // On mount, check whether a migration is already underway/finished for
  // this tenant (e.g. the dialog was closed and reopened) rather than always
  // forcing the user back through the confirmation step.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<RagReindexStatusResponse>('/api/rag/reindex/status');
        if (cancelled) return;
        if (data.job && data.job.status === 'awaiting-restart') {
          setStep({ kind: 'awaiting-restart', job: data.job });
        } else {
          setStep({ kind: 'confirm' });
        }
      } catch {
        if (cancelled) return;
        setStep({ kind: 'confirm' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConfirm = async () => {
    setStep({ kind: 'starting' });
    try {
      const result = await apiPost<RagReindexStartResponse>('/api/rag/reindex', {
        targetSettingName,
        confirm: true,
      });
      if (result.reindexed) {
        setStep({ kind: 'awaiting-restart', job: result.job });
      } else {
        setStep({ kind: 'no-op', message: result.message });
      }
      onStarted?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setStep({
          kind: 'error',
          message: err.message,
          code: err.code,
        });
      } else {
        setStep({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Échec de la migration.',
        });
      }
    }
  };

  const label = targetLabel ?? targetSettingName;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      aria-modal="true"
      role="dialog"
      aria-labelledby="reindex-dialog-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && step.kind !== 'starting') onClose();
      }}
    >
      <div className="relative w-full max-w-md mx-4 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 id="reindex-dialog-title" className="text-base font-semibold text-gray-100">
            Migration des sources RAG
          </h2>
          {step.kind !== 'starting' && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Fermer"
              className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-5 h-5"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {step.kind === 'loading' && (
          <p className="text-sm text-gray-500">Vérification de l'état de la migration…</p>
        )}

        {step.kind === 'confirm' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-300">
              Toutes les sources RAG existantes doivent utiliser le même modèle d'embeddings.
              Passer à <span className="font-medium text-gray-100">{label}</span> nécessite de{' '}
              <span className="font-medium text-red-400">purger et ré-indexer</span> l'intégralité
              des documents déjà indexés.
            </p>
            <ul className="text-xs text-gray-500 list-disc pl-4 space-y-1">
              <li>Les sources elles-mêmes (config, nom, planification) sont conservées.</li>
              <li>Leur contenu indexé (documents, chunks) est effacé puis ré-ingéré depuis zéro.</li>
              <li>Un redémarrage de Calame sera nécessaire pour terminer la migration.</li>
              <li>La ré-indexation complète peut prendre plusieurs minutes selon le volume.</li>
            </ul>
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => void handleConfirm()}
                className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm font-medium transition-all duration-200"
              >
                Confirmer la migration
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200"
              >
                Annuler
              </button>
            </div>
          </div>
        )}

        {step.kind === 'starting' && (
          <p className="text-sm text-gray-400">Purge et reconfiguration des sources en cours…</p>
        )}

        {step.kind === 'no-op' && (
          <div className="space-y-4">
            <p className="text-sm text-green-400">
              Déjà à jour — aucune migration n'était nécessaire.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200"
            >
              Fermer
            </button>
          </div>
        )}

        {step.kind === 'awaiting-restart' && (
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-800/50">
              <p className="text-sm text-amber-300 font-medium">
                Redémarrez Calame pour terminer la migration.
              </p>
              <p className="text-xs text-amber-400/80 mt-1">
                Les sources ont été reconfigurées et leur contenu purgé. La ré-indexation reprendra
                automatiquement au prochain démarrage.
              </p>
            </div>
            {step.job && (
              <p className="text-xs text-gray-500">
                {step.job.processedSources} / {step.job.totalSources} source(s) purgée(s) et
                reconfigurée(s).
              </p>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200"
            >
              Fermer
            </button>
          </div>
        )}

        {step.kind === 'error' && (
          <div className="space-y-4">
            <div className="p-2.5 rounded-lg text-sm bg-red-950/30 border border-red-800/50 text-red-400">
              <p>{step.message}</p>
              {step.code === 'other-tenants-have-chunks' && (
                <p className="text-xs text-red-300 opacity-80 mt-1">
                  Il s'agit d'une limitation de l'index vectoriel partagé entre tenants — cette
                  migration ne peut pas la contourner seule.
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep({ kind: 'confirm' })}
                className="px-4 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200"
              >
                Réessayer
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 text-gray-300 text-sm font-medium transition-all duration-200"
              >
                Fermer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
