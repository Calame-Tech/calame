// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { localized } from '../onboarding-strings.js';

const FR = {
  forceAutoIncludeTitle: 'Basculer en mode auto-include pour ce dossier',
  includeDoc: (name: string) => `Inclure ${name}`,
  deleted: 'supprimé',
  notIndexedTitle: 'Pas encore indexé — sera disponible après la prochaine sync',
  notIndexed: 'non indexé',
  collapse: 'Réduire',
  expand: 'Développer',
  coveredByParent: (name: string) =>
    `Inclus par un dossier parent — décochez le parent pour gérer ${name}`,
  includeFolder: (name: string) => `Inclure le dossier ${name}`,
  itemCount: (n: number) => `(${n} éléments)`,
  emptyFolder: 'Dossier vide.',
  closeNotification: 'Fermer la notification',
  collapseSource: 'Réduire la source',
  expandSource: 'Développer la source',
  browseSourceTitle: 'Parcourir les dossiers et fichiers de cette source',
  includeSource: (name: string) => `Inclure la source ${name}`,
  indexing: (done: number, total: number) => `indexation ${done}/${total}`,
  indexingPreparing: "préparation de l'indexation…",
  syncFailed: 'sync échouée',
  noIndexedContent: 'Aucun contenu indexé.',
  folderCount: (n: number) => `${n} dossier${n > 1 ? 's' : ''}`,
  documentCount: (n: number) => `${n} document${n > 1 ? 's' : ''}`,
  selected: (total: number) => `sélectionné${total > 1 ? 's' : ''}`,
  noneSelected: 'Aucun élément sélectionné',
  cancel: 'Annuler',
  saving: 'Enregistrement…',
  save: 'Enregistrer',
  genericError: 'Erreur.',
  savedToast: (profile: string) =>
    `Accès aux bases de connaissances mis à jour pour le profil « ${profile} ».`,
  saveFailed: (msg: string) => `Échec de la sauvegarde : ${msg}`,
  loadingKbs: 'Chargement des bases de connaissances…',
  headingPrefix: 'Bases de connaissances accessibles — profil ',
  introBeforeArrow:
    'Sélectionnez les bases de connaissances et dossiers accessibles pour ce profil. Cliquez sur ',
  introAfterArrow:
    " pour parcourir le contenu d'une base et choisir des dossiers ou fichiers précis plutôt que tout inclure.",
  piiOffLabel: 'Désactiver le masquage des données personnelles (PII)',
  piiOffHint:
    "Par défaut, les données personnelles (PII : e-mails, numéros…) sont masquées avant d'être transmises à l'IA. " +
    "Une fois le masquage désactivé, le contenu sensible reste visible par l'IA. " +
    'Désactivez-le seulement si votre contenu contient des numéros qui ne sont pas des données personnelles (codes secrets, identifiants internes, etc.).',
  directFetchOffLabel: 'Désactiver la lecture directe des documents',
  directFetchOffHint:
    "L'IA ne pourra plus ouvrir un document en entier : elle utilisera uniquement la recherche sémantique (par le sens). " +
    'Recommandé pour les bases de connaissances volumineuses : limite le coût des questions du type « résume tous mes fichiers ».',
  noKnowledgeBase: 'Aucune base de connaissances configurée.',
};

const EN: typeof FR = {
  forceAutoIncludeTitle: 'Switch this folder to auto-include mode',
  includeDoc: (name: string) => `Include ${name}`,
  deleted: 'deleted',
  notIndexedTitle: 'Not indexed yet — will be available after the next sync',
  notIndexed: 'not indexed',
  collapse: 'Collapse',
  expand: 'Expand',
  coveredByParent: (name: string) =>
    `Included by a parent folder — uncheck the parent to manage ${name}`,
  includeFolder: (name: string) => `Include folder ${name}`,
  itemCount: (n: number) => `(${n} item${n === 1 ? '' : 's'})`,
  emptyFolder: 'Empty folder.',
  closeNotification: 'Close notification',
  collapseSource: 'Collapse source',
  expandSource: 'Expand source',
  browseSourceTitle: 'Browse the folders and files of this source',
  includeSource: (name: string) => `Include source ${name}`,
  indexing: (done: number, total: number) => `indexing ${done}/${total}`,
  indexingPreparing: 'preparing indexing…',
  syncFailed: 'sync failed',
  noIndexedContent: 'No indexed content.',
  folderCount: (n: number) => `${n} folder${n > 1 ? 's' : ''}`,
  documentCount: (n: number) => `${n} document${n > 1 ? 's' : ''}`,
  selected: (_total: number) => 'selected',
  noneSelected: 'No items selected',
  cancel: 'Cancel',
  saving: 'Saving…',
  save: 'Save',
  genericError: 'Error.',
  savedToast: (profile: string) => `Knowledge base access updated for profile "${profile}".`,
  saveFailed: (msg: string) => `Save failed: ${msg}`,
  loadingKbs: 'Loading knowledge bases…',
  headingPrefix: 'Accessible knowledge bases — profile ',
  introBeforeArrow: 'Select the knowledge bases and folders accessible to this profile. Click ',
  introAfterArrow:
    ' to browse the contents of a knowledge base and pick specific folders or files instead of including everything.',
  piiOffLabel: 'Disable personal data (PII) masking',
  piiOffHint:
    'By default, personal data (PII: emails, numbers…) is masked before it is sent to the AI. ' +
    'Once masking is disabled, sensitive content stays visible to the AI. ' +
    'Only disable it if your content contains numbers that are not personal data (secret codes, internal IDs, etc.).',
  directFetchOffLabel: 'Disable direct document reading',
  directFetchOffHint:
    'The AI will no longer open a whole document: it will only use semantic search (search by meaning). ' +
    'Recommended for large knowledge bases: limits the cost of questions like "summarize all my files".',
  noKnowledgeBase: 'No knowledge base configured.',
};

export const RAG_ACCESS_STRINGS = localized(FR, EN);
export const RAG_ACCESS_STRING_TABLES = { fr: FR, en: EN };
