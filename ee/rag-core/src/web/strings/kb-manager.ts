// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * User-facing strings of KnowledgeBaseManager, FolderTreeView and
 * DocumentUploader, in French and English (current locale resolved at access
 * time — see `localized` in onboarding-strings.ts).
 */
import { localized } from '../onboarding-strings.js';

const FR = {
  // Formatting
  never: 'Jamais',
  dateLocale: 'fr-CA',
  byteUnits: { b: 'o', kb: 'Kio', mb: 'Mio' },

  // Fallback errors
  loadError: 'Erreur de chargement.',
  syncFailed: 'Échec de la synchronisation.',
  deleteFailed: 'Échec de la suppression.',
  restoreFailed: 'Échec de la restauration.',
  uploadFailed: 'Échec du téléversement.',

  // Sync badge
  syncedRelative: (relative: string) => `Synchronisé ${relative}`,

  // Action messages
  sourceSaved: (name: string) => `Source "${name}" enregistrée.`,
  sourceUpdated: (name: string) => `Source "${name}" mise à jour.`,
  syncStarted: (name: string) => `Sync lancée pour "${name}".`,
  syncAlreadyRunningFor: (name: string) => `Sync déjà en cours pour "${name}".`,
  sourceSavedSyncStarted: (name: string) =>
    `Source "${name}" enregistrée. Synchronisation initiale lancée.`,
  initialSyncFailed: (name: string, message: string) =>
    `La source "${name}" est enregistrée, mais sa synchronisation initiale n'a pas pu démarrer : ${message}`,
  retrySync: 'Relancer la synchronisation',
  serverUnreachable: 'le serveur est injoignable.',
  syncCouldNotStart: (name: string, reason: string) =>
    `La synchronisation de "${name}" n'a pas pu démarrer : ${reason}`,
  nextStepProfile: (name: string) =>
    `Étape suivante : exposez "${name}" dans une configuration de données.`,
  createProfileFromSource: 'Créer une configuration de données avec cette source',
  sourceTrashed: (name: string, days: number) =>
    `Source "${name}" déplacée vers la corbeille (récupérable ${days} jours).`,
  sourceRestored: (name: string) => `Source "${name}" restaurée.`,
  sourcePurged: (name: string) => `Source "${name}" supprimée définitivement.`,

  // Confirmations
  confirmDelete: (name: string, days: number) =>
    `Supprimer la source "${name}" ? ` +
    `Elle sera déplacée vers la corbeille et conservée ${days} jours avant suppression définitive.`,
  confirmPurge: (name: string) =>
    `Supprimer DÉFINITIVEMENT la source "${name}" ? ` +
    `Cette action est IRRÉVERSIBLE — tous les documents, dossiers, chunks et historiques de sync seront perdus.`,

  // Trash view
  trashDescription: (days: number) =>
    `Sources supprimées au cours des ${days} derniers jours. Au-delà, elles sont définitivement effacées par le cron au prochain démarrage du serveur.`,
  back: '← Retour',
  trashEmpty: 'Aucune source dans la corbeille.',
  expiresNextMaintenance: 'expire à la prochaine maintenance',
  daysRemaining: (n: number) => `${n} jour${n > 1 ? 's' : ''} restant${n > 1 ? 's' : ''}`,
  deletedOn: (date: string) => `Supprimée ${date}`,
  restore: 'Restaurer',
  deletePermanently: 'Supprimer définitivement',

  // Header
  trashButtonTitle: (count: number, days: number) =>
    `${count} source(s) dans la corbeille — restaurables pendant ${days} jours`,
  syncHistory: 'Historique des synchronisations',
  syncHistoryTitle: "Voir l'historique complet des synchronisations",
  newSourceButton: '+ Nouvelle source',

  // Source list
  noSourcePrefix: 'Aucune source. Cliquez sur ',
  noSourceSuffix: ' pour en créer une.',
  configUnreadable: 'Configuration illisible',
  folderPath: (path: string) => `Dossier : ${path}`,
  counts: (docs: number, folders: number) =>
    `${docs} document${docs > 1 ? 's' : ''} · ${folders} dossier${folders > 1 ? 's' : ''}`,
  syncModeTitle: 'Mode de synchronisation automatique',
  open: 'Ouvrir',
  edit: 'Modifier',
  editSourceTitle: 'Modifier la configuration de cette source',
  resyncAria: (name: string) => `Synchroniser à nouveau la source ${name}`,
  resync: 'Synchroniser à nouveau',
  delete: 'Supprimer',

  // Detail panel
  lastSync: 'Dernière sync :',
  selectSource: 'Sélectionnez une source à gauche pour explorer son contenu.',

  // FolderTreeView
  syncStartedMessage: 'Synchronisation lancée.',
  loading: 'Chargement…',
  emptyFolder: 'Dossier vide.',
  unsupported: 'Non supporté',
  syncRunning: 'Synchronisation en cours…',
  syncingEllipsis: 'Synchronisation…',
  syncNow: 'Synchroniser',
  preparingSync: 'Préparation de la synchronisation…',
  syncProgressDetail: (processed: number, total: number, percent: number) =>
    `Synchronisation en cours : ${processed}/${total} (${percent}%)`,
  treeLoading: "Chargement de l'arborescence…",
  noIndexedFiles: 'Aucun fichier indexé pour le moment.',

  // DocumentUploader
  tooLarge: (size: string, max: string) => `Trop volumineux (${size} > ${max})`,
  unsupportedType: (type: string) => `Type non supporté (${type})`,
  unknownType: 'inconnu',
  noValidFile: 'Aucun fichier valide à téléverser.',
  uploaded: (n: number) => `${n} fichier${n > 1 ? 's' : ''} téléversé${n > 1 ? 's' : ''}.`,
  uploading: 'Téléversement…',
  dropHint: 'Glissez-déposez des fichiers ici, ou cliquez pour parcourir.',
  formatsHint: (max: string) => `PDF, DOCX, MD, CSV, TXT, HTML — ${max} max par fichier.`,
  selectFilesAria: 'Sélectionner des fichiers à téléverser',
  ignoredFiles: 'Fichiers ignorés :',
};

const EN: typeof FR = {
  never: 'Never',
  dateLocale: 'en-US',
  byteUnits: { b: 'B', kb: 'KiB', mb: 'MiB' },

  loadError: 'Loading error.',
  syncFailed: 'Sync failed.',
  deleteFailed: 'Deletion failed.',
  restoreFailed: 'Restore failed.',
  uploadFailed: 'Upload failed.',

  syncedRelative: (relative: string) => `Synced ${relative}`,

  sourceSaved: (name: string) => `Source "${name}" saved.`,
  sourceUpdated: (name: string) => `Source "${name}" updated.`,
  syncStarted: (name: string) => `Sync started for "${name}".`,
  syncAlreadyRunningFor: (name: string) => `Sync already in progress for "${name}".`,
  sourceSavedSyncStarted: (name: string) => `Source "${name}" saved. Initial sync started.`,
  initialSyncFailed: (name: string, message: string) =>
    `Source "${name}" is saved, but its initial sync could not start: ${message}`,
  retrySync: 'Retry sync',
  serverUnreachable: 'the server is unreachable.',
  syncCouldNotStart: (name: string, reason: string) =>
    `The sync of "${name}" could not start: ${reason}`,
  nextStepProfile: (name: string) => `Next step: expose "${name}" in a data configuration.`,
  createProfileFromSource: 'Create a data configuration with this source',
  sourceTrashed: (name: string, days: number) =>
    `Source "${name}" moved to the trash (recoverable for ${days} days).`,
  sourceRestored: (name: string) => `Source "${name}" restored.`,
  sourcePurged: (name: string) => `Source "${name}" permanently deleted.`,

  confirmDelete: (name: string, days: number) =>
    `Delete source "${name}"? ` +
    `It will be moved to the trash and kept for ${days} days before permanent deletion.`,
  confirmPurge: (name: string) =>
    `PERMANENTLY delete source "${name}"? ` +
    `This action is IRREVERSIBLE — all documents, folders, chunks and sync history will be lost.`,

  trashDescription: (days: number) =>
    `Sources deleted in the last ${days} days. After that, they are permanently erased by the cron job at the next server start.`,
  back: '← Back',
  trashEmpty: 'No sources in the trash.',
  expiresNextMaintenance: 'expires at the next maintenance',
  daysRemaining: (n: number) => `${n} day${n > 1 ? 's' : ''} left`,
  deletedOn: (date: string) => `Deleted ${date}`,
  restore: 'Restore',
  deletePermanently: 'Delete permanently',

  trashButtonTitle: (count: number, days: number) =>
    `${count} source(s) in the trash — restorable for ${days} days`,
  syncHistory: 'Sync history',
  syncHistoryTitle: 'View the full sync history',
  newSourceButton: '+ New source',

  noSourcePrefix: 'No sources. Click ',
  noSourceSuffix: ' to create one.',
  configUnreadable: 'Unreadable configuration',
  folderPath: (path: string) => `Folder: ${path}`,
  counts: (docs: number, folders: number) =>
    `${docs} document${docs > 1 ? 's' : ''} · ${folders} folder${folders > 1 ? 's' : ''}`,
  syncModeTitle: 'Automatic sync mode',
  open: 'Open',
  edit: 'Edit',
  editSourceTitle: "Edit this source's configuration",
  resyncAria: (name: string) => `Re-sync source ${name}`,
  resync: 'Re-sync',
  delete: 'Delete',

  lastSync: 'Last sync:',
  selectSource: 'Select a source on the left to explore its contents.',

  syncStartedMessage: 'Sync started.',
  loading: 'Loading…',
  emptyFolder: 'Empty folder.',
  unsupported: 'Unsupported',
  syncRunning: 'Sync in progress…',
  syncingEllipsis: 'Syncing…',
  syncNow: 'Sync',
  preparingSync: 'Preparing sync…',
  syncProgressDetail: (processed: number, total: number, percent: number) =>
    `Sync in progress: ${processed}/${total} (${percent}%)`,
  treeLoading: 'Loading the folder tree…',
  noIndexedFiles: 'No indexed files yet.',

  tooLarge: (size: string, max: string) => `Too large (${size} > ${max})`,
  unsupportedType: (type: string) => `Unsupported type (${type})`,
  unknownType: 'unknown',
  noValidFile: 'No valid file to upload.',
  uploaded: (n: number) => `${n} file${n > 1 ? 's' : ''} uploaded.`,
  uploading: 'Uploading…',
  dropHint: 'Drag and drop files here, or click to browse.',
  formatsHint: (max: string) => `PDF, DOCX, MD, CSV, TXT, HTML — ${max} max per file.`,
  selectFilesAria: 'Select files to upload',
  ignoredFiles: 'Ignored files:',
};

export const KB_MANAGER_STRINGS = localized(FR, EN);

/** Raw tables, for the fr/en key-parity test. */
export const KB_MANAGER_STRING_TABLES = { fr: FR, en: EN };
