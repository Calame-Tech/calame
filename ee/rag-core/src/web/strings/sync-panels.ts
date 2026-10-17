// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { enPlural, frPlural, localized } from '../onboarding-strings.js';

const FR = {
  locale: 'fr-CA',
  // Shared job status labels
  statusPending: 'En attente',
  statusRunning: 'En cours',
  statusCompleted: 'Terminé',
  statusFailed: 'Échec',
  loadError: 'Erreur de chargement.',

  // Relative time
  relFewSeconds: 'il y a quelques secondes',
  relMinutes: (n: number) => `il y a ${n} min`,
  relHours: (n: number) => `il y a ${n} h`,
  relDays: (n: number) => `il y a ${n} j`,

  // SyncHistoryPanel
  jobRunning: 'en cours',
  back: '← Retour',
  backAria: 'Retour à la liste des sources',
  historyTitle: 'Historique des synchronisations',
  historySubtitle: (n: number) => `${n} dernières synchronisations, toutes sources confondues.`,
  refreshing: 'Actualisation…',
  refresh: 'Actualiser',
  colSource: 'Source',
  allSources: 'Toutes les sources',
  colStatus: 'Statut',
  filterAll: 'Tous',
  filterActive: 'Actif (en attente / en cours)',
  filterCompleted: 'Réussi',
  filterFailed: 'Échec',
  jobsShown: (shown: number, total: number) =>
    `${shown} synchronisation${shown > 1 ? 's' : ''} affichée${shown > 1 ? 's' : ''} / ${total}`,
  historyLoading: "Chargement de l'historique…",
  noJobs: 'Aucune synchronisation enregistrée.',
  noJobsMatch: 'Aucune synchronisation ne correspond aux filtres sélectionnés.',
  colStarted: 'Démarré',
  colDuration: 'Durée',
  colProgress: 'Progression',
  colError: 'Erreur',
  finishedAt: (when: string) => `Terminé : ${when}`,
  jobInProgress: 'Synchronisation en cours',
  documentsCount: (done: number, total: number) => `${done} / ${total} document${frPlural(total)}`,
  documentsDiscovering: 'Recherche des documents…',
  documentsNone: 'Aucun document trouvé',
  skippedEtag: (n: number) =>
    `${n} inchangé${frPlural(n)} depuis la dernière synchronisation, non réindexé${frPlural(n)}`,
  // Per-file sync report (CALAME-5)
  statusCompletedWithSkipped: (n: number) => `Terminé · ${n} ignoré${frPlural(n)}`,
  syncReport: (indexed: number, unchanged: number, rejected: number) =>
    `${indexed} indexé${indexed > 1 ? 's' : ''} · ${unchanged} inchangé${unchanged > 1 ? 's' : ''} · ${rejected} ignoré${rejected > 1 ? 's' : ''} / en erreur`,
  currentDocument: (path: string, seconds: number | null) =>
    seconds !== null && seconds >= 5
      ? `En cours : ${path} (depuis ${seconds} s)`
      : `En cours : ${path}`,
  rejectedFilesToggle: (n: number) =>
    n >= 2 ? `Voir les ${n} fichiers ignorés` : 'Voir le fichier ignoré',
  rejectedFilesTruncated: (shown: number, total: number) =>
    `${shown} premiers fichiers affichés sur ${total} (liste complète dans le journal).`,
  failureKindInfrastructure: "Échec global : stockage ou moteur d'embeddings indisponible",
  failureKindCap: "Échec global : plafond mensuel d'embeddings atteint",
  failureKindSource: 'Échec global : source inaccessible',
  rejectionKind: {
    parse_failed: 'Illisible ou corrompu',
    parse_timeout: 'Analyse trop longue (délai dépassé)',
    too_large: 'Trop volumineux',
    locked: 'Verrouillé (ouvert dans un autre programme)',
    unreadable: 'Accès impossible',
    unsupported: 'Format non pris en charge',
  } as Record<string, string>,

  // IngestionStatusCard
  ingestionLoading: 'Chargement des indexations…',
  ingestionNone: 'Aucune indexation en cours.',
  ingestionTitle: 'Indexation',
  jobsCount: (n: number) => `${n} indexation${n > 1 ? 's' : ''}`,

  // EmbeddingUsageCard
  period30: '30 derniers jours',
  period7: '7 derniers jours',
  periodAll: "depuis l'origine",
  noRecentActivity: 'Aucune activité récente.',
  activityPerDayAria: 'Activité par jour',
  usageLoading: 'Chargement de la consommation…',
  usageLoadFailed: 'Impossible de charger la consommation :',
  usageTitle: 'Consommation d’embeddings (analyse des documents)',
  tokens: (n: number): string => (n >= 2 ? 'jetons' : 'jeton'),
  tokensHelp:
    "Jeton (token) : petit morceau de texte, environ trois quarts de mot. C'est l'unité qui mesure et facture l'analyse des documents.",
  monthlyCap: 'Plafond mensuel',
  monthlyUsageAria: "Consommation mensuelle d'embeddings",
  capReached:
    "Plafond mensuel atteint. Les synchronisations vont échouer jusqu'à la fin du mois ou jusqu'à ce que le plafond soit relevé.",
  capNearing: 'Approche du plafond mensuel',
  capThreshold: (pct: number) => `(seuil ${pct}%)`,
  capNotConfigured: 'Aucun plafond mensuel configuré : la consommation n’est pas limitée.',
  perProvider: 'Par fournisseur',
  unknownModel: '(modèle inconnu)',
  unknownPrice: 'Tarif inconnu — coût non estimé',
  localTitle: "Traité sur cette machine — aucun coût d'API",
  localFree: 'local · gratuit',
  topSources: 'Sources qui consomment le plus',
  dailyActivity: 'Activité quotidienne',
  noBilledEmbeddings:
    'Aucun embedding facturé sur la période. Les chiffres apparaîtront après la première synchronisation.',

  // ReindexDialog
  reindexMigrationFailed: 'Échec de la migration.',
  reindexTitle: 'Migration des sources RAG',
  close: 'Fermer',
  reindexChecking: "Vérification de l'état de la migration…",
  reindexConfirmIntro:
    "Toutes les sources RAG existantes doivent utiliser le même modèle d'embeddings. Passer à",
  reindexConfirmNeeds: 'nécessite de',
  reindexPurge: 'purger et ré-indexer',
  reindexConfirmOutro: "l'intégralité des documents déjà indexés.",
  reindexBullet1: 'Les sources elles-mêmes (config, nom, planification) sont conservées.',
  reindexBullet2: 'Leur contenu indexé (documents, chunks) est effacé puis ré-ingéré depuis zéro.',
  reindexBullet3: 'Un redémarrage de Calame sera nécessaire pour terminer la migration.',
  reindexBullet4: 'La ré-indexation complète peut prendre plusieurs minutes selon le volume.',
  reindexConfirmBtn: 'Confirmer la migration',
  cancel: 'Annuler',
  reindexStarting: 'Purge et reconfiguration des sources en cours…',
  reindexUpToDate: "Déjà à jour — aucune migration n'était nécessaire.",
  reindexRestart: 'Redémarrez Calame pour terminer la migration.',
  reindexRestartDetail:
    'Les sources ont été reconfigurées et leur contenu purgé. La ré-indexation reprendra automatiquement au prochain démarrage.',
  reindexProgress: (done: number, total: number) =>
    `${done} / ${total} source${total > 1 ? 's' : ''} purgée${total > 1 ? 's' : ''} et reconfigurée${total > 1 ? 's' : ''}.`,
  reindexTenantLimit:
    "Il s'agit d'une limitation de l'index vectoriel partagé entre tenants — cette migration ne peut pas la contourner seule.",
  retry: 'Réessayer',
};

const EN: typeof FR = {
  locale: 'en-US',
  statusPending: 'Pending',
  statusRunning: 'Running',
  statusCompleted: 'Completed',
  statusFailed: 'Failed',
  loadError: 'Loading error.',

  relFewSeconds: 'a few seconds ago',
  relMinutes: (n: number) => `${n} min ago`,
  relHours: (n: number) => `${n} h ago`,
  relDays: (n: number) => `${n} d ago`,

  jobRunning: 'running',
  back: '← Back',
  backAria: 'Back to the source list',
  historyTitle: 'Sync history',
  historySubtitle: (n: number) => `Last ${n} sync jobs, across all sources.`,
  refreshing: 'Refreshing…',
  refresh: 'Refresh',
  colSource: 'Source',
  allSources: 'All sources',
  colStatus: 'Status',
  filterAll: 'All',
  filterActive: 'Active (pending / running)',
  filterCompleted: 'Succeeded',
  filterFailed: 'Failed',
  jobsShown: (shown: number, total: number) =>
    `${shown} job${shown > 1 ? 's' : ''} shown / ${total}`,
  historyLoading: 'Loading history…',
  noJobs: 'No sync jobs recorded.',
  noJobsMatch: 'No jobs match the selected filters.',
  colStarted: 'Started',
  colDuration: 'Duration',
  colProgress: 'Progress',
  colError: 'Error',
  finishedAt: (when: string) => `Finished: ${when}`,
  jobInProgress: 'Job in progress',
  documentsCount: (done: number, total: number) => `${done} / ${total} document${enPlural(total)}`,
  documentsDiscovering: 'Discovering documents…',
  documentsNone: 'No documents found',
  skippedEtag: (n: number) => `${n} unchanged since the last sync, not re-indexed`,
  statusCompletedWithSkipped: (n: number) => `Completed · ${n} skipped`,
  syncReport: (indexed: number, unchanged: number, rejected: number) =>
    `${indexed} indexed · ${unchanged} unchanged · ${rejected} skipped / failed`,
  currentDocument: (path: string, seconds: number | null) =>
    seconds !== null && seconds >= 5
      ? `Processing: ${path} (for ${seconds} s)`
      : `Processing: ${path}`,
  rejectedFilesToggle: (n: number) =>
    n === 1 ? 'Show the skipped file' : `Show ${n} skipped files`,
  rejectedFilesTruncated: (shown: number, total: number) =>
    `First ${shown} of ${total} files shown (full list in the log).`,
  failureKindInfrastructure: 'Global failure: storage or embedding engine unavailable',
  failureKindCap: 'Global failure: monthly embedding cap reached',
  failureKindSource: 'Global failure: source unreachable',
  rejectionKind: {
    parse_failed: 'Unreadable or corrupt',
    parse_timeout: 'Parsing took too long (timed out)',
    too_large: 'Too large',
    locked: 'Locked (open in another program)',
    unreadable: 'Access denied',
    unsupported: 'Unsupported format',
  } as Record<string, string>,

  ingestionLoading: 'Loading indexing jobs…',
  ingestionNone: 'No indexing jobs in progress.',
  ingestionTitle: 'Indexing',
  jobsCount: (n: number) => `${n} job${n > 1 ? 's' : ''}`,

  period30: 'last 30 days',
  period7: 'last 7 days',
  periodAll: 'since the beginning',
  noRecentActivity: 'No recent activity.',
  activityPerDayAria: 'Activity per day',
  usageLoading: 'Loading usage…',
  usageLoadFailed: 'Unable to load usage:',
  usageTitle: 'Embedding usage (document analysis)',
  tokens: (n: number) => (n === 1 ? 'token' : 'tokens'),
  tokensHelp:
    'Token: a small piece of text, about three quarters of a word. It is the unit used to measure and bill document analysis.',
  monthlyCap: 'Monthly cap',
  monthlyUsageAria: 'Monthly embedding usage',
  capReached:
    'Monthly cap reached. Syncs will fail until the end of the month or until the cap is raised.',
  capNearing: 'Approaching the monthly cap',
  capThreshold: (pct: number) => `(threshold ${pct}%)`,
  capNotConfigured: 'No monthly cap configured: usage is not limited.',
  perProvider: 'By provider',
  unknownModel: '(unknown model)',
  unknownPrice: 'Unknown pricing — cost not estimated',
  localTitle: 'Processed on this machine — no API cost',
  localFree: 'local · free',
  topSources: 'Top sources',
  dailyActivity: 'Daily activity',
  noBilledEmbeddings:
    'No billed embeddings in this period. Figures will appear after the first sync.',

  reindexMigrationFailed: 'Migration failed.',
  reindexTitle: 'RAG source migration',
  close: 'Close',
  reindexChecking: 'Checking migration status…',
  reindexConfirmIntro: 'All existing RAG sources must use the same embedding model. Switching to',
  reindexConfirmNeeds: 'requires you to',
  reindexPurge: 'purge and re-index',
  reindexConfirmOutro: 'all documents that are already indexed.',
  reindexBullet1: 'The sources themselves (config, name, schedule) are kept.',
  reindexBullet2:
    'Their indexed content (documents, chunks) is erased then re-ingested from scratch.',
  reindexBullet3: 'Calame must be restarted to complete the migration.',
  reindexBullet4: 'A full re-index can take several minutes depending on volume.',
  reindexConfirmBtn: 'Confirm migration',
  cancel: 'Cancel',
  reindexStarting: 'Purging and reconfiguring sources…',
  reindexUpToDate: 'Already up to date — no migration was needed.',
  reindexRestart: 'Restart Calame to complete the migration.',
  reindexRestartDetail:
    'Sources have been reconfigured and their content purged. Re-indexing will resume automatically on next startup.',
  reindexProgress: (done: number, total: number) =>
    `${done} / ${total} source${total === 1 ? '' : 's'} purged and reconfigured.`,
  reindexTenantLimit:
    'This is a limitation of the vector index shared across tenants — this migration cannot work around it on its own.',
  retry: 'Retry',
};

export const SYNC_PANELS_STRINGS = localized(FR, EN);
export const SYNC_PANELS_STRING_TABLES = { fr: FR, en: EN };
