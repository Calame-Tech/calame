// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { localized } from '../onboarding-strings.js';

/** Strings of SourceForm. JSX fragments around inline elements are split in `*Before` / `*After`. */
const FR = {
  // Service account key validation
  saInvalidJson: 'JSON invalide.',
  saNotObject: 'Doit être un objet JSON.',
  saMissingClientEmail: 'Champ `client_email` manquant.',
  saMissingPrivateKey: 'Champ `private_key` manquant.',

  // Form validation
  s3BucketRequired: 'Le nom du bucket S3 est requis.',
  s3RegionRequired: 'La région S3 est requise.',
  accessKeyIdRequired: "L'Access Key ID est requis.",
  secretAccessKeyRequired: 'Le Secret Access Key est requis.',
  urlRequired: 'Saisissez au moins une URL.',
  invalidUrls: (n: number) => `${n} URL(s) invalide(s) — vérifiez le format http(s)://.`,
  sitemapUrlRequired: "L'URL du sitemap est requise.",
  sitemapUrlInvalid: "L'URL du sitemap doit être une URL http(s):// valide.",
  gdriveFolderIdRequired: "L'ID du dossier Google Drive est requis.",
  pasteServiceAccountKey: 'Collez la clé JSON du Service Account.',
  serviceAccountJsonInvalid: (detail: string) => `Service Account JSON invalide : ${detail}`,
  spreadsheetIdRequired: 'Renseignez au moins un ID de Google Sheet.',
  driveFolderIdRequired: "L'ID du dossier Drive est requis.",
  notionSecretRequired: "Le secret de l'intégration Notion est requis.",
  notionKeyPrefix: 'La clé Notion doit commencer par `secret_` ou `ntn_`.',
  tenantIdRequired: "L'ID du tenant Azure AD est requis.",
  clientIdRequired: "L'ID de l'application (client ID) est requis.",
  clientSecretRequired: "Le client secret de l'application est requis.",
  siteUrlRequired: "L'URL du site SharePoint est requise.",
  embeddingDimensionConflict:
    "Toutes les sources RAG doivent utiliser le même modèle d'embeddings (dimension fixe). " +
    'Réessaie avec une config IA dont le modèle a la même dimension que les sources existantes.',

  // Common
  namePlaceholder: 'Documentation produit',
  unchanged: '(inchangé)',
  keepExistingKey: 'Laissez vide pour conserver la clé existante.',
  keepSavedKey: 'Laissez vide pour conserver la clé enregistrée.',
  keepExistingSecret: 'Laissez vide pour conserver le secret existant.',
  saSetupTitle: 'Préparation du Service Account',
  saKeyLabel: 'Clé JSON du Service Account',
  saKeyUnchangedPlaceholder: '(inchangé — laissez vide pour conserver la clé existante)',
  saDetected: 'Service Account détecté :',
  recursiveLabel: 'Indexer récursivement les sous-dossiers',
  recursiveHelp: "Désactivez pour n'indexer que le dossier racine.",
  impersonateHelp:
    "Délégation à l'échelle du domaine (Domain-wide delegation) uniquement. Laissez vide dans la plupart des cas.",
  mimeIncludeHelp: 'Un mime type par ligne. Vide = tout inclure.',
  mimeExcludeHelp: 'Un mime type par ligne.',

  // S3
  s3Region: 'Région',
  s3Prefix: 'Préfixe (racine logique)',
  s3Endpoint: 'Endpoint personnalisé',

  // HTTP
  httpIndexMode: "Mode d'indexation",
  httpModeUrls: "Liste d'URLs fixe",
  httpModeSitemap: 'Sitemap XML',
  httpUrlsLabel: 'URLs à indexer',
  httpInvalidUrl: (url: string) => `URL invalide : ${url}`,
  httpSitemapLabel: 'URL du sitemap',
  httpAdvanced: 'Avancé (filtres, sécurité)',
  httpAllowedHosts: 'Hosts autorisés',
  httpAllowedHostsHelp:
    'Allowlist de sécurité. Laisser vide pour autoriser tous les hosts des URLs indexées. Protège contre les docIds malicieux.',

  // Google Drive
  gdriveStep1: 'Créer un Service Account dans Google Cloud Console.',
  gdriveStep2: "Activer l'API Google Drive sur le projet.",
  gdriveStep3: 'Générer et télécharger la clé JSON du Service Account.',
  gdriveStep4Before: "Partager le dossier Drive avec l'email du Service Account (champ ",
  gdriveStep4After: ' de la clé JSON, accès Viewer suffisant).',
  gdriveRootLabel: 'ID du dossier racine',
  gdriveRootHelpBefore: "Dans l'URL ",
  gdriveRootHelpAfter: '. Le dossier doit être partagé avec le Service Account.',
  gdriveAdvanced: 'Avancé (impersonation, filtres mime)',

  // Google Sheets
  gsheetsStep1: 'Réutiliser le Service Account de Google Drive si vous en avez déjà configuré un.',
  gsheetsStep2Before: "Activer l'API Google Sheets ",
  gsheetsStep2Em: 'et',
  gsheetsStep2After: " l'API Google Drive sur le projet GCP.",
  gsheetsStep3:
    "Partager chaque Google Sheet (ou le dossier Drive d'énumération) avec l'email du Service Account (accès Viewer suffisant).",
  gsheetsSourceLabel: 'Source des Google Sheets',
  gsheetsModeIds: 'IDs explicites',
  gsheetsModeFolder: 'Dossier Drive',
  gsheetsIdsLabel: 'IDs des Google Sheets (un par ligne)',
  gsheetsIdsHelpBefore: "Dans l'URL ",
  gsheetsIdsHelpAfter: '/edit. Chaque onglet du classeur devient un document distinct.',
  gsheetsFolderLabel: 'ID du dossier Drive',
  gsheetsFolderHelpBefore: 'Tous les Google Sheets ',
  gsheetsFolderHelpEm: 'directement',
  gsheetsFolderHelpAfter:
    ' dans ce dossier seront indexés. Aucune récursion (les sous-dossiers sont ignorés).',
  gsheetsIncludeArchived: 'Inclure les onglets archivés',
  gsheetsArchivedHelpBefore: 'Les onglets dont le nom commence par ',
  gsheetsArchivedHelpMid: ' ou ',
  gsheetsArchivedHelpAfter: ' sont ignorés par défaut.',
  gsheetsAdvanced: 'Avancé (impersonation, plage par défaut)',
  gsheetsRange: 'Plage par défaut',
  gsheetsRangeHelpBefore: 'Notation A1 (par exemple ',
  gsheetsRangeHelpMid: ' ou ',
  gsheetsRangeHelpAfter: '). Vide = toute la plage utilisée de chaque onglet.',

  // Notion
  notionSetupTitle: "Préparation de l'intégration Notion",
  notionStep1Before: 'Ouvrir ',
  notionStep1After: ' → « New integration » → copier le secret.',
  notionStep2: "Dans chaque page/database à indexer, cliquer « Share » et inviter l'intégration.",
  notionSecretLabel: "Secret de l'intégration",
  notionKeyUnchangedPlaceholder: '(inchangé — laissez vide pour conserver la clé)',
  notionKeyExample: 'secret_… ou ntn_…',
  notionRootIds: 'IDs racines (optionnel)',
  notionRootIdsHelp:
    "IDs de pages ou databases à utiliser comme racines (un par ligne, avec ou sans tirets). Laissez vide pour indexer tout le contenu partagé avec l'intégration.",
  notionIncludeArchived: 'Inclure les pages archivées',
  notionArchivedHelp:
    'Désactivé par défaut. Activez pour indexer les pages déplacées vers la corbeille.',

  // SharePoint
  spSetupTitle: "Préparation de l'application Azure AD",
  spStep1Before: 'Enregistrer une application dans Azure AD (',
  spStep1After: ' → App registrations).',
  spStep2Before: 'Ajouter la permission ',
  spStep2Mid1: ' : ',
  spStep2Mid2: ' (large) ou ',
  spStep2After: ' (portée par site).',
  spStep3: 'Cliquer « Grant admin consent » pour activer la permission au niveau du tenant.',
  spStep4:
    'Sous « Certificates & secrets », créer un client secret et le copier (affiché une seule fois).',
  spStep5: 'Renseigner tenantId, clientId et le secret ci-dessous.',
  spTenantHelp: 'GUID du tenant Azure AD.',
  spClientHelp: "GUID de l'application enregistrée.",
  spSiteUrlLabel: 'URL du site SharePoint',
  spSiteUrlHelpBefore: 'URL complète (',
  spSiteUrlHelpMid: ') ou forme hôte-relative (',
  spSiteUrlHelpAfter: ').',
  spAdvanced: 'Avancé (drive, sous-dossier, filtres mime)',
  spDriveName: 'Nom du Document Library',
  spDriveNameHelp: 'Par défaut : la bibliothèque « Documents » principale du site.',
  spRootPath: 'Sous-dossier racine',
  spRootPathHelpBefore: "Chemin à l'intérieur du drive (ex. ",
  spRootPathHelpAfter: '). Laissez vide pour indexer toute la bibliothèque.',

  // Embeddings
  localProviderUnavailable:
    "Le fournisseur local intégré est indisponible — vérifiez l'installation ou configurez un fournisseur distant dans la section « Paramètres IA ».",
  aiSettingsLoading: 'Chargement des paramètres IA…',
  aiSettingsLoadError:
    'Impossible de charger les paramètres IA (fournisseurs, embeddings). Vérifiez la connexion puis réessayez.',
  aiSettingsRetry: 'Réessayer',
  embeddingsUnsupportedSuffix: ' — embeddings non supportés',
  embeddingsUnsupportedTitle: 'Cette config IA ne supporte pas les embeddings',
  dims: (n: number) => ` (${n} dims)`,
  noEmbeddingConfigBefore:
    'Aucune configuration IA disponible ne supporte les embeddings. Activez la capacité',
  noEmbeddingConfigAfter: " sur l'une de vos configurations.",
  notSpecified: '(non spécifié)',
  localModelMissing:
    "Modèle local introuvable sur le disque. Réinstallez l'application ou contactez votre administrateur.",
  thirdPartyLicenses: 'Licences tierces',
  thirdPartyLicensesTitle:
    "EmbeddingGemma est distribué sous les Gemma Terms of Use — voir third_party/NOTICES.md dans l'installation pour la liste complète des licences tierces",
  remoteEmbeddingsNotice:
    'Les documents et les requêtes de recherche sont envoyés à ce fournisseur pour être convertis en vecteurs.',
  migrateSources: 'Migrer les sources existantes vers ce modèle…',
};

const EN: typeof FR = {
  saInvalidJson: 'Invalid JSON.',
  saNotObject: 'Must be a JSON object.',
  saMissingClientEmail: 'Missing `client_email` field.',
  saMissingPrivateKey: 'Missing `private_key` field.',

  s3BucketRequired: 'The S3 bucket name is required.',
  s3RegionRequired: 'The S3 region is required.',
  accessKeyIdRequired: 'The Access Key ID is required.',
  secretAccessKeyRequired: 'The Secret Access Key is required.',
  urlRequired: 'Enter at least one URL.',
  invalidUrls: (n: number) => `${n} invalid URL(s) — check the http(s):// format.`,
  sitemapUrlRequired: 'The sitemap URL is required.',
  sitemapUrlInvalid: 'The sitemap URL must be a valid http(s):// URL.',
  gdriveFolderIdRequired: 'The Google Drive folder ID is required.',
  pasteServiceAccountKey: 'Paste the Service Account JSON key.',
  serviceAccountJsonInvalid: (detail: string) => `Invalid Service Account JSON: ${detail}`,
  spreadsheetIdRequired: 'Enter at least one Google Sheet ID.',
  driveFolderIdRequired: 'The Drive folder ID is required.',
  notionSecretRequired: 'The Notion integration secret is required.',
  notionKeyPrefix: 'The Notion key must start with `secret_` or `ntn_`.',
  tenantIdRequired: 'The Azure AD tenant ID is required.',
  clientIdRequired: 'The application (client) ID is required.',
  clientSecretRequired: 'The application client secret is required.',
  siteUrlRequired: 'The SharePoint site URL is required.',
  embeddingDimensionConflict:
    'All RAG sources must use the same embedding model (fixed dimension). ' +
    'Try again with an AI configuration whose model has the same dimension as the existing sources.',

  namePlaceholder: 'Product documentation',
  unchanged: '(unchanged)',
  keepExistingKey: 'Leave empty to keep the existing key.',
  keepSavedKey: 'Leave empty to keep the saved key.',
  keepExistingSecret: 'Leave empty to keep the existing secret.',
  saSetupTitle: 'Service Account setup',
  saKeyLabel: 'Service Account JSON key',
  saKeyUnchangedPlaceholder: '(unchanged — leave empty to keep the existing key)',
  saDetected: 'Service Account detected:',
  recursiveLabel: 'Index subfolders recursively',
  recursiveHelp: 'Turn off to index only the root folder.',
  impersonateHelp: 'Domain-wide delegation only. Leave empty in most cases.',
  mimeIncludeHelp: 'One mime type per line. Empty = include everything.',
  mimeExcludeHelp: 'One mime type per line.',

  s3Region: 'Region',
  s3Prefix: 'Prefix (logical root)',
  s3Endpoint: 'Custom endpoint',

  httpIndexMode: 'Indexing mode',
  httpModeUrls: 'Fixed list of URLs',
  httpModeSitemap: 'XML sitemap',
  httpUrlsLabel: 'URLs to index',
  httpInvalidUrl: (url: string) => `Invalid URL: ${url}`,
  httpSitemapLabel: 'Sitemap URL',
  httpAdvanced: 'Advanced (filters, security)',
  httpAllowedHosts: 'Allowed hosts',
  httpAllowedHostsHelp:
    'Security allowlist. Leave empty to allow all hosts of the indexed URLs. Protects against malicious docIds.',

  gdriveStep1: 'Create a Service Account in the Google Cloud Console.',
  gdriveStep2: 'Enable the Google Drive API on the project.',
  gdriveStep3: 'Generate and download the Service Account JSON key.',
  gdriveStep4Before: 'Share the Drive folder with the Service Account email (the ',
  gdriveStep4After: ' field of the JSON key; Viewer access is enough).',
  gdriveRootLabel: 'Root folder ID',
  gdriveRootHelpBefore: 'In the URL ',
  gdriveRootHelpAfter: '. The folder must be shared with the Service Account.',
  gdriveAdvanced: 'Advanced (impersonation, mime filters)',

  gsheetsStep1: 'Reuse the Google Drive Service Account if you have already set one up.',
  gsheetsStep2Before: 'Enable the Google Sheets API ',
  gsheetsStep2Em: 'and',
  gsheetsStep2After: ' the Google Drive API on the GCP project.',
  gsheetsStep3:
    'Share each Google Sheet (or the enumeration Drive folder) with the Service Account email (Viewer access is enough).',
  gsheetsSourceLabel: 'Google Sheets source',
  gsheetsModeIds: 'Explicit IDs',
  gsheetsModeFolder: 'Drive folder',
  gsheetsIdsLabel: 'Google Sheet IDs (one per line)',
  gsheetsIdsHelpBefore: 'In the URL ',
  gsheetsIdsHelpAfter: '/edit. Each tab of the workbook becomes a separate document.',
  gsheetsFolderLabel: 'Drive folder ID',
  gsheetsFolderHelpBefore: 'All Google Sheets ',
  gsheetsFolderHelpEm: 'directly',
  gsheetsFolderHelpAfter: ' in this folder will be indexed. No recursion (subfolders are ignored).',
  gsheetsIncludeArchived: 'Include archived tabs',
  gsheetsArchivedHelpBefore: 'Tabs whose name starts with ',
  gsheetsArchivedHelpMid: ' or ',
  gsheetsArchivedHelpAfter: ' are ignored by default.',
  gsheetsAdvanced: 'Advanced (impersonation, default range)',
  gsheetsRange: 'Default range',
  gsheetsRangeHelpBefore: 'A1 notation (for example ',
  gsheetsRangeHelpMid: ' or ',
  gsheetsRangeHelpAfter: '). Empty = the whole used range of each tab.',

  notionSetupTitle: 'Notion integration setup',
  notionStep1Before: 'Open ',
  notionStep1After: ' → “New integration” → copy the secret.',
  notionStep2: 'In each page/database to index, click “Share” and invite the integration.',
  notionSecretLabel: 'Integration secret',
  notionKeyUnchangedPlaceholder: '(unchanged — leave empty to keep the key)',
  notionKeyExample: 'secret_… or ntn_…',
  notionRootIds: 'Root IDs (optional)',
  notionRootIdsHelp:
    'IDs of pages or databases to use as roots (one per line, with or without dashes). Leave empty to index everything shared with the integration.',
  notionIncludeArchived: 'Include archived pages',
  notionArchivedHelp: 'Off by default. Turn on to index pages moved to the trash.',

  spSetupTitle: 'Azure AD application setup',
  spStep1Before: 'Register an application in Azure AD (',
  spStep1After: ' → App registrations).',
  spStep2Before: 'Add the ',
  spStep2Mid1: ' permission: ',
  spStep2Mid2: ' (broad) or ',
  spStep2After: ' (per-site scope).',
  spStep3: 'Click “Grant admin consent” to enable the permission at the tenant level.',
  spStep4: 'Under “Certificates & secrets”, create a client secret and copy it (shown only once).',
  spStep5: 'Fill in tenantId, clientId and the secret below.',
  spTenantHelp: 'GUID of the Azure AD tenant.',
  spClientHelp: 'GUID of the registered application.',
  spSiteUrlLabel: 'SharePoint site URL',
  spSiteUrlHelpBefore: 'Full URL (',
  spSiteUrlHelpMid: ') or host-relative form (',
  spSiteUrlHelpAfter: ').',
  spAdvanced: 'Advanced (drive, subfolder, mime filters)',
  spDriveName: 'Document Library name',
  spDriveNameHelp: 'Default: the main “Documents” library of the site.',
  spRootPath: 'Root subfolder',
  spRootPathHelpBefore: 'Path inside the drive (e.g. ',
  spRootPathHelpAfter: '). Leave empty to index the whole library.',

  localProviderUnavailable:
    'The built-in local provider is unavailable — check the installation or configure a remote provider in the “AI Settings” section.',
  aiSettingsLoading: 'Loading AI settings…',
  aiSettingsLoadError:
    'Could not load the AI settings (providers, embeddings). Check the connection and retry.',
  aiSettingsRetry: 'Retry',
  embeddingsUnsupportedSuffix: ' — embeddings not supported',
  embeddingsUnsupportedTitle: 'This AI configuration does not support embeddings',
  dims: (n: number) => ` (${n} dims)`,
  noEmbeddingConfigBefore: 'No available AI configuration supports embeddings. Enable the',
  noEmbeddingConfigAfter: ' capability on one of your configurations.',
  notSpecified: '(not specified)',
  localModelMissing:
    'Local model not found on disk. Reinstall the application or contact your administrator.',
  thirdPartyLicenses: 'Third-party licenses',
  thirdPartyLicensesTitle:
    'EmbeddingGemma is distributed under the Gemma Terms of Use — see third_party/NOTICES.md in the installation for the full list of third-party licenses',
  remoteEmbeddingsNotice:
    'Documents and search queries are sent to this provider to be converted into vectors.',
  migrateSources: 'Migrate existing sources to this model…',
};

export const SOURCE_FORM_STRINGS = localized(FR, EN);

/** Raw tables, for the fr/en key-parity test. */
export const SOURCE_FORM_STRING_TABLES = { fr: FR, en: EN };
