// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * User-facing strings of the first-run source flow (knowledge-base list,
 * source form, loading / timeout states, "?" help tips, sync errors), in
 * French and English.
 *
 * rag-core has no i18n runtime and BUSL packages cannot value-import the
 * host's use-intl setup from `packages/web`, so the locale is resolved the
 * same way as the host (`packages/web/src/i18n/locale.ts`): the saved
 * `calame-locale` choice, else the browser language, else English. Strings
 * not listed here (S3 / HTTP / Google / Notion / SharePoint connector fields,
 * remote-embedding notices, trash, reindex and confirmation dialogs…) are
 * still French-only inline.
 */
type Locale = 'en' | 'fr';

/** Mirrors resolveInitialLocale() in packages/web/src/i18n/locale.ts. */
export function ragLocale(): Locale {
  try {
    const saved = localStorage.getItem('calame-locale');
    if (saved === 'en' || saved === 'fr') return saved;
  } catch {
    // Storage unavailable — fall back to the browser language.
  }
  const lang = typeof navigator !== 'undefined' ? navigator.language : undefined;
  return lang?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

const FR = {
  timeout: (seconds: number) => `Le serveur n'a pas répondu après ${seconds} s.`,
  retry: 'Réessayer',
  save: 'Enregistrer',
  saving: 'Enregistrement…',

  // KnowledgeBaseManager — list
  kbTitle: 'Bases de connaissances',
  kbDescription: 'Configurez les sources documentaires qui alimentent le RAG.',
  editSourceAria: (name: string) => `Modifier la source ${name}`,
  watchLive: 'Surveillance en direct',
  watchPlusPolling: (minutes: number) => `Surveillance + interrogation ${minutes} min`,
  pollingEvery: (minutes: number) => `Interrogation ${minutes} min`,
  manualOnly: 'Manuel uniquement',
  unknownError: 'Erreur inconnue',
  lastSyncFailedAria: (error: string) => `Échec de la dernière sync : ${error}`,
  lastSyncFailed: 'Échec de la dernière sync',
  syncing: 'Synchronisation en cours',
  neverSynced: 'Jamais synchronisé',
  syncAlreadyRunning: 'Synchronisation déjà en cours',
  startManualSync: 'Lancer une synchronisation manuelle',
  trash: 'Corbeille',
  trashCount: (count: number) => `Corbeille (${count})`,
  purgeFailed: 'Échec de la suppression définitive.',
  uploadFiles: 'Téléverser des fichiers',

  // SourceForm — labels
  editSource: 'Modifier la source',
  newSource: 'Nouvelle source',
  sourceNameLabel: 'Nom de la source',
  localFolderType: 'Local (dossier)',
  comingSoon: ' — Bientôt',
  advancedOptional: 'Avancé (optionnel)',
  pollingLabel: 'Intervalle de synchronisation auto',
  close: 'Fermer',
  cancel: 'Annuler',
  typeLabel: 'Type',
  typeImmutable: "Le type d'une source ne peut pas être modifié après création.",
  browse: 'Parcourir…',
  browsing: 'Ouverture…',
  browseTitle: 'Ouvrir le sélecteur de dossier natif sur la machine du serveur',
  folderPickerUnavailable: 'Sélecteur de dossier indisponible.',
  typePathManually: 'Vous pouvez toujours saisir le chemin manuellement.',
  test: 'Tester',
  testConnection: 'Tester la connexion',
  testing: 'Test…',
  testSucceeded: 'Connexion validée.',
  testFailed: 'Échec du test.',
  saveFailed: "Échec de l'enregistrement.",
  includeHidden: 'Inclure les fichiers cachés',
  embeddingLabel: "Configuration d'embeddings",
  selectEmbedding: 'Sélectionner une configuration IA…',
  localEmbeddingSuffix: ' — inclus, 100 % local',
  modelLabel: 'Modèle :',
  dimensionsLabel: 'Dimensions :',
  nameRequired: 'Le nom de la source est requis.',
  rootPathRequired: 'Le chemin du dossier est requis.',
  embeddingRequired: 'Sélectionnez une configuration IA pour les embeddings.',
  embeddingUnsupported: 'La configuration IA sélectionnée ne supporte pas les embeddings.',
  polling: {
    off: 'Désactivé (sync manuelle uniquement)',
    every5min: 'Toutes les 5 minutes',
    every15min: 'Toutes les 15 minutes',
    hourly: 'Toutes les heures',
    every6h: 'Toutes les 6 heures',
    daily: 'Tous les jours',
  },
  rootPathLabel: 'Chemin absolu du dossier',
  includeGlobs: 'Globs à inclure',
  excludeGlobs: 'Globs à exclure',
  includeGlobsPathname: 'Globs à inclure (chemin d’URL)',
  excludeGlobsPathname: 'Globs à exclure (chemin d’URL)',

  // Sync job errors (server messages, see runSyncJob in routes/rag-index.ts)
  jobFailed: (failed: string, total: string, last: string) =>
    `${failed} document(s) sur ${total} en échec ; dernière erreur : ${last}`,
  jobUnsupported: (count: string) =>
    `${count} document(s) ignoré(s) — format non pris en charge. Convertissez-les en PDF/DOCX/MD/TXT.`,
  jobTooLarge: (count: string) =>
    `${count} document(s) ignoré(s) — plus gros que la taille maximale de la source. Augmentez la limite ou découpez le fichier.`,

  // KnowledgeBaseManager
  sourcesLoading: 'Chargement des sources…',
  sourcesLoadError: 'Impossible de charger les sources.',
  syncProgress: (processed: number, total: number) => ` (${processed} / ${total} documents)`,

  // SourceForm — save / test outcomes
  saveMissingSource: "Le serveur n'a pas renvoyé la source enregistrée. Rechargez la liste.",
  saveTimeout: (seconds: number) =>
    `Le serveur n'a pas répondu après ${seconds} s. La source a peut-être été enregistrée malgré ` +
    'tout : annulez pour vérifier la liste avant de réessayer.',
  testTimeout: (seconds: number) =>
    `Le test n'a pas abouti après ${seconds} s. Vérifiez que le serveur peut atteindre cette ` +
    'source (chemin réseau, URL, identifiants) puis relancez le test.',
  savingHint:
    "Le serveur vérifie l'accès à la source avant de l'enregistrer — cela peut prendre quelques " +
    'secondes.',
  folderPickerWaiting:
    "En attente du sélecteur de dossier du système — il peut s'ouvrir derrière la fenêtre de " +
    'Calame. Vous pouvez aussi saisir le chemin manuellement.',

  // SourceForm — secondary explanations folded behind "?"
  help: {
    rootPath:
      'Le serveur doit pouvoir lire ce chemin. Les fichiers ajoutés ultérieurement sont indexés à ' +
      'la prochaine synchronisation.',
    globsInclude: 'Une glob par ligne. Vide = tout inclure.',
    globsExclude: 'Une glob par ligne.',
    localGlobsExclude:
      'Une glob par ligne, ajoutée aux exclusions par défaut (node_modules, .git).',
    includeHidden:
      'Fichiers et dossiers commençant par un point (.env, .cache…), exclus par défaut. Les ' +
      'fichiers de plus de 50 Mo sont toujours ignorés.',
    s3Region: "Utilisez 'auto' pour Cloudflare R2.",
    s3Prefix: 'Racine logique dans le bucket. Laisser vide pour tout le bucket.',
    s3Endpoint: 'Pour R2 / MinIO. Laisser vide pour AWS S3 standard.',
    s3ForcePathStyle: 'Requis pour MinIO. Désactiver pour AWS S3 et Cloudflare R2.',
    httpUrls: 'Une URL http(s):// par ligne.',
    httpSitemap: 'Le connecteur télécharge le XML et indexe chaque entrée <loc>.',
    httpUserAgent: 'Envoyé dans chaque requête HTTP.',
    httpTimeout: 'Min 1 000 ms, max 60 000 ms. Défaut : 10 000.',
    httpGlobsInclude: "Appliqués au pathname de l'URL. Vide = tout inclure.",
    localEmbeddings:
      'Traitement 100 % local — vos documents et vos requêtes ne quittent jamais cet ordinateur. ' +
      "Pour un corpus très volumineux ou une qualité maximale, vous pouvez configurer votre propre fournisseur d'embeddings dans « AI Settings ».",
    polling:
      'Choisissez la fréquence à laquelle la source est interrogée pour détecter les changements. ' +
      'La synchronisation manuelle reste toujours disponible.',
  },
};

const EN: typeof FR = {
  timeout: (seconds: number) => `The server did not answer after ${seconds} s.`,
  retry: 'Retry',
  save: 'Save',
  saving: 'Saving…',

  kbTitle: 'Knowledge bases',
  kbDescription: 'Configure the document sources that feed retrieval (RAG).',
  editSourceAria: (name: string) => `Edit source ${name}`,
  watchLive: 'Live watch',
  watchPlusPolling: (minutes: number) => `Watch + polling ${minutes} min`,
  pollingEvery: (minutes: number) => `Polling ${minutes} min`,
  manualOnly: 'Manual only',
  unknownError: 'Unknown error',
  lastSyncFailedAria: (error: string) => `Last sync failed: ${error}`,
  lastSyncFailed: 'Last sync failed',
  syncing: 'Sync in progress',
  neverSynced: 'Never synced',
  syncAlreadyRunning: 'Sync already in progress',
  startManualSync: 'Start a manual sync',
  trash: 'Trash',
  trashCount: (count: number) => `Trash (${count})`,
  purgeFailed: 'Permanent deletion failed.',
  uploadFiles: 'Upload files',

  editSource: 'Edit source',
  newSource: 'New source',
  sourceNameLabel: 'Source name',
  localFolderType: 'Local (folder)',
  comingSoon: ' — Coming soon',
  advancedOptional: 'Advanced (optional)',
  pollingLabel: 'Automatic sync interval',
  close: 'Close',
  cancel: 'Cancel',
  typeLabel: 'Type',
  typeImmutable: "A source's type cannot be changed after creation.",
  browse: 'Browse…',
  browsing: 'Opening…',
  browseTitle: "Open the native folder picker on the server's machine",
  folderPickerUnavailable: 'Folder picker unavailable.',
  typePathManually: 'You can still type the path manually.',
  test: 'Test',
  testConnection: 'Test connection',
  testing: 'Testing…',
  testSucceeded: 'Connection verified.',
  testFailed: 'Test failed.',
  saveFailed: 'Save failed.',
  includeHidden: 'Include hidden files',
  embeddingLabel: 'Embedding configuration',
  selectEmbedding: 'Select an AI configuration…',
  localEmbeddingSuffix: ' — built in, 100% local',
  modelLabel: 'Model:',
  dimensionsLabel: 'Dimensions:',
  nameRequired: 'The source name is required.',
  rootPathRequired: 'The folder path is required.',
  embeddingRequired: 'Select an AI configuration for embeddings.',
  embeddingUnsupported: 'The selected AI configuration does not support embeddings.',
  polling: {
    off: 'Off (manual sync only)',
    every5min: 'Every 5 minutes',
    every15min: 'Every 15 minutes',
    hourly: 'Every hour',
    every6h: 'Every 6 hours',
    daily: 'Every day',
  },
  rootPathLabel: 'Absolute folder path',
  includeGlobs: 'Include globs',
  excludeGlobs: 'Exclude globs',
  includeGlobsPathname: 'Include globs (URL path)',
  excludeGlobsPathname: 'Exclude globs (URL path)',

  jobFailed: (failed: string, total: string, last: string) =>
    `${failed} of ${total} document(s) failed; last error: ${last}`,
  jobUnsupported: (count: string) =>
    `${count} document(s) skipped — unsupported format. Convert them to PDF/DOCX/MD/TXT.`,
  jobTooLarge: (count: string) =>
    `${count} document(s) skipped — larger than the source's max file size. Raise the limit or split the file.`,

  sourcesLoading: 'Loading sources…',
  sourcesLoadError: 'Could not load the sources.',
  syncProgress: (processed: number, total: number) => ` (${processed} / ${total} documents)`,

  saveMissingSource: 'The server did not return the saved source. Reload the list.',
  saveTimeout: (seconds: number) =>
    `The server did not answer after ${seconds} s. The source may have been saved anyway: ` +
    'cancel and check the list before retrying.',
  testTimeout: (seconds: number) =>
    `The test did not complete after ${seconds} s. Check that the server can reach this ` +
    'source (network path, URL, credentials), then run the test again.',
  savingHint:
    'The server checks it can access the source before saving it — this can take a few seconds.',
  folderPickerWaiting:
    "Waiting for the system folder picker — it may open behind Calame's window. You can also " +
    'type the path manually.',

  help: {
    rootPath:
      'The server must be able to read this path. Files added later are indexed at the next sync.',
    globsInclude: 'One glob per line. Empty = include everything.',
    globsExclude: 'One glob per line.',
    localGlobsExclude: 'One glob per line, added to the default exclusions (node_modules, .git).',
    includeHidden:
      'Files and folders starting with a dot (.env, .cache…), excluded by default. Files over ' +
      '50 MB are always skipped.',
    s3Region: "Use 'auto' for Cloudflare R2.",
    s3Prefix: 'Logical root inside the bucket. Leave empty for the whole bucket.',
    s3Endpoint: 'For R2 / MinIO. Leave empty for standard AWS S3.',
    s3ForcePathStyle: 'Required for MinIO. Turn off for AWS S3 and Cloudflare R2.',
    httpUrls: 'One http(s):// URL per line.',
    httpSitemap: 'The connector downloads the XML and indexes every <loc> entry.',
    httpUserAgent: 'Sent with every HTTP request.',
    httpTimeout: 'Min 1,000 ms, max 60,000 ms. Default: 10,000.',
    httpGlobsInclude: 'Applied to the URL pathname. Empty = include everything.',
    localEmbeddings:
      'Processed 100% locally — your documents and queries never leave this computer. For a ' +
      'very large corpus or maximum quality, you can configure your own embedding provider in ' +
      '"AI Settings".',
    polling: 'Choose how often the source is checked for changes. Manual sync is always available.',
  },
};

/** Strings in the current locale — read at access time, so a locale change applies on next render. */
export const RAG_STRINGS: typeof FR = new Proxy(FR, {
  get: (_target, key) => (ragLocale() === 'fr' ? FR : EN)[key as keyof typeof FR],
});

/**
 * Translates the sync-job error formats written by runSyncJob
 * (routes/rag-index.ts). Unknown messages (connector / parser errors) are
 * returned unchanged rather than guessed.
 */
export function translateJobError(error: string): string {
  const failed = /^(\d+)\/(\d+) failed; last: ([\s\S]*)$/.exec(error);
  if (failed) return RAG_STRINGS.jobFailed(failed[1], failed[2], failed[3]);
  const unsupported = /^(\d+) doc\(s\) skipped — unsupported format\./.exec(error);
  if (unsupported) return RAG_STRINGS.jobUnsupported(unsupported[1]);
  const tooLarge = /^(\d+) doc\(s\) skipped — larger than the source's max file size\./.exec(error);
  if (tooLarge) return RAG_STRINGS.jobTooLarge(tooLarge[1]);
  return error;
}
