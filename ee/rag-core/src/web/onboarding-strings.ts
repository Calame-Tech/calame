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

/** Plural suffix for a count (string or number): French treats 0 and 1 as singular. */
export const frPlural = (n: string | number): string => (Number(n) >= 2 ? 's' : '');
export const enPlural = (n: string | number): string => (Number(n) === 1 ? '' : 's');

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
  kbDescription:
    'Ajoutez les dossiers et documents que vos assistants IA pourront consulter. Chaque source est indexée pour la recherche documentaire (RAG).',
  editSourceAria: (name: string) => `Modifier la source ${name}`,
  watchLive: 'Surveillance en direct',
  watchPlusPolling: (minutes: number) =>
    `Surveillance en direct + vérification toutes les ${minutes} min`,
  pollingEvery: (minutes: number) => `Vérification toutes les ${minutes} min`,
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
  embeddingLabel: "Modèle d'analyse des documents (embeddings)",
  selectEmbedding: 'Sélectionner une configuration IA…',
  /** Display name of the built-in local embedding setting (seeded label, see local-embedding-meta.ts). */
  localEmbeddingName: 'Embeddings locaux (inclus)',
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
  includeGlobs: 'Fichiers à inclure (motifs glob)',
  excludeGlobs: 'Fichiers à exclure (motifs glob)',
  includeGlobsPathname: 'Pages à inclure (motifs glob sur le chemin d’URL)',
  excludeGlobsPathname: 'Pages à exclure (motifs glob sur le chemin d’URL)',

  // Sync job errors (server messages, see runSyncJob in routes/rag-index.ts)
  jobFailed: (failed: string, total: string, last: string) =>
    `${failed} document${frPlural(failed)} sur ${total} en échec ; dernière erreur : ${last}`,
  jobUnsupported: (count: string) =>
    `${count} document${frPlural(count)} ignoré${frPlural(count)} — format non pris en charge. Convertissez en PDF/DOCX/MD/TXT.`,
  jobTooLarge: (count: string) =>
    `${count} document${frPlural(count)} ignoré${frPlural(count)} — plus gros que la taille maximale de la source. Augmentez la limite ou découpez le fichier.`,
  jobSkipped: (count: string, last: string) =>
    `${count} fichier${frPlural(count)} ignoré${frPlural(count)} (illisible, corrompu, trop gros ou verrouillé) ; dernier : ${last}`,
  unsupportedFile: (file: string, mime: string) => `${file} : format non pris en charge (${mime})`,
  connectorValidationFailed: (detail: string) =>
    `La vérification de la source a échoué : ${detail}`,
  localRootMissing: (root: string) =>
    `Le dossier « ${root} » est introuvable. Vérifiez le chemin (lettre de lecteur, partage réseau) ` +
    "et que le dossier n'a pas été déplacé ou renommé.",
  localRootNotDirectory: (root: string) =>
    `« ${root} » n'est pas un dossier. Indiquez le dossier qui contient les documents.`,
  localRootNotReadable: (root: string, code: string) =>
    `Le dossier « ${root} » n'est pas lisible par Calame (${code}). Vérifiez les droits d'accès ` +
    'ou que le partage réseau est connecté.',

  // KnowledgeBaseManager
  sourcesLoading: 'Chargement des sources…',
  sourcesLoadError: 'Impossible de charger les sources.',
  serverUnreachable: 'le serveur Calame ne répond pas',
  sourcesRefreshing: 'Synchronisation de la liste des sources…',
  sourcesRefreshError: (detail: string) =>
    `Impossible de rafraîchir la liste des sources (${detail}). Dernière liste connue affichée.`,
  syncProgress: (processed: number, total: number) =>
    ` (${processed} / ${total} document${frPlural(total)})`,

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
    globsInclude:
      'Un motif par ligne, par exemple **/*.pdf pour tous les PDF. Vide = tout inclure.',
    globsExclude: 'Un motif par ligne, par exemple **/brouillons/** pour ignorer un dossier.',
    localGlobsExclude:
      'Un motif par ligne, par exemple **/brouillons/**, ajouté aux exclusions par défaut (node_modules, .git).',
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
      'Le modèle transforme le texte en vecteurs (embeddings) pour retrouver les passages pertinents. ' +
      'Traitement 100 % local — vos documents et vos requêtes ne quittent jamais cet ordinateur. ' +
      "Pour un corpus très volumineux ou une qualité maximale, vous pouvez configurer votre propre fournisseur d'embeddings dans « Paramètres IA ».",
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
  kbDescription:
    'Add the folders and documents your AI assistants can consult. Each source is indexed for document search (RAG).',
  editSourceAria: (name: string) => `Edit source ${name}`,
  watchLive: 'Live watch',
  watchPlusPolling: (minutes: number) => `Live watch + check every ${minutes} min`,
  pollingEvery: (minutes: number) => `Check every ${minutes} min`,
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
  embeddingLabel: 'Document analysis model (embeddings)',
  selectEmbedding: 'Select an AI configuration…',
  localEmbeddingName: 'Local embeddings (built in)',
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
  includeGlobs: 'Files to include (glob patterns)',
  excludeGlobs: 'Files to exclude (glob patterns)',
  includeGlobsPathname: 'Pages to include (glob patterns on the URL path)',
  excludeGlobsPathname: 'Pages to exclude (glob patterns on the URL path)',

  jobFailed: (failed: string, total: string, last: string) =>
    `${failed} of ${total} document${enPlural(total)} failed; last error: ${last}`,
  jobUnsupported: (count: string) =>
    `${count} document${enPlural(count)} skipped — unsupported format. Convert to PDF/DOCX/MD/TXT.`,
  jobTooLarge: (count: string) =>
    `${count} document${enPlural(count)} skipped — larger than the source's max file size. Raise the limit or split the file.`,
  jobSkipped: (count: string, last: string) =>
    `${count} file${enPlural(count)} skipped (unreadable, corrupt, too large or locked); last: ${last}`,
  unsupportedFile: (file: string, mime: string) => `${file}: unsupported format (${mime})`,
  connectorValidationFailed: (detail: string) => `Source check failed: ${detail}`,
  localRootMissing: (root: string) =>
    `Folder "${root}" was not found. Check the path (drive letter, network share) and that the ` +
    'folder has not been moved or renamed.',
  localRootNotDirectory: (root: string) =>
    `"${root}" is not a folder. Enter the folder that contains the documents.`,
  localRootNotReadable: (root: string, code: string) =>
    `Folder "${root}" cannot be read by Calame (${code}). Check the access rights or that the ` +
    'network share is connected.',

  sourcesLoading: 'Loading sources…',
  sourcesLoadError: 'Could not load the sources.',
  serverUnreachable: 'the Calame server is not responding',
  sourcesRefreshing: 'Syncing the source list…',
  sourcesRefreshError: (detail: string) =>
    `Could not refresh the source list (${detail}). Showing the last known list.`,
  syncProgress: (processed: number, total: number) =>
    ` (${processed} / ${total} document${enPlural(total)})`,

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
    globsInclude: 'One pattern per line, e.g. **/*.pdf for all PDFs. Empty = include everything.',
    globsExclude: 'One pattern per line, e.g. **/drafts/** to skip a folder.',
    localGlobsExclude:
      'One pattern per line, e.g. **/drafts/**, added to the default exclusions (node_modules, .git).',
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
      'The model turns text into vectors (embeddings) to find the relevant passages. ' +
      'Processed 100% locally — your documents and queries never leave this computer. For a ' +
      'very large corpus or maximum quality, you can configure your own embedding provider in ' +
      '"AI Settings".',
    polling: 'Choose how often the source is checked for changes. Manual sync is always available.',
  },
};

/**
 * Strings in the current locale — read at access time, so a locale change
 * applies on next render. Shared by every rag-core view's string table.
 */
export function localized<T extends object>(fr: T, en: T): T {
  return new Proxy(fr, {
    get: (_target, key) => (ragLocale() === 'fr' ? fr : en)[key as keyof T],
  });
}

export const RAG_STRINGS: typeof FR = localized(FR, EN);

/** Raw tables, for the fr/en key-parity test. */
export const RAG_STRING_TABLES = { fr: FR, en: EN };

/**
 * Translates the sync-job error formats written by runSyncJob
 * (routes/rag-index.ts). Unknown messages (connector / parser errors) are
 * returned unchanged rather than guessed.
 */
export function translateJobError(error: string): string {
  const validation = /^Connector validation failed: ([\s\S]*)$/.exec(error);
  if (validation) return RAG_STRINGS.connectorValidationFailed(translateJobError(validation[1]));
  // Local-folder root checks (LOCAL_ROOT_ERRORS in rag-connectors/src/local-folder.ts).
  const missing = /^Local folder "([\s\S]*)" does not exist\.$/.exec(error);
  if (missing) return RAG_STRINGS.localRootMissing(missing[1]);
  const notDir = /^Local folder "([\s\S]*)" is not a folder\.$/.exec(error);
  if (notDir) return RAG_STRINGS.localRootNotDirectory(notDir[1]);
  const notReadable = /^Local folder "([\s\S]*)" is not readable \(([^)]*)\)\.$/.exec(error);
  if (notReadable) return RAG_STRINGS.localRootNotReadable(notReadable[1], notReadable[2]);
  const failed = /^(\d+)\/(\d+) failed; last: ([\s\S]*)$/.exec(error);
  if (failed) return RAG_STRINGS.jobFailed(failed[1], failed[2], translateJobError(failed[3]));
  const unsupported = /^(\d+) doc\(s\) skipped — unsupported format\./.exec(error);
  if (unsupported) return RAG_STRINGS.jobUnsupported(unsupported[1]);
  const tooLarge = /^(\d+) doc\(s\) skipped — larger than the source's max file size\./.exec(error);
  if (tooLarge) return RAG_STRINGS.jobTooLarge(tooLarge[1]);
  const skipped = /^(\d+) doc\(s\) skipped(?: so far)?; last: ([\s\S]*)$/.exec(error);
  if (skipped) return RAG_STRINGS.jobSkipped(skipped[1], translateJobError(skipped[2]));
  // Per-file UnsupportedMimeTypeError (rag-core/src/parsers/index.ts), prefixed with the file.
  const unsupportedFile = /^([\s\S]+): No RAG parser is registered for MIME type "([^"]*)"\.$/.exec(
    error,
  );
  if (unsupportedFile) return RAG_STRINGS.unsupportedFile(unsupportedFile[1], unsupportedFile[2]);
  return error;
}
