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
  loadingKbs: 'Chargement des bases de connaissance…',
  headingPrefix: 'Bases de connaissances accessibles — profil ',
  introBeforeArrow:
    'Sélectionnez les bases de connaissance et dossiers accessibles pour ce profil. Cliquez sur ',
  introAfterArrow:
    " pour parcourir le contenu d'une base et choisir des dossiers ou fichiers précis plutôt que tout inclure.",
  piiOffLabel: "Désactiver le masquage PII (le contenu sensible reste visible par l'IA)",
  piiOffHint:
    'Désactivez si votre contenu contient des numéros qui ne sont pas du vrai PII (codes secrets, IDs internes, etc.).',
  directFetchOffLabel:
    'Désactiver la lecture directe des documents (le LLM ne pourra utiliser que la recherche sémantique)',
  directFetchOffHint:
    'Recommandé pour les bases de connaissances volumineuses : limite le coût des questions du type "résume tous mes fichiers".',
  noKnowledgeBase: 'Aucune base de connaissance configurée.',
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
  savedToast: (profile: string) => `RAG access updated for profile "${profile}".`,
  saveFailed: (msg: string) => `Save failed: ${msg}`,
  loadingKbs: 'Loading knowledge bases…',
  headingPrefix: 'RAG scopes — profile ',
  introBeforeArrow: 'Select the knowledge bases and folders accessible to this profile. Click ',
  introAfterArrow:
    ' to browse the contents of a knowledge base and pick specific folders or files instead of including everything.',
  piiOffLabel: 'Disable PII masking (sensitive content stays visible to the AI)',
  piiOffHint:
    'Disable if your content contains numbers that are not real PII (secret codes, internal IDs, etc.).',
  directFetchOffLabel:
    'Disable direct document reading (the LLM will only be able to use semantic search)',
  directFetchOffHint:
    'Recommended for large knowledge bases: limits the cost of questions like "summarize all my files".',
  noKnowledgeBase: 'No knowledge base configured.',
};

export const RAG_ACCESS_STRINGS = localized(FR, EN);
export const RAG_ACCESS_STRING_TABLES = { fr: FR, en: EN };
