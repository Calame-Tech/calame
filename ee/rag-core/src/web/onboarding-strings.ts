// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * User-facing strings added for the first-run source flow (loading / timeout
 * states and the "?" help tips of SourceForm).
 *
 * rag-core has no i18n runtime: the whole knowledge-base UI is written in
 * French inline, and BUSL packages cannot value-import the host's use-intl
 * setup from `packages/web`. These strings are grouped here so they can be
 * moved into the host catalogs (en.json / fr.json) in one place once rag-core
 * gets translations.
 */
export const RAG_STRINGS = {
  timeout: (seconds: number) => `Le serveur n'a pas répondu après ${seconds} s.`,
  retry: 'Réessayer',

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
} as const;
