# Plan d'intégration RAG — OpenSmith / Calame

Ce document propose une architecture pour ajouter une couche RAG (Retrieval-Augmented Generation) à OpenSmith, exposée via MCP au même titre que les bases de données. Il est rédigé pour cadrer la discussion : plusieurs choix sont laissés ouverts et présentés avec leurs tradeoffs.

---

## 0. État d'avancement (mis à jour 2026-05-11)

> **Pivot stratégique (2026-05-07)** — La suite de la roadmap RAG est désormais portée par un plan plus large : **`docs/sources-unified-plan.md`**. La RAG-Phase-2 originale de ce document (intégration profiles + MCP) **est livrée comme Phase 3 de ce plan unifié**, dans le cadre d'une refonte qui généralise « Connection (DB) » et « RagSource » en un concept polymorphique `Source` accueillant aussi les futurs APIs / SaaS / streams. Lire les deux docs en parallèle pour comprendre le contexte.

### ✅ Livré 2026-05-11 — UX fixes & typing cleanup

Trois petites tranches livrées dans la même session, listées ici pour traçabilité :

- **`3fd56fc`** — fix(rag-core/web) : refresh folder tree after upload so new files appear instantly. Signalé en live : un fichier droppé dans une base de connaissance n'apparaissait dans `FolderTreeView` qu'après reload de la page. Cause : `FolderTreeView` ne re-fetchait que sur changement de `source.id` ; `onUploaded` côté `KnowledgeBaseManager` ne refraîchissait que la liste des sources (counts). Fix : nouvelle prop `refreshKey?: number` sur `FolderTreeView` + un `useEffect` dédié qui re-charge le root quand le key bumpe (l'upload route va toujours en `folder: null`). `KnowledgeBaseManager` maintient un `folderRefreshTicks: Record<sourceId, number>` (per-source, pour ne pas embarquer de compteurs périmés en switchant). L'état `expanded` et les caches de sous-dossiers sont préservés — l'arbre ne se collapse pas.
- **`269685d`** — fix(web) : align ScopeSelection mirror + drop the 4 unknown casts. Cf. section "Issues à ouvrir post-commit" pour le détail.
- **`7adeb0f`** — refactor(rag-core/web) : split RagAccessSelector into sub-components. Ferme le God Component flag du QA review post-Phase 4. Cf. section "Issues à ouvrir post-commit" pour le détail.

### ✅ Livré 2026-05-11 — Phase 6 : Data Profile RAG support (commit `d5cd010`)

**Question d'origine** : « Actuellement le profile pour le rag se fait dans le MCP. Est-ce que c'est prévu de pouvoir le faire dans le Data Profile ? »

Avant cette tranche, un scope `kind: 'document'` ne pouvait être attaché qu'à un MCP Profile (via le `RagAccessSelector` monté dans `McpDetailView`). La couche `ServeConfiguration` (= Data Profile, un preset réutilisable) était relational-only au runtime — le `mergeConfigurations` ignorait silencieusement tout scope document. Cette tranche rend les deux couches **symétriques**.

**Backend** :

- `packages/core/src/sources/accessors.ts` : nouveaux `getConfigurationDocumentScopes(cfg)` (retourne `Record<sourceId, DocumentScope>`) et `getConfigurationDocumentSources(cfg)` (juste les ids). Symétriques avec les accessors relational. **5 nouveaux tests** (`accessors.test.ts`).
- `packages/cli/src/routes/serve.ts:mergeConfigurations` : signature retour étendue avec `documentScopes: Record<sourceId, DocumentScope>`. **Sémantique de merge tranchée** : « **allowAll wins, sinon union des allowlists** » — cohérent avec le pattern relational (union des selectedTables, least-restrictive masking). Si **au moins une** Config a `mode: 'allowAll'` pour un sourceId, le merged est `allowAll` avec allowlists vides ; sinon (toutes en `allowList`) → union de `allowedFolders` et `allowedDocuments`.
- `packages/cli/src/routes/serve.ts:registerToolsViaAdapters` : l'itération `profile.scopes` (ligne ~1264) est désormais une **fusion** `{ ...effectiveDocumentScopes, ...profileScopes }` — **profile.scopes wins** per sourceId (cohérent avec l'override pattern qui s'applique déjà aux scopes relational via le narrowedScope). Les sourceIds présents **uniquement** dans les Configurations sont ajoutés à `rawSources` pour que la boucle adapter les itère. **3 nouveaux tests** (`serve-adapter-tools.test.ts`) couvrant : union d'allowlists (2 Configs `allowList` → union), `allowAll` wins (Config A `allowAll` + Config B `allowList` → résultat `allowAll`), profile override (`profile.scopes` contient `allowList(['strict'])`, Config dit `allowAll` → runtime utilise `allowList(['strict'])`).

**Frontend** :

- `ee/rag-core/src/web/RagAccessSelector.tsx` : **3 nouvelles props optionnelles** (defaults inchangés, pas de régression `McpDetailView`) :
  - `saveEndpoint?: string` — override l'URL de POST (default `/api/profiles/:profileName/scopes`)
  - `saveMethod?: 'POST' | 'PATCH'` — méthode HTTP (default `'POST'`)
  - `saveBodyTransform?: (payload) => unknown` — permet au caller d'enrichir le body avant envoi (ex : ajouter `name`/`label` pour la route `/api/configurations`)
- `packages/web/src/App.tsx:ConfigurationDetailView` : layout **tabbed** `Databases` / `Knowledge bases`. Le tab `knowledge` est `disabled` avec tooltip quand `ragEnabled === false`. À l'ouverture du tab, lazy-mount d'un `<RagAccessSelector>` avec `saveEndpoint="/api/configurations"` + `saveBodyTransform` qui **préserve les scopes relational existants** (le save RAG ne droppe jamais les tables DB déjà sélectionnées). Helpers `useMemo` `configDocumentScopes` / `configRelationalScopes` pour ne pas re-calculer les filtres à chaque render.

**Pattern d'override profile × configuration** (documenté en code) :

| Cas | Source du scope effectif au serve-time |
|---|---|
| Profile sans `configurations[]` | `profile.scopes` direct (path 2 inchangé) |
| Profile avec `configurations[]` mais sans `profile.scopes[sourceId]` (document) | Scope mergé depuis les Configurations |
| Profile avec `configurations[]` ET `profile.scopes[sourceId]` (document) | **Profile.scopes wins** (override per-sourceId) |
| Pour `kind: 'relational'` | Inchangé — le `narrowedScope` issu de `mergeConfigurations.{selectedTables, tableOptions, columnMasking}` override |

**Tests** : 1596 tests verts (28 sso + 267 core + 105 connectors + 359 rag-core + 30 web + 67 rag-connectors + 34 gdrive + 42 gsheets + 50 notion + 28 microsoft + 536 cli). **+8 vs. 1588** (5 accessors + 3 merge). 0 régression.

**QA review** : score 10/10, aucun bloquant. Validation des points critiques :
- ✅ Sémantique `allowAll wins` correcte (allowlists explicitement clearées, pas d'union puis check post-hoc)
- ✅ Profile override hiérarchie respectée (spread order garantit profile last)
- ✅ Config-only sourceIds auto-ajoutés à `rawSources` — pas de drop silencieux
- ✅ Mocks `@calame/core` étendus avec `getConfigurationDocumentScopes` — passthrough realistic
- ✅ `saveBodyTransform` préserve les scopes relational existants → save RAG ne perd pas la DB selection
- ✅ Boundary open-core respectée (lazy import `RagAccessSelector`, pas de value import statique `@calame-ee/*` dans `packages/`)

**Fichiers modifiés** :

```
MOD packages/core/src/sources/accessors.ts                       (+44 lignes)
MOD packages/core/src/sources/__tests__/accessors.test.ts        (+78 lignes — 5 nouveaux tests)
MOD packages/cli/src/routes/serve.ts                             (+78 lignes)
MOD packages/cli/src/routes/__tests__/serve-adapter-tools.test.ts (+196 lignes — 3 nouveaux tests + mocks)
MOD ee/rag-core/src/web/RagAccessSelector.tsx                    (+27 lignes — 3 nouvelles props)
MOD packages/web/src/App.tsx                                     (+110 lignes — tabbed ConfigurationDetailView)
```

**Bénéfices opérationnels** :
- Un admin peut maintenant créer une Configuration "kb_internal" qui combine des tables DB + des dossiers RAG, et la **partager** entre plusieurs MCP Profiles (`support`, `legal`, `engineering`) en une seule référence — au lieu de re-cocher les mêmes dossiers à chaque Profile.
- Cohérence du modèle Sources Unifiées : le pivot 2026-05-07 (`docs/sources-unified-plan.md`) avait pour but de gommer la dichotomie DB/RAG dans les types. Cette tranche supprime la dernière asymétrie runtime.

### 🚧 En cours 2026-05-09 — Phase 4 du plan unifié : UI Sources unifiée + `RagAccessSelector` (non commité)

Priorité #6 de la "Prochaine session" précédente. Ferme la boucle UX qui restait : aujourd'hui un admin pouvait techniquement curl `POST /api/profiles/:name/scopes` pour assigner un scope `document` à un profile, mais aucune UI n'existait. Cette tranche livre l'UI complète.

**Frontend Apache (`packages/web/`)** :

- `components/SourcesPage.tsx` (NEW, 259 lignes) : page unifiée tabbed `Databases` / `Knowledge bases`. Les compteurs des tabs (count des connexions / count des sources RAG) sont fetchés à l'ouverture. Tab `Knowledge bases` désactivé avec tooltip `ragDisabledReason` quand le runtime n'a pas chargé. Bouton « Add source » ouvre `AddSourceModal` (kind picker) ou délègue via `onAddSource` prop. `KnowledgeBaseManager` est passé en prop `KnowledgeBaseManagerComponent` (jamais d'import direct depuis `@calame-ee/*` — boundary respectée).
- `components/AddSourceModal.tsx` (NEW, 190 lignes) : kind picker modal (Database card toujours active, Knowledge base card disabled si `ragEnabled === false` avec icône ⓘ). Focus trap + Escape close + click-outside close.
- `App.tsx` :
  - Nouveau `View` arm `{ page: 'sources'; tab?: 'databases' | 'knowledge' }` qui rend `SourcesPage`.
  - Anciens `'connections'` et `'knowledge'` conservés comme **alias legacy** qui redirigent vers `'sources'` avec le bon tab — déjà-existant deep-links et navigation calls non cassés.
  - `RagAccessSelector` lazy-imported depuis `@calame-ee/rag-core/web` avec fallback gracieux. Wired dans le `McpDetailView` en `activeSection === 'knowledge'`. À save, le composant POST lui-même `/api/profiles/:name/scopes` ; App.tsx met juste à jour le state local + refetch preview.
  - Helper `buildProfilesData(profiles)` extrait pour centraliser la sérialisation côté `persistProfiles`. Bug latent corrigé : les anciennes call sites omettaient `sources` / `scopes` du payload, ce qui les droppait silencieusement à chaque save.
- `Sidebar.tsx` : entrée `Connections` renommée **`Sources`** (icône `IconCircleStack` conservée). `activeWhen: ['connections', 'knowledge']` pour qu'elle reste highlightée sur les pages legacy. Suppression de l'entrée séparée `Bases de connaissance` (fusionnée dans Sources).
- `types/schema.ts` : ajout du miroir `ScopeSelection` (union discriminée `relational` | `document`), ajout des champs `sources?: string[]` et `scopes?: Record<string, ScopeSelection>` sur `Profile`.

**Frontend BUSL (`ee/rag-core/src/web/`)** :

- `RagAccessSelector.tsx` (NEW, **1134 lignes**) : composant principal de sélection des dossiers / documents par profile. Implémente **toute** l'UX décrite §8.1 :
  - Arborescence lazy : `GET /api/rag/sources` au mount → `GET /api/rag/sources/:id/folders|documents` à l'expansion d'un dossier
  - Checkboxes 3-états (`checked` / `partial` / `unchecked`) calculés par `deriveFolderCheckState`
  - Modes `auto-include` (badge bleu, recursive) / `strict` (badge orange, whitelist) bascule automatique : décocher un fichier individuel dans un dossier `auto-include` → bascule en `strict` avec toast confirmation
  - Bouton retour `auto-include` via menu ⋯ contextuel
  - Compteurs temps-réel par source (`X folders · Y documents · ~Z chunks`) via `GET /api/profiles/:name/scopes/preview`
  - Save explicite via bouton (POST `/api/profiles/:name/scopes`) avec dirty tracking + bouton Annuler
  - États visuels : source en ingestion (badge `[indexation N/M…]`), source en erreur de sync (badge rouge), document non encore indexé (grisé), document soft-deleted (barré)
- `rag-access-state.ts` (NEW, 180 lignes) : helpers **purs** extraits du composant pour testabilité sans React/JSX :
  - `deriveFolderCheckState(folderId, folderMap, sourceIncluded)` → `'checked' | 'partial' | 'unchecked'`
  - `buildDocumentScope(sourceIncluded, rootFolderIds, rootDocuments, folderMap)` → `ScopeSelection` `{ kind: 'document', mode, allowedFolders, allowedDocuments }`
  - `countSelected(...)` → `{ folders, documents }` pour récap header
- `web/rag-access-state.ts` (NEW, 7 lignes) : re-export pour permettre `import from '@calame-ee/rag-core/web/rag-access-state'`
- `web/index.ts` : export `RagAccessSelector` ajouté au barrel

**Backend Apache (`packages/cli/src/routes/profile-scopes.ts`)** :

- `GET /api/profiles/:name/scopes/preview` enrichi avec **live counts** quand `state.ragRuntime` est actif :
  - `relational` scope : `tables` + `columns` (additif, ancien `summary.selectedTables` conservé pour rétro-compat)
  - `document` scope mode `allowAll` : `COUNT(*)` SQL sur `rag_documents` / `rag_folders` / `rag_chunks JOIN rag_documents` filtré par `source_id` et `deleted_at IS NULL`
  - `document` scope mode `allowList` : résolution des `allowedFolders[]` (path → folder.id → docs in folder) ∪ validation des `allowedDocuments[]` (docs encore non-soft-deletés) ; `liveChunkCount` = `COUNT(*) FROM rag_chunks WHERE document_id IN (union)`
  - Fallback gracieux `live: false` quand le RAG n'est pas chargé : retombe sur les naive array-length counts (ancien comportement)
- Réponse étendue : `sources: [{ id, kind, summary, counts, live }]` + `totals: { tables, folders, documents, columns, chunks }`. Tous les nouveaux champs **additifs** (clients existants ne cassent pas).
- **`profileScopesBodySchema` assoupli (2026-05-09)** : `sources: z.array(z.string())` sans `.min(1)`. Un profile sans source assignée est sémantiquement valide (création progressive, ou admin qui décoche tout dans l'UI). Le commentaire JSDoc en tête du schema documente cette décision.

**Tests** :

- `ee/rag-core/src/__tests__/rag-access-state.test.ts` — **15 tests** sur les 3 helpers purs (state derivation, scope payload building, counters)
- `packages/cli/src/routes/__tests__/profile-scopes.test.ts` — **22 tests** au total :
  - 4 fallback path : preview avec `ragRuntime` absent (allowAll, allowList, naive counts, totals zéro)
  - 3 live path (ajoutés 2026-05-09 fin de session) : `allowAll` SQL counts (3 docs / 2 folders / 5 chunks sur fixture), `allowList` folder+doc union (2 docs / 1 folder / 3 chunks), soft-delete filter (d4 ignoré dans `allowedDocuments`)
  - 1 test de validation `sources: []` accepté (200, profile sans source)
  - 14 autres existants (POST happy/error paths, GET preview pour relational, multi-source, etc.)
- **Total : 790 tests verts** (28 sso + 204 core + 53 rag-core + 72 connectors + 433 cli) — vs. 768 avant cette tranche, soit **+22 tests** sans régression. Validé 2026-05-09.

**Validation technique 2026-05-09 (avant commit)** :

- ✅ `pnpm lint` (script global `eslint packages/*/src/**`) : 0 erreur, 0 warning
- ✅ `npx eslint ee/rag-core/src/...` ciblé sur les nouveaux fichiers BUSL : 0 erreur après fix d'un warning `no-unused-vars` (`FolderNode` import inutile retiré dans `RagAccessSelector.tsx`). À noter : le script lint global ne couvre **pas** `ee/*/src/` aujourd'hui — gap connu, à fixer en Phase 5 cleanup.
- ✅ `pnpm build` : tous les 7 packages compilent (TS strict, no `any`). Bundle Vite 675 kB (warning chunk size existant, non-bloquant).
- ✅ `pnpm test` : 786 tests passants, 0 échec.

**Findings 2026-05-09 — vérifications de cohérence avant commit** :

- ✅ **Contract POST cohérent** : `RagAccessSelector` POST `{ sources: string[], scopes: Record<id, ScopeSelection> }` sur `/api/profiles/:name/scopes` (ligne 878 du composant), accepté tel quel par `profileScopesBodySchema` côté `profile-scopes.ts:45`. Pas de drift de format.
- ✅ **Préservation des sources DB du profile** : la boucle de save itère uniquement sur `sourceNodes` (sources RAG visibles dans le composant). Les sources DB présentes dans `initialSources` ne sont **jamais** retirées de `updatedSources`. Conclusion : décocher des dossiers RAG ne supprime pas les tables DB du profile.
- ✅ **~~Edge case `sources: []` non géré~~ → résolu 2026-05-09** : `profileScopesBodySchema` assoupli (`z.array(z.string())` sans `.min(1)`) — un profile sans aucune source assignée est sémantiquement valide. Test correspondant changé : « returns 400 when sources is empty » → « accepts an empty sources array (profile with no source assigned) » qui vérifie le 200 + `sources/scopes` vidés à la persistance.
- ✅ **~~Trou de couverture path `live: true`~~ → résolu 2026-05-09** : 3 tests ajoutés dans `profile-scopes.test.ts` (allowAll, allowList folder+doc union, soft-delete filter). Le test crée les tables `rag_folders/rag_documents/rag_chunks` à la main avec un fixture connu (1 source `kb`, 2 folders, 4 docs dont 1 soft-deleted, 5 chunks), set `state.ragRuntime = {}` (truthy suffit), et vérifie les counts SQL exacts. **22 tests** dans le fichier (vs. 19 auparavant). `state` promu au scope du `describe` pour rendre les tests plus testables.

**QA Review (2026-05-09) — verdict ✅ GO pour commit, score 8.5/10** :

L'agent `opensmith-qa-reviewer` a passé en revue la tranche complète. Aucune faille critique. Trois findings importants notés comme dettes techniques. **Deux résolus dans la même session, un reporté post-commit** :

- ✅ **~~N+1 queries en mode `allowList`~~ → résolu 2026-05-09** : `profile-scopes.ts:298-355` réécrit. La boucle `for…of allowedFolderPaths` (ex-N+1) est remplacée par 3 requêtes constantes :
  1. Un seul `SELECT d.id FROM rag_documents d JOIN rag_folders f ON f.id = d.folder_id WHERE … AND f.path IN (?,?,...)` qui ramène tous les docs sous les folders allowed
  2. Un seul `SELECT id FROM rag_documents WHERE id IN (?,?,...) AND deleted_at IS NULL` qui valide les docs explicites
  3. Le COUNT chunks final inchangé (déjà en une seule requête)
  
  Pour 50 folders + 50 docs explicites : passe de ~100 requêtes à 3. Les 22 tests `profile-scopes.test.ts` couvraient déjà le path `live: true` (allowList folder+doc union, soft-delete) — ils ont validé le refactor sans modification.

- ✅ **~~Test runtime `serve.ts` pour `sources: []`~~ → ajouté 2026-05-09** : nouveau test 8 dans `serve-adapter-tools.test.ts` (« empty sources array: no adapter is called, fallback registers 0 tools »). Découverte : la condition `hasNewShape` exige `Object.keys(profile.scopes).length > 0`, donc un profile avec `scopes: {}` retombe sur le path legacy. Le legacy path appelle `registerDynamicTools` **une fois avec `tables: []`** pour câbler le handler MCP `tools/list` (sinon le serveur retourne `-32601 MethodNotFound`). Comportement intentionnel, désormais codifié par un test.

- 🟠 **`RagAccessSelector` = God Component (1133 lignes)** : tout dans une seule fonction, pas de découpage en `<SourceRow>` / `<FolderTreeNode>` / `<SaveFooter>`. Maintenabilité à terme dégradée. Tests sur le composant lui-même = 0 (les 15 tests sont sur les helpers purs). **Reporté post-commit** (refactor trop gros pour cette session).

- ✅ ~~**Cast `unknown` pour `ScopeSelection`**~~ → **résolu 2026-05-11** (commit `269685d`). Diagnostic affiné : la divergence n'était pas sur `TableToolOptions` (structurellement identique entre `packages/web/src/types/schema.ts:50` et `packages/core/src/introspect/types.ts:28`) mais sur l'union `ScopeSelection` — le mirror web n'avait que les 2 arms `relational | document` alors que le core en a 3 (`api` ajouté avec le commit `22ab106`). Fix : ajout du même arm `api` au mirror web (toujours préservé inertement par les composants). Les **4** casts `as unknown as Record<string, ScopeSelection>` (App.tsx:2738, 2750, 3564, 3584) sont supprimés. Drive-by : les fallbacks SSO `() => null` (incompatibles avec le typing strict de `React.lazy`) sont passés à `() => <></>`. `pnpm typecheck` web : 0 erreur (vs. 1 avant).

Suggestions cosmétiques (à ramasser au fil du temps) : enrichir la JSDoc du `GET /preview` pour expliquer la sémantique `allowAll` vs `allowList` ; error boundary autour du Suspense de `AddSourceModal`/lazy KB ; commentaire sur la bascule auto-include → strict dans `RagAccessSelector` (ligne ~797-817).

Points positifs relevés : tests fixture SQL réalistes, lazy loading propre avec fallback, migration legacy seamless via `upgradeProfileShape` aux 2 boundaries, backward-compat des deep-links `/connections` et `/knowledge`, sécurité SQL OK (parametrized queries partout, le `IN (${placeholders})` du preview est safe car les `?` sont générés depuis `idList.map(() => '?')`).

**Reste à faire avant commit** :

1. Smoke test manuel E2E : créer un profile → ajouter une KB scope → cocher quelques dossiers en auto-include → save → vérifier que `/serve/:profile/mcp` expose bien `rag_search` filtré sur ces dossiers
2. Vérifier le rendu `KnowledgeBaseManagerComponent` passé en prop quand `RagAccessSelector` n'est PAS encore lazy-loaded (chemin froid)
3. Décider du sort des fichiers `connections-old.tsx` / `KnowledgeBaseManager` orphelins dans la Sidebar legacy (Phase 5 du plan unifié)
4. Commit (le QA a donné le go)

**Issues à ouvrir post-commit** :

- ✅ ~~Refactor `RagAccessSelector` en sous-composants~~ → **livré 2026-05-11** (commit `7adeb0f`). 6 sous-composants file-internal extraits : `TriStateCheckbox`, `FolderModeBadge`, `DocumentRow`, `FolderRow` (récursif), `SourceRow`, `SaveFooter`, `ToastList`. La fonction principale `RagAccessSelector` passe de **635 → 459 lignes (-27.6%)**. État centralisé (pas de lifting), `useCallback` deps préservés, **0 changement d'API externe** (les 9 props Phase 4 + Phase 6 intactes), Tailwind classes inchangées. Safety net = les 26 tests purs `rag-access-state.test.ts` + 38 tests `source-adapter.test.ts` — tous verts. QA score 10/10.
- ✅ ~~Clarifier le typing de `ScopeSelection`~~ → **livré 2026-05-11** (commit `269685d`, cf. section "Issues à ouvrir post-commit" ci-dessus pour le détail).
- ✅ ~~Couverture composant pour `RagAccessSelector`~~ → **livré 2026-05-11** (commit `74fa152`). Les 2 toggle handlers (`handleToggleFolder`, `handleToggleDocument` — y compris la bascule `auto-include → strict` avec pré-cochage des autres docs) ont été extraits en helpers purs `applyToggleFolder` / `applyToggleDocument` dans `rag-access-state.ts`. 11 nouveaux tests dans `rag-access-state.test.ts` (5 + 6) couvrent : mode switching, pré-cochage à la bascule, strict toggle add/remove, immutabilité, no-op sur folderId inconnu. Trade-off vs `@testing-library/react` + `jsdom` : on garde la dette de zéro JSX-level tests sur le composant lui-même, mais on évite d'ajouter une dep + un setup vitest spécifique. La logique métier est désormais 100 % couverte par 26 tests purs (15 ancien + 11 nouveau).

### 🚧 En cours 2026-05-09 — Phase 5 du plan unifié : Cleanup (partiel, non commité)

Phase 5 du plan unifié (`docs/sources-unified-plan.md` §2) prévoit 4 sous-tâches. Cette session livre **3** ; la 4e est trop grosse pour cette tranche et reportée.

**✅ Livré dans cette session** :

- **ESLint rule `no-cross-license-import` ciblée RAG** (`.eslintrc.cjs` étendu) : nouveau `overrides` qui interdit les **value imports** statiques de `@calame-ee/rag-*` depuis `packages/**`. Les **type imports** (`import type`) sont autorisés (erased au build, aucun couplage runtime). La rule s'appuie sur `@typescript-eslint/no-restricted-imports` avec `allowTypeImports: true`. Validée : `pnpm lint` reste à 0 erreur, le seul import `@calame-ee/rag-core` du code Apache (`packages/cli/src/rag-runtime.ts:13`) est déjà en `import type`.

  **Limitation explicite documentée dans le commentaire** : la rule ne couvre PAS `@calame-ee/sso` aujourd'hui car `packages/cli/src/app.ts:25`, `packages/web/src/App.tsx:16` et 2 autres fichiers ont des value imports statiques préexistants. Migration SSO en dynamic = tranche séparée future.

- **JSDoc enrichie sur `GET /api/profiles/:name/scopes/preview`** : explique précisément la sémantique de comptage par kind (`relational`, `document` mode `allowAll`, `document` mode `allowList`), les requêtes SQL sous-jacentes (les 3 queries constantes après le fix N+1), et la sémantique du `live: false` quand RAG est désactivé. Cible : un futur dev qui touche au handler n'a plus besoin de lire 100 lignes de SQL pour comprendre.

- **Commentaire JSDoc sur `handleToggleDocument`** dans `RagAccessSelector.tsx` : décrit explicitement les 2 cas (auto-include → bascule strict avec pré-cochage des autres docs ; strict → simple toggle). Ferme la suggestion cosmétique #4 du QA review.

**🟡 Audit fin + amorce de migration (2026-05-09)** :

L'audit grossier annonçait 166 call sites — chiffre **inflé** parce qu'il incluait `state.connections`, `fileData.connections`, `group.selectedTables` (variables locales sans rapport avec `Profile.X`). Re-grep avec pattern `(profile|p|prof|sp).<field>` : **42 reads sur 9 fichiers**.

Catégorisation par tier :

| Tier | Fichiers | Reads | Notes |
|---|---|---|---|
| 1 — Backend critique | `serve.ts` (8), `profile-preview.ts` (5), `serve-status.ts` (7), `chat-profile.ts` (3) | 23 | Path legacy actif quand `scopes` vide. Migration via les nouveaux accessors |
| 2 — Routes dérivées | `profiles.ts` (4), `onboarding.ts` (1) ✅ | 5 | onboarding migré (cf. ci-dessous), profiles.ts a 2× la même logique "default si connections vide" — facile |
| 3 — Frontend (web) | `App.tsx` (8), `ServePanel.tsx` (3) | 11 | Lié au `ScopeSelection` mirror et `buildProfilesData`. Migrable mais demande de toucher au type miroir |
| 4 — Doc/test | `migrate.ts` (2 commentaires), `serve-adapter-tools.test.ts` (1 commentaire) | 3 | Inerte — uniquement des commentaires expliquant le legacy |

**Amorce livrée 2026-05-09 (non commité)** :

Plutôt que de migrer en aveugle, j'ai posé le **pattern de migration** que les 4 PR suivants pourront reprendre :

- **`packages/core/src/sources/accessors.ts` (NEW)** : 5 helpers exportés depuis `@calame/core` :
  - `getProfileTableNames(profile)` → `string[]` (toutes les tables des relational scopes ou fallback `selectedTables`)
  - `getProfileSelectedTables(profile)` → `Record<table, columns[]>` (legacy projection)
  - `getProfileTableOptions(profile)` → `Record<table, TableToolOptions>`
  - `getProfileColumnMasking(profile)` → `Record<table, Record<column, ColumnMasking>>`
  - `getProfileRelationalSources(profile)` → `string[]` (sources de kind `'relational'` ou fallback `connections`)
  - Chaque accessor : (1) lit depuis `profile.scopes` en agrégeant tous les relational scopes ; (2) fallback sur le legacy field si `scopes` vide ; (3) retourne le default approprié si rien.

- **`packages/core/src/sources/__tests__/accessors.test.ts` (NEW)** : 13 tests qui couvrent unified-shape, fallback legacy, multi-source merge, cas vide.

- **`packages/cli/src/routes/onboarding.ts`** : premier call site migré (1 read remplacé par `getProfileTableNames(profile)`). Comportement identique pour les profiles legacy ET les profiles à scopes — confirmé par le test `accessors.test.ts:fallback`.

**Plan d'attaque pour la suite (sessions futures)** :

1. ~~Helpers + tests centralisés~~ → ✅ livré
2. ~~Migrer Tier 1~~ → ✅ **4/4 livrés 2026-05-09 fin de session** :
   - `chat-profile.ts` : `loadProfileFromDb` simplifié (raw JSON → `upgradeProfileShape` au lieu de projection à la main, 11 lignes → 4 lignes)
   - `serve-status.ts` : 2 endroits (load DB, build from request body) remplacés par `upgradeProfileShape`. La logique "default if empty" passe par `getProfileRelationalSources`.
   - `profile-preview.ts` : 4 reads remplacés par `getProfileSelectedTables` / `getProfileTableOptions` / `getProfileColumnMasking` / `getProfileRelationalSources`. Type local du body étendu avec `sources?` / `scopes?`.
   - `serve.ts` legacy path (lignes 379-394) : pareil, accessors partout. **Bug latent corrigé** : avant, le fallback "live connections quand profile.connections vide" ne matchait que sur la **présence** du field, pas sur la **résolution** des sources. Maintenant le filtre `state.connections.has(id)` fan-out vers `state.connections.keys()` quand aucun sourceId du profile ne match — couvre le cas du migrateur qui synthétise un placeholder `'default'` pour un legacy profile sans `connections`.
   - Mocks `@calame/core` mis à jour dans `serve-empty-profile.test.ts` et `serve-adapter-tools.test.ts` (passthrough mocks pour les 4 accessors)
3. ~~Type `selectedTables` rendu optionnel~~ : `ServeProfile.selectedTables: Record<string, string[]>` (required) → `?: Record<string, string[]>` (optional). Permet aux call sites qui ne populate que `scopes` de type-check, sans casser le comportement runtime (fallback `?? {}` partout).
4. ~~Tier 4 (commentaires)~~ → ✅ livré : `migrate.ts` mis à jour pour référencer les accessors au lieu du legacy direct ; `serve-adapter-tools.test.ts` commentaire reformulé.
5. ~~Tier 3 frontend~~ → ✅ **complet 2026-05-09 fin de session** :
   - `ServePanel.tsx` migré (3 reads → `getProfileTableNames` + `getProfileRelationalSources`)
   - Helper `packages/web/src/lib/profile-accessors.ts` créé (mirror minimal côté web — `getProfileTableNames`, `getProfileRelationalSources`, `pickMaskingTargetSourceId`)
   - `App.tsx` : logique `handleGlobalMaskingRulesChange` migrée — écrit désormais dans `scopes[targetSid].columnMasking` (target résolu via `pickMaskingTargetSourceId` : premier scope relational, sinon premier connection legacy, sinon `'default'`). Le legacy field reste populé en parallèle pour rétro-compat inerte.
   - `App.tsx.buildProfilesData` nettoyé : drop des projections `selectedTables/tableOptions/columnMasking/connections` du payload save. Le backend `upgradeProfileShape` au save fold tout dans `scopes/sources`.
   - `App.tsx` load : drop des fallbacks `?? ['default']` / `?? {}`. Le frontend reçoit déjà la shape unified du backend.
   - `Profile.selectedTables/tableOptions/columnMasking/connections` côté `packages/web/types/schema.ts` **supprimés du type** (pas juste optional — vraiment droppés).
6. ~~Migration boundary du `upgradeProfileShape`~~ → ✅ **livré** : le migrateur **drop** désormais les legacy root fields après les avoir foldés dans `sources/scopes`. Profiles persistés en SQLite après cette tranche n'auront plus que la shape unified. Bonus fix : quand `connections` est absent mais `selectedTables` existe, le migrateur synthetise `sources: ['default']` correctement (avant, `sources` restait `undefined` malgré `scopes: { default: ... }` — incohérence interne corrigée).
7. **Validation côté `validateProfiles`** (`packages/cli/src/routes/profiles.ts`) : utilise désormais `getProfileSelectedTables` pour générer les warnings — couvre les 2 shapes.
8. **Tests `migrate.test.ts`** mis à jour : 4 assertions « preserves legacy fields » → « drops legacy fields after folding ». 4 tests `profiles.test.ts` migrés vers les nouveaux paths `scopes[sourceId].selectedTables`.
9. ~~Retrait absolu des `@deprecated` du type `ServeProfile` core~~ → ✅ **livré 2026-05-09 fin de session** :
   - `ServeProfile` type purgé : `connections`, `selectedTables`, `tableOptions`, `columnMasking` **complètement supprimés**. Seul commentaire restant : un bloc qui pointe vers `ProfileScopeShape` pour les call sites qui doivent encore accepter la shape legacy en input.
   - 25 fixtures de tests fixées : la majorité avait juste `selectedTables: {}` (vide, retiré sans ré-écrire), 2 fixtures « legacy path » castées via `as unknown as ServeProfile` (intentionnel — testent le fallback runtime), 1 fixture `profiles.test.ts:712` migrée vers la shape unified.
   - 3 reads runtime dans `serve-status.ts` migrés : la logique « default if empty » synthétise maintenant `sources: ['default']` + un scope relational vide ; le merge de configurations écrit dans `scopes[default].selectedTables` au lieu du legacy field.

Le runtime ET le type sont désormais 100 % unified. **Aucun champ legacy ne survit** dans le type `ServeProfile`. La rétro-compat existe uniquement au boundary :
- `upgradeProfileShape` (read boundary) accepte tout JSON brut et fold dans `sources/scopes`
- `ProfileScopeShape` (sub-type pour les accessors) accepte les fields legacy en optionnel pour les call sites qui consomment du JSON pré-migration

- **Drop alias middleware `/api/connections/*` et `/api/rag/*`** : conservé tant qu'aucune release publique n'a publié le header `Sunset: 2026-12-31`. À retirer après une release ≥ 2026-Q3. Reste dans `packages/cli/src/routes/source-aliases.ts`.

**Validation** :

- `pnpm lint` : 0 erreur 0 warning (rule cross-license active)
- `pnpm test` : **803 tests verts** (+13 nouveaux pour `accessors.test.ts` ; 28 sso + 217 core + 53 rag-core + 72 connectors + 433 cli)
- `pnpm build` : OK

**Fichiers modifiés (uncommitted, à grouper avec Phase 4 ou commit séparé)** :

```
NEW packages/core/src/sources/accessors.ts                 (5 helpers + ProfileScopeShape sub-type)
NEW packages/core/src/sources/__tests__/accessors.test.ts  (13 tests)
NEW packages/web/src/lib/profile-accessors.ts              (mirror minimal côté web : 3 helpers dont pickMaskingTargetSourceId)
MOD packages/core/src/sources/index.ts                     (export accessors)
MOD packages/core/src/sources/migrate.ts                   (drop legacy root fields après folding ; sources: ['default'] synthétisé)
MOD packages/core/src/sources/__tests__/migrate.test.ts    (4 assertions « preserves » → « drops »)
MOD packages/core/src/serve/types.ts                       (legacy fields complètement supprimés du type)
MOD packages/cli/src/routes/onboarding.ts                  (1 call site migré vers getProfileTableNames)
MOD packages/cli/src/routes/chat-profile.ts                (loadProfileFromDb passe par upgradeProfileShape)
MOD packages/cli/src/routes/serve-status.ts                (3 endroits migrés : upgradeProfileShape + accessors + écriture dans scopes au lieu de selectedTables root)
MOD packages/cli/src/routes/profile-preview.ts             (4 reads → accessors, type local étendu)
MOD packages/cli/src/routes/serve.ts                       (legacy path : 4 reads → accessors, fix bug fallback live connections)
MOD packages/cli/src/routes/profiles.ts                    (validateProfiles utilise getProfileSelectedTables)
MOD packages/cli/src/routes/__tests__/profiles.test.ts     (4 assertions migrées vers scopes[sourceId] + 1 fixture migrée)
MOD packages/cli/src/routes/__tests__/chat-auth.test.ts    (3 fixtures purgées du legacy selectedTables)
MOD packages/cli/src/routes/__tests__/chat-profile.test.ts (6 fixtures purgées)
MOD packages/cli/src/routes/__tests__/chat.test.ts         (helper makeProfile sans selectedTables)
MOD packages/cli/src/routes/__tests__/serve-empty-profile.test.ts  (3 fixtures purgées + 2 castées en legacy intentionnel)
MOD packages/cli/src/routes/__tests__/serve-adapter-tools.test.ts  (8 fixtures purgées du legacy + 1 castée en legacy intentionnel)
MOD packages/cli/src/routes/__tests__/serve-empty-profile.test.ts   (mocks accessors ajoutés)
MOD packages/cli/src/routes/__tests__/serve-adapter-tools.test.ts   (mocks accessors + commentaire mis à jour)
MOD packages/web/src/types/schema.ts                       (Profile : drop selectedTables/tableOptions/columnMasking/connections)
MOD packages/web/src/components/ServePanel.tsx             (3 reads → accessors web)
MOD packages/web/src/App.tsx                               (handleGlobalMaskingRulesChange écrit dans scopes ; buildProfilesData et load nettoyés)
MOD .eslintrc.cjs                                          (+30 lignes, rule no-cross-license-import RAG)
MOD packages/cli/src/routes/profile-scopes.ts              (JSDoc enrichi sur GET /preview + fix N+1, ~20 lignes)
MOD ee/rag-core/src/web/RagAccessSelector.tsx              (JSDoc sur handleToggleDocument, ~13 lignes)
```

### ✅ Livré 2026-05-11 — Test E2E RAG ingest → search → MCP (`ee/rag-core/src/__tests__/rag-e2e.test.ts`)

Ferme la priorité #4 « Tests E2E manquants » (priorité haute, cf. liste précédente ligne 389). Couvre la chaîne complète qui restait sans test d'intégration : pipeline d'ingestion réel → SQLite réelle → `DocumentSearchIndex` → handler MCP `rag_search` → masquage PII → audit log.

**3 tests** (24 fichiers / 348 tests verts, +3 vs. 345) :

- **Path A — ingest .txt + search** : `pipeline.ingestDocument(...)` (driver direct, mirror exact de `rag-upload.ts:183`) puis appel du handler MCP `rag_search` capturé via mock `McpServer`. Vérifie chunks/documentId/fileName/text et audit entry `result: 'success'`.
- **Path B — PII masking enabled** : document avec 2 emails, `parseRagPiiConfig(undefined)` (default-on safe-by-default). Vérifie que la réponse ne contient plus `support@example.com` mais `[EMAIL]`, que les chunks SQL **gardent** l'email verbatim (masking response-time only), et que l'audit a `piiRedacted.email >= 2`.
- **Path C — allowList scope** : 2 documents dans 2 dossiers (`docs/public`, `docs/internal`), profile avec `allowedFolders: ['docs/public']`. Vérifie que `rag_search` retourne uniquement les chunks du dossier autorisé alors que la requête SQL sous-jacente en aurait sorti des deux.

**Choix de scope documentés en tête du fichier** :

- **Bypass de la couche multipart `rag-upload.ts`** : formidable exige un vrai HTTP stream et `ee/rag-core` ne dépend pas de supertest. Le test invoque `pipeline.ingestDocument` directement — c'est le seul appel non-trivial que fait le handler upload après le parsing multipart (cf. `rag-upload.ts:183-192`).
- **`SqliteVecStore` remplacé par une `Map`** : le loader natif sqlite-vec est flaky en dev (NODE_MODULE_VERSION mismatches). Fake conforme au contrat `VectorStore` de `types.ts:181-186`.
- **`EmbeddingClient` déterministe char-freq, dim=16, L2-normalisé** : queries identiques → vecteurs identiques, tri stable, zéro flakiness.
- **`DocumentStorage` + `DocumentSearchIndex`** : closures sur la SQLite réelle, mirror exact des closures host `packages/cli/src/rag-runtime.ts:684-800` (storage) et `:842-923` (legacy vector-only branch).

**Pourquoi ce test ferme spécifiquement le gap mentionné dans la liste précédente** :
- Aurait détecté le bug `sourceId` placeholder du commit `781fca4` : le test #1 vérifie `documentId === doc.id` via le JOIN SQL, donc une décorrélation entre les sources du profile et `state.connections` aurait fait remonter une assertion `expect(chunks).toHaveLength(0)`.
- Aurait détecté la régression #5 du shakedown Phase 1.5 (« /sync était un stub ») : `pipeline.ingestDocument` est appelé pour de vrai, transactional, avec embed + persist + vector upsert.
- Aurait détecté la régression PII (#7 de la liste précédente) si le default safe-by-default régressait à `enabled: false` — le test #2 force `piiRedacted.email >= 2`.

**QA review** : score 10/10, aucun bloquant. Voir séquence ci-dessus.

### ✅ Livré 2026-05-08 — Polish UX `ragDisabledReason` (commit `d774228`)

Priorité #2 de la "Prochaine session" précédente.

- `packages/cli/src/state.ts` — champ `ragDisabledReason: string | null`
- `packages/cli/src/rag-runtime.ts` — capture la raison à chaque early-exit (5 cas : EE absent, migrations, dimension mismatch, inspection vec0, sqlite-vec native binding) + clear sur succès
- `packages/cli/src/routes/health.ts` — expose `ragDisabledReason` aux côtés de `ragEnabled` dans `/health`
- `packages/web/src/App.tsx` + `Sidebar.tsx` — entrée nav "Bases de connaissance" rendue **disabled avec tooltip** (au lieu d'être masquée silencieusement) quand le runtime n'a pas pu charger
- Bonus : fix du mock `ai-config.test.ts` qui ne suivait pas la migration v9 (`embedding_dimensions`)

### ✅ Livré 2026-05-07/08 — Refactor "Sources unifiées" Phases 0-3 (commits `3c94610`, `b700af6`, `781fca4`)

Cf. `docs/sources-unified-plan.md` pour le plan complet. Ce qui satisfait directement la roadmap RAG :

**Phases 0-2 (commit `3c94610`)** — Fondations Apache + migration profile shape :
- `packages/core/src/sources/` : types abstraits `Source`, `SourceAdapter`, `Capability`, `SourceSchema` (union discriminée `relational` | `document`), `ScopeSelection`, `SourceAdapterRegistry` singleton
- `packages/connectors/src/db-adapter.ts` : `DatabaseSourceAdapter` (postgresql/mysql/sqlite) qui wrap les connecteurs DB existants par composition, auto-enregistré dans le registre au module-load
- `packages/core/src/serve/types.ts` : `ServeProfile` étendu avec `sources?: string[]` et `scopes?: Record<sourceId, ScopeSelection>` ; anciens champs `selectedTables`/`tableOptions`/`columnMasking`/`connections` marqués `@deprecated`
- `packages/core/src/sources/migrate.ts` : `upgradeProfileShape` / `upgradeConfigurationShape` migrent au boundary (lecture/écriture), shape duale préservée pour rétro-compat
- `packages/cli/src/routes/profile-scopes.ts` : route `POST /api/profiles/:name/scopes` (validation Zod via `sourceAdapterRegistry`) + `GET .../scopes/preview` skeletal
- `packages/cli/src/routes/source-aliases.ts` : middleware de dépréciation logger-only sur `/api/connections/*` et `/api/rag/*` (header `Sunset: 2026-12-31`)
- Wiring : `profiles.ts`, `configurations.ts`, `serve.ts`, `yaml-config.ts` passent par les migrateurs à chaque lecture/écriture

**Phase 3 (commit `b700af6`)** — Couche MCP unifiée + livraison RAG-Phase-2 :
- `packages/core/src/serve/dynamic-tools.ts` : `registerDynamicTools` accepte `toolNamespace?: string` qui préfixe tous les tools registered (calc, list_tables, query, describe, aggregate, join_aggregate, write)
- `ee/rag-core/src/source-adapter.ts` (BUSL) : `DocumentSourceAdapter` qui ship les 5 MCP tools `rag_search`, `rag_list_sources`, `rag_list_folders`, `rag_list_documents`, `rag_get_document` avec filtrage allowlist post-search (invariant §6.3)
- `packages/cli/src/routes/serve.ts` : bloc d'enregistrement réécrit, itère `profile.sources` → résout l'adapter via `sourceAdapterRegistry` → calcule `toolNamespace` (préfixe `<sourceName>_` quand 2+ sources du même kind, sinon vide pour rétro-compat single-DB) → `adapter.registerMcpTools(ctx)`. `calc` hoisté hors de la boucle, registered une seule fois au niveau profile
- `packages/cli/src/rag-runtime.ts` : enregistre automatiquement le `DocumentSourceAdapter` dans le registre après `initRagRuntime` succès (idempotent), construit storage + searchIndex deps en closure (vector store + SQL `rag_chunks/rag_documents/rag_folders`)
- Path legacy préservé : profiles dans l'ancienne shape (sans `scopes`) prennent toujours le chemin `registerDynamicTools` direct, comportement identique à avant

**Fix critique post-shakedown (commit `781fca4`)** :
- Bug : le migrateur synthétisait `'default'` comme placeholder `sourceId` quand `profile.connections` était vide, mais `state.connections` avait la connexion sous un autre nom (ex: `'colis-db'`). Le path adapter rate `state.connections.get('default')` → null → aucun tool DB enregistré → chat répond "je n'ai pas accès aux outils"
- Fix : `serve.ts:registerToolsViaAdapters` reproduit le fallback legacy (`profile.connections?.length ? ... : [...state.connections.keys()]`). Quand un `sourceId` `relational` ne matche aucune live connection, fan-out de la `ScopeSelection` sur toutes les connexions DB disponibles. Test mis à jour en conséquence

**Statut RAG-spécifique après Phase 3 du plan unifié** :
- ✅ MCP tools `rag_*` opérationnels en serveur (un client MCP qui tape `/mcp/<profile>` les voit quand le profile a un scope `kind: 'document'`)
- ✅ Filtrage allowlist par profile (mode `allowAll` ou `allowList` avec `allowedFolders` / `allowedDocuments`)
- ✅ Tool namespacing multi-source : profile avec 2 KB → `kb1_rag_search`, `kb2_rag_search`. Profile single-KB → pas de préfixe (rétro-compat)
- ✅ Audit log unifié format DB/RAG via `ctx.onAuditLog`
- ⚠️ **Pas encore d'UI** pour assigner un scope `document` à un profile. Aujourd'hui ça se fait via `POST /api/profiles/:name/scopes` à curl. UI = Phase 4 du plan unifié (`SourcesPage` tabbed + `ProfileManager` multi-kind + `RagAccessSelector`)

**Tests** :
- 768 tests verts au total (28 sso + 204 core + 38 rag-core + 72 connectors + 426 cli)
- Couverture nouvelle : registry (14), profile migrate (41), DB adapter (21 dont test forwarding `toolNamespace`), document adapter (38), serve adapter-driven (7), tool namespacing (10), profile-scopes routes (15), source-aliases (8)

### ✅ Livré — Phase B (fondations)

- Packages `ee/rag-core` et `ee/rag-connectors` créés sous BUSL-1.1, calqués sur `ee/sso/`
- Types complets dans `ee/rag-core/src/types.ts` : `RagSource`, `RagFolder`, `RagDocument`, `RagChunk`, `RagJob`, `ProfileRagAccess`, `VectorStore`, `EmbeddingClient`, `RagSearchResult`
- Interface `DocumentSourceConnector` dans `ee/rag-connectors/src/types.ts` (avec `sourceId` comme 2e param)
- Extension du type `AiSetting` (`packages/cli/src/ai-config.ts`) : `capabilities: ('chat'|'embeddings')[]`, `embeddingModel?: string`, `embeddingDimensions?: number`
- Helper exporté `settingSupports(setting, capability)`
- Migrations SQLite v8 (capabilities + embedding_model) et v9 (embedding_dimensions)

### ✅ Livré — Phase A (= Phase 1 du plan)

**ee/rag-core (BUSL-1.1)** — backend complet :
- `storage/schema.ts` : `runRagMigrations` indépendamment versionnée (`rag_schema_version`), tables `rag_sources/folders/documents/chunks/jobs` + indexes + colonne `embedding_dimensions` v2
- `storage/sqlite-vec-store.ts` : `SqliteVecStore` (vec0 fixed-dimension), errors typées (`SqliteVecLoadError`, `SqliteVecDimensionMismatchError`), helper `resetVecTableIfDimensionMismatch` (auto-heal quand 0 chunks)
- `chunker/token-chunker.ts` : `chunkText` avec `o200k_base` (gpt-tokenizer), 512 tokens / 64 overlap
- `embeddings/openai-client.ts` : `OpenAiCompatibleEmbeddingClient` (batch 96), factory `createEmbeddingClient`
- `parsers/{pdf,docx,markdown,csv,html,index}.ts` : 5 parsers + identity pour text/plain. PDF via `unpdf`, DOCX via `mammoth`, MD via `unified+remark+mdast-util-to-string`, CSV via `papaparse`, HTML via `node-html-parser`
- `pipeline/ingest.ts` : `IngestionPipeline.ingestDocument` avec sha256 short-circuit, transactional persist
- `routes/{rag-sources,rag-content,rag-upload,rag-index,rag-search}.ts` : 9 endpoints, zod-validated, audit hook
- `routes/api-types.ts` : `RagSourcePublic` (projection API avec `config: object` déchiffré, plus `configEncrypted`)
- `routes/types.ts` : `RagRouteDeps` avec `resolveEmbeddingClient`, `resolveEmbeddingSetting`, `resolveConnector`, `encryptConfig/decryptConfig`, `onAudit`. Type `ConnectorLike` (duck-typed).

**ee/rag-connectors (BUSL-1.1)** :
- `local-folder.ts` : `LocalFolderConnector` (sha256 streaming, glob filtering, doc IDs `path:base64url(relPath)`, `safeResolveUnderRoot` anti path-escape)
- `utils.ts` : `streamSha256`, `matchGlobs` (minimatch), `safeResolveUnderRoot`, `deterministicId`
- Interface `DocumentSourceConnector` modifiée : `sourceId: string` ajouté en 2e param de `listFolders/listDocuments/fetchDocument`. `parent`/`folder` typé `RagFolder` plein.

**ee/rag-core/src/web (BUSL-1.1)** — 5 composants React :
- `KnowledgeBaseManager.tsx` : page principale (header + liste sources + panneau détail)
- `SourceForm.tsx` : create/edit source avec dropdown filtré sur `capabilities.includes('embeddings')`, gestion 409 dimension
- `FolderTreeView.tsx` : arborescence lazy via GET `/api/rag/sources/:id/folders|documents`
- `DocumentUploader.tsx` : drag & drop, 50 MB cap, MIME whitelist
- `IngestionStatusCard.tsx` : polling `/api/rag/jobs?sourceId=...` toutes les 2s
- `api.ts` : helpers `apiGet/Post/Patch/Delete/Upload` + `ApiError`

**packages/cli** :
- `crypto.ts` : `encryptString`/`decryptString` (AES-256-GCM, IV 12 octets, auth tag 16 octets), `deriveKeyFromEnv()` (SHA-256 de `CALAME_ENCRYPTION_KEY`, throw en prod si absent, dev fallback avec warn). 32 tests.
- `rag-runtime.ts` : `initRagRuntime` (lazy import `@calame-ee/rag-core` + `rag-connectors`), pré-construit `vectorStore`, `pipeline`, et tous les resolvers. Auto-heal vec0 au boot via `resetVecTableIfDimensionMismatch`.
- `state.ts` : champ `_ragRuntime?: RagRuntime` (import type only)
- `app.ts` : registration synchrone des 5 routes RAG si runtime chargé
- `index.ts` : boot order = `aiSettingsManager` → `await initRagRuntime(...)` → `createApp(...)`
- `package.json` : `@calame-ee/rag-core` et `@calame-ee/rag-connectors` en `workspace:*`. `formidable` + `@types/formidable` pour upload.
- Routes `ai-settings.ts` : test connection adaptatif (chat OU embeddings selon capabilities), probe automatique `/v1/embeddings` au save d'une AI Setting avec capability `embeddings` → dimension capturée

**packages/web** :
- `AiSettings.tsx` : section « Capacités » (toggles chat/embeddings + champs modèle), badge par capability dans la liste, Anthropic disable embeddings avec tooltip
- `App.tsx` : vue `'knowledge'` avec lazy import depuis `@calame-ee/rag-core/web` + fallback gracieux
- Sidebar conditionnelle sur `/api/health.ragEnabled`
- `tailwind.config.ts` : content paths étendus à `ee/rag-core/src/web/**` et `ee/sso/src/web/**`
- `package.json` : `@calame-ee/rag-core` en `workspace:*` (nécessaire pour Rollup résoudre l'import dynamique)

**packages/cli — endpoint `/api/health`** :
- Champ `ragEnabled: boolean` reflétant `state.ragRuntime !== undefined`

### 🩹 Fixes runtime appliqués pendant le shakedown (Phase 1.5)

Quand on a démarré pour tester en vrai, plusieurs choses cassaient. Voici les correctifs :

1. **Test connection AI Settings** (`packages/cli/src/routes/ai-settings.ts`) — la fonction `testConnection` appelait toujours `/chat/completions`, donc échouait sur les modèles embeddings-only. **Fix** : sélectionne l'endpoint selon `capabilities` (chat → `/chat/completions`, embeddings-only → `/embeddings`, les deux → chat est plus complet). Anthropic + embeddings → erreur explicite.

2. **`KNOWN_MODEL_DIMS` hardcodé** (`packages/cli/src/rag-runtime.ts`) — c'était une liste de 9 modèles avec leur dimension. Mauvaise idée : il existe des centaines de modèles d'embeddings, en maintenir une liste est impossible. **Fix** : suppression de la map. Au save d'une AI Setting avec capability `embeddings`, le serveur appelle `/v1/embeddings` avec `input: "probe"` et lit la dimension du vecteur retourné. Persistée dans `ai_settings.embedding_dimensions`. Le resolver lit directement cette colonne. Migration v9 ajoute la colonne.

3. **vec0 dimension mismatch au boot** — quand l'admin change de modèle d'embeddings (donc de dimension), la table `rag_chunks_vec` qui a sa dim figée à la création plante au prochain boot. **Fix** : nouveau helper `resetVecTableIfDimensionMismatch(db, requestedDim)` dans `ee/rag-core/src/storage/sqlite-vec-store.ts`. Auto-heal au boot : drop+recrée si la dim a changé ET `rag_chunks` est vide. Refuse le drop si des chunks existent (protection anti-perte). Le runtime appelle ce helper avant de construire le `SqliteVecStore`.

4. **`formidable` introuvable** — l'agent Round 1 avait fait un `dynamic specifier` import de `formidable` côté `ee/rag-core/src/routes/rag-upload.ts`, en attendant que le host installe le package. Ni Round 2 (wiring CLI) ni le QA n'ont relevé le manque. **Fix** : `formidable` ajouté en dependency de `ee/rag-core`. Erreur 501 « Multipart parsing requires formidable » résolue.

5. **`/sync` était un stub** — l'agent Round 1 avait écrit un placeholder qui créait juste un `RagJob` pending et retournait 202, sans appeler le connector ni ingérer quoi que ce soit. Justifié à l'époque par « `LocalFolderConnector` lands in follow-up PR » — mais Round 2 a oublié de revenir le câbler. **Fix** :
   - Nouveau type `ConnectorLike` dans `routes/types.ts` (duck-typé, évite la dépendance circulaire ee/rag-core ↔ ee/rag-connectors)
   - Nouveau dep `RagRouteDeps.resolveConnector?: (type: string) => ConnectorLike | null`
   - `rag-runtime.ts` pré-charge `@calame-ee/rag-connectors` au boot et instancie un `LocalFolderConnector` à la demande
   - `rag-index.ts` réécrit le handler `/sync` : walk récursif via `connector.listFolders/listDocuments`, fetch chaque doc, ingest via `pipeline.ingestDocument`, met à jour `rag_jobs.processed_documents` et `progress` en temps réel. Marque `completed` ou `failed` selon le nombre d'erreurs.
   - Limitation Phase 1 : sync **synchrone bloquante** (le HTTP attend la fin). Pour gros corpora, le browser timeout. Phase 4 fera un job async + queue.

6. **Auto-détection `KNOWN_MODEL_DIMS` côté tests** : modèles Qwen3-Embedding ajoutés (8b/4b/0.6b) — devenus inutiles avec le fix #2 mais restent inoffensifs (la map n'est plus consultée).

### 🔧 Décisions Phase 0 toutes validées

| # | Décision | Statut |
|---|---|---|
| 1 | Vector store : sqlite-vec | ✅ |
| 2 | Embeddings : réutilisation `AiSettings` (auto-probe) | ✅ |
| 3 | Open-core : tout BUSL en `ee/` | ✅ |
| 4 | Parser PDF : `unpdf` | ✅ |

### 🛑 Limitations restantes (mis à jour 2026-05-11)

- **Une seule dimension d'embedding par instance** (sqlite-vec exige une dim fixée au create de la virtual table). Auto-heal possible si rag_chunks est vide (cf. fix #3). Phase 5 du plan original prévoyait un vec0 par dimension — **toujours d'actualité**.
- **OCR PDF scannés absents** (§12 Q8, Tesseract) — les PDF scannés sont indexés vides. Scope futur, faible priorité — sera dans un `ee/rag-ocr` package quand un client en aura besoin.
- ~~**Sync synchrone bloquante**~~ → ✅ **résolu** : `SyncQueue` FIFO + dedupe per-sourceId + HTTP 202 immédiat (cf. `ee/rag-core/src/jobs/sync-queue.ts`, `ee/rag-core/src/routes/rag-index.ts:605-672`).
- ~~**Connecteurs externes absents**~~ → ✅ **résolu** : `ee/rag-connectors/src/{local-folder,s3,http}.ts` + connecteurs SaaS dédiés (`ee/rag-gdrive`, `ee/rag-gsheets`, `ee/rag-notion`, `ee/rag-microsoft`).
- ~~**Watch incrémental absent**~~ → ✅ **résolu** : `WatchManager` (chokidar) + `PollScheduler` partagent un `triggerSync` qui passe par la `SyncQueue` pour dedupe (cf. `ee/rag-core/src/jobs/watch-manager.ts`, `poll-scheduler.ts`).
- ~~**PII detection non appliquée** sur les chunks (cf. §12 question 5)~~ → ✅ **résolu** par le commit `423c81a` (« mask PII in chunks before returning to LLM »). Décision actée : on applique le **même** `applyPiiMasking` que les colonnes DB (vient de `@calame/core`, partagé via `ee/rag-core/src/pii-masking.ts`). Masking en réponse MCP (pas en ingestion) — cohérent avec le pattern DB où la masque est en RESPONSE-time aussi. Couvert par le test E2E Path B (`rag-e2e.test.ts`, commit `6df0fed`) qui vérifie 2 emails masqués + audit `piiRedacted.email >= 2`.
- ~~**Tests E2E manquants**~~ → ✅ **résolu** par le commit `6df0fed` (`ee/rag-core/src/__tests__/rag-e2e.test.ts`). Couvre ingest → search → MCP → PII → allowList.

### ✅ Limitations résolues 2026-05-07/09

- ~~**Pas de profile/MCP** : les routes `rag_*` n'ont pas encore d'`registerRagTools()`~~ → livré via `DocumentSourceAdapter.registerMcpTools` (Phase 3 du plan unifié)
- ~~**MCP `rag_*` tools non enregistrés au runtime serveur**~~ → enregistrés automatiquement quand un profile a un scope `kind: 'document'`
- ~~**Audit log RAG : pas encore intégré au format unifié**~~ → format unifié via `McpRegistrationContext.onAuditLog`, identique pour DB et RAG
- ~~**Polish UX `ragDisabledReason`**~~ → livré dans le commit `d774228`
- ~~**Pas d'UI** pour assigner un scope `document` à un profile~~ → en cours (Phase 4 plan unifié, non commité 2026-05-09) : `RagAccessSelector` (BUSL, 1134 lignes) + `SourcesPage` (Apache, tabbed) + preview live counts. Plus de curl manuel.

### 🟢 Statut technique (2026-05-11)

- `pnpm install` : OK 11 packages workspace (Apache + BUSL EE)
- `pnpm build` : OK tous packages compilent (TS strict, no `any`)
- `pnpm lint` : 0 erreur 0 warning sur `packages/*/src/**`. Rule `no-restricted-imports` étend la boundary open-core à `@calame-ee/*` uniformément (test files exclus). Gap historique sur `ee/*/src/**` toujours non couvert par le script global — validation via `npx eslint ee/...` au cas par cas.
- `pnpm test` : **1596 tests verts** (28 sso + 267 core + 105 connectors + 359 rag-core + 30 web + 67 rag-connectors + 34 gdrive + 42 gsheets + 50 notion + 28 microsoft + 536 cli). +806 vs. 790 du 2026-05-09 — gros bonds essentiellement dans `packages/cli` (auth, tenancy, profile-scopes, serve-adapter-tools, configurations) et les connecteurs SaaS livrés depuis.
- Smoke test 2026-05-08 : chat MCP DB fonctionne (test "donne moi le nombre de colis total" → LLM voit `query_<table>` etc.).
- Smoke test 2026-05-09 : drag & drop d'un .txt → ingestion + chunking + embeddings + sqlite-vec OK.
- ⏳ Smoke test Phase 4 UI (RagAccessSelector → save → MCP filtré, allowAll + allowList) : pas encore fait. Faisable maintenant ; livre quand tu testes.
- ⏳ Smoke test Phase 6 UI (Data Profile tabbed → cocher folders KB → save → un MCP Profile qui référence cette Config voit `rag_search` filtré) : pas encore fait.

### 🔜 Prochaine session — Priorités

1. ~~**Lancer Phase 2** (intégration MCP + profiles)~~ → ✅ **livré** via Phase 3 du plan unifié
2. ~~**Polish UX `ragDisabledReason`**~~ → ✅ **livré** (commit `d774228`)
3. ~~**UI scope document (Phase 4 plan unifié)**~~ → 🚧 **en cours**, non commité 2026-05-09. **Validation technique passée** (lint vert, build vert, 786 tests verts). À finaliser :
   - Smoke test manuel E2E : profile → KB scope → save → MCP server expose `rag_search` filtré sur les dossiers/docs cochés (cas allowAll + allowList)
   - Vérifier qu'au save le `RagAccessSelector` POST bien sur `/api/profiles/:name/scopes` et que le preview en bas du composant se rafraîchit immédiatement après le save (pas de stale UI)
   - Commit & QA review via `opensmith-qa-reviewer`
4. ~~**Tests E2E manquants**~~ → ✅ **livré 2026-05-11** (cf. section dédiée ci-dessus, `ee/rag-core/src/__tests__/rag-e2e.test.ts`). Couvre ingest → search → MCP → PII → allowList. Reste à faire : un test E2E sur le `RagAccessSelector` côté UI (cocher folder → save → preview affiche le bon count) — niveau de priorité ré-évalué à **moyen** (la chaîne backend critique est désormais couverte).
5. **Phase 5 du plan unifié — Cleanup** (5/6 livré 2026-05-11 ; seul reste l'alias middleware bloqué par release schedule) :
   - ✅ ~~Ajouter ESLint rule `no-cross-license-import`~~ → livré (initialement RAG-only, étendu à `@calame-ee/*` le 2026-05-11)
   - ✅ ~~JSDoc enrichi GET /preview + commentaire bascule auto-include/strict~~ → livré
   - ✅ ~~Retirer les `@deprecated` fields de `ServeProfile`~~ → **livré 2026-05-09** (cf. section "🚧 En cours 2026-05-09 — Phase 5", point 9). Le type `ServeProfile` est purgé : `connections`, `selectedTables`, `tableOptions`, `columnMasking` complètement supprimés ; les 23 call sites sont passés par les accessors `getProfile*` de `packages/core/src/sources/accessors.ts`.
   - 📋 Drop alias middleware `/api/connections/*` et `/api/rag/*` après une release avec header `Sunset` (≥ 2026-Q3). **Bloqué par release schedule** — pas par du dev work.
   - ✅ ~~Migrer les value imports statiques `@calame-ee/sso`~~ → **livré 2026-05-11** (commit `90ae706`). `packages/cli/src/sso-runtime.ts` (NEW, mirror exact de `rag-runtime.ts`) lazy-load `@calame-ee/sso` et stash les classes sur `AppState.ssoRuntime`. `app.ts` et `oauth.ts` consomment via le runtime, register les routes OIDC sous `if (appState.ssoRuntime)`. Frontend : 5 composants SSO (`OidcSettings`, `ProfileSsoNotice`, `DataScopingSection`, `SsoLoginButton`, `ChatSsoLogin`) en `React.lazy` + `Suspense` avec fallback gracieux. **Rule ESLint étendue** : `@calame-ee/rag-*` → `@calame-ee/*` (uniforme), test files exclus (`__tests__/**`, `*.test.ts(x)`). 1577 tests verts sur 11 packages, QA score 9.5/10.
   - ✅ ~~Décider du sort de `ConnectionManager.tsx` standalone~~ → **acté 2026-05-11** : **on garde** le composant comme corps du tab `databases` de `SourcesPage` (cf. `SourcesPage.tsx:4` + `:195`). Il n'est plus jamais rendu en standalone — la View `{ page: 'connections' }` est conservée comme **alias legacy** qui route via `<SourcesPage currentTab="databases">` (App.tsx:1154-1168) pour ne pas casser les deep-links existants. Pas de rewrite : ConnectionManager fait ~600 lignes de logique DB CRUD bien isolée, l'inline-r dans SourcesPage gonflerait celui-ci sans bénéfice. Décision documentée, pas de code change.
6. ~~**Sync async (Phase 4 plan original)**~~ → ✅ **livré**. `SyncQueue` FIFO + dedupe per-sourceId, route POST `/sync` retourne 202 immédiat (HTTP 202 + job persisté en `rag_jobs`). `WatchManager` (chokidar) + `PollScheduler` (cron interne) partagent la même queue pour le dedupe. `recoverOrphanedJobs` sweep les jobs `pending`/`running` orphelins au boot. Cf. `ee/rag-core/src/jobs/{sync-queue,watch-manager,poll-scheduler,rate-limiter,soft-delete-cleanup,embedding-cap}.ts` + tests.
7. ~~**Connecteurs externes (Phase 3 plan original)**~~ → ✅ **livré**. `ee/rag-connectors/src/{local-folder,s3,http}.ts` pour le pack de base + packages dédiés pour les SaaS lourds : `ee/rag-gdrive` (service account), `ee/rag-gsheets` (per-tab + header-aware CSV chunking), `ee/rag-notion` (internal integration), `ee/rag-microsoft` (SharePoint via Graph + client credentials). Tous lazy-loadés dans `rag-runtime.ts` — `resolveConnector(type)` retourne `null` si le package n'est pas installé, route répond 501.
8. ~~**Décision PII** (cf. §12 question 5)~~ → ✅ **tranchée et livrée** (commit `423c81a` + couverture par le test E2E `rag-e2e.test.ts:Path B`). Réponse : **OUI**, on applique le même PII detector (`applyPiiMasking` de `@calame/core`) aux chunks avant retour MCP. Localisation : `ee/rag-core/src/pii-masking.ts` (wrapper `maskSearchResult`) ; intégration : `ee/rag-core/src/source-adapter.ts:493-503` ; config via env `CALAME_RAG_PII_MASK` (safe-by-default = enabled). Cohérent avec le pattern DB où le masque est également RESPONSE-time (la DB stocke les valeurs brutes, le masquage s'applique sur le résultat de la query avant retour MCP). Audit log expose les counts par catégorie via `piiRedacted`. Coût : ~1 scan regex par chunk au moment du `rag_search` — négligeable (microsecondes par chunk, dominé par le RTT de l'embedding).
9. ~~**Délivrer un kind `api` ou `stream`**~~ → ✅ **livré** (commit `22ab106` « new kind 'api' validates SourceAdapter abstraction »). `packages/connectors/src/api-adapter.ts` ship un `HttpApiSourceAdapter` (~370 LOC) qui implémente `SourceAdapter<TConfig, { kind: 'api' }, TCaps>` end-to-end : MVP HTTP GET avec scope filtering sur `allowedOperations`, MCP registration via `http_get` tool. **Verdict** : l'abstraction tient — aucun changement d'interface, aucune gymnastic de typage côté host, aucune migration. 47 tests dans `__tests__/api-adapter.test.ts` valident le contrat. Kind `stream` reste TODO mais sera trivial à ajouter sur la même base.

### Fichiers modifiés / créés en récap

**Livraison initiale Phases A + B (2026-05-06)** — pré-pivot stratégique :

```
NOUVEAUX (BUSL-1.1)
ee/rag-core/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── storage/{schema,sqlite-vec-store}.ts
│   ├── chunker/token-chunker.ts
│   ├── embeddings/openai-client.ts
│   ├── parsers/{pdf,docx,markdown,csv,html,index,types}.ts
│   ├── pipeline/ingest.ts
│   ├── routes/{rag-sources,rag-content,rag-upload,rag-index,rag-search,types,api-types}.ts
│   └── web/{api,KnowledgeBaseManager,SourceForm,FolderTreeView,DocumentUploader,IngestionStatusCard,index}.tsx

ee/rag-connectors/
├── package.json
├── tsconfig.json
└── src/{index,types,local-folder,utils}.ts

NOUVEAUX (Apache 2.0)
packages/cli/src/rag-runtime.ts

MODIFIÉS (Apache 2.0)
packages/cli/src/{ai-config,crypto,migration,database,state,app,index}.ts
packages/cli/src/routes/{ai-settings,health}.ts
packages/cli/src/__tests__/{ai-config,crypto}.test.ts
packages/cli/{package,tsconfig}.json
packages/web/src/{App,components/AiSettings}.tsx
packages/web/{package.json,tailwind.config.ts}
```

**Polish UX 2026-05-08 (commit `d774228`)** :

```
MOD packages/cli/src/state.ts                        (champ ragDisabledReason)
MOD packages/cli/src/rag-runtime.ts                  (capture aux 5 early-exits)
MOD packages/cli/src/routes/health.ts                (expose dans /health)
MOD packages/web/src/App.tsx                         (lit le champ /health)
MOD packages/web/src/components/Sidebar.tsx          (entrée disabled + tooltip)
MOD packages/cli/src/__tests__/ai-config.test.ts     (fix mock embedding_dimensions)
```

**Phase 4 plan unifié — UI Sources unifiée (en cours 2026-05-09, non commité)** :

```
NOUVEAUX (Apache 2.0)
packages/web/src/components/SourcesPage.tsx                       (259 lignes — page tabbed databases/knowledge)
packages/web/src/components/AddSourceModal.tsx                    (190 lignes — kind picker modal)

NOUVEAUX (BUSL-1.1)
ee/rag-core/src/web/RagAccessSelector.tsx                         (1134 lignes — sélecteur dossiers/docs par profile)
ee/rag-core/src/rag-access-state.ts                               (180 lignes — helpers purs)
ee/rag-core/src/web/rag-access-state.ts                           (re-export pour barrel /web)
ee/rag-core/src/__tests__/rag-access-state.test.ts                (15 tests sur les helpers purs)

MODIFIÉS (Apache 2.0)
packages/cli/src/routes/profile-scopes.ts                         (preview enrichi avec live RAG counts)
packages/cli/src/routes/__tests__/profile-scopes.test.ts          (+4 tests pour live counts)
packages/web/src/App.tsx                                          (view 'sources', RagAccessSelector lazy, buildProfilesData)
packages/web/src/components/Sidebar.tsx                           (Connections → Sources, KB merged)
packages/web/src/types/schema.ts                                  (mirror types ScopeSelection + Profile.sources/scopes)

MODIFIÉS (BUSL-1.1)
ee/rag-core/src/web/index.ts                                      (export RagAccessSelector)
```

**Refactor Sources unifiées Phases 0-3 (commits `3c94610`, `b700af6`, `781fca4`)** — cf. `docs/sources-unified-plan.md` pour le détail :

```
NOUVEAUX (Apache 2.0)
docs/sources-unified-plan.md                                       (plan complet du refactor)
packages/core/src/sources/                                         (7 fichiers : types, registry, selection, mcp-context, migrate, index)
packages/core/src/sources/__tests__/{registry,migrate}.test.ts     (14 + 41 tests)
packages/core/src/serve/__tests__/dynamic-tools-namespace.test.ts  (10 tests)
packages/connectors/src/db-adapter.ts                              (~200 lignes, DatabaseSourceAdapter)
packages/connectors/src/__tests__/db-adapter.test.ts               (21 tests)
packages/cli/src/routes/profile-scopes.ts                          (POST /scopes + GET /preview)
packages/cli/src/routes/source-aliases.ts                          (deprecation middleware)
packages/cli/src/routes/__tests__/profile-scopes.test.ts           (15 tests)
packages/cli/src/routes/__tests__/source-aliases.test.ts           (8 tests)
packages/cli/src/routes/__tests__/serve-adapter-tools.test.ts      (7 tests)

NOUVEAUX (BUSL-1.1)
ee/rag-core/src/source-adapter.ts                                  (DocumentSourceAdapter, 5 RAG MCP tools)
ee/rag-core/src/__tests__/source-adapter.test.ts                   (38 tests)

MODIFIÉS (Apache 2.0)
packages/core/src/{index,serve/types,serve/dynamic-tools}.ts
packages/cli/src/{state,rag-runtime,app}.ts
packages/cli/src/routes/{profiles,configurations,serve}.ts
packages/cli/src/yaml-config.ts
packages/cli/src/__tests__/{yaml-config}.test.ts
packages/cli/src/routes/__tests__/{profiles,serve-empty-profile}.test.ts
packages/connectors/{src/index.ts,package.json}
pnpm-lock.yaml

MODIFIÉS (BUSL-1.1)
ee/rag-core/{src/index.ts,package.json,tsconfig.json}
```

---

## 1. Vision & flux utilisateur cible

L'admin doit pouvoir :

1. **Créer un *espace de connaissance*** (Knowledge Space) — un conteneur logique avec des dossiers et des fichiers.
2. **Y déposer des fichiers** (drag & drop, upload) ou **brancher une source externe** (S3, Google Drive, Google Sheets, SharePoint, URL, Git…).
3. **Enregistrer cet espace comme "connecteur RAG"** (au même endroit conceptuel que les connecteurs DB actuels).
4. **Sélectionner par profile** quels dossiers / fichiers / sources sont accessibles — exactement comme on coche aujourd'hui des tables/colonnes dans `ProfileManager`.
5. **Exposer le tout via MCP** sous forme de tools `rag_*` filtrés par l'allowlist du profile actif.

**Exemple :** un profile « support-client » accède au dossier `kb/produit/faq` (S3) + à `wiki/onboarding` (local) ; le LLM appelle `rag_search({ query, profile })` et reçoit uniquement des extraits issus de ces deux scopes.

---

## 2. Architecture en 3 couches

```
┌─────────────────────────────────────────────────────────────┐
│  Couche 3 — Exposition MCP (rag_search, rag_list, …)       │
│           Filtrée par profile.allowedScopes                 │
├─────────────────────────────────────────────────────────────┤
│  Couche 2 — Index RAG (chunking, embeddings, vector store) │
│       Abstrait derrière une interface RagIndex              │
├─────────────────────────────────────────────────────────────┤
│  Couche 1 — Sources (DocumentSourceConnector)              │
│   Local FS │ S3 │ GDrive │ GSheets │ HTTP │ Git │ …        │
└─────────────────────────────────────────────────────────────┘
```

L'idée clé : le **RAG est l'intermédiaire** entre les sources hétérogènes et MCP. Le LLM ne sait jamais d'où vient un document — il ne voit que des `DocumentChunk` enrichis de leur metadata (`sourceId`, `folder`, `fileName`, `score`).

Cette séparation permet de :

- Brancher de nouvelles sources sans toucher au pipeline d'embedding.
- Changer de vector store (sqlite-vec → pgvector → Qdrant) sans toucher aux connecteurs.
- Réutiliser le pattern Profile/allowlist déjà éprouvé sur les DB.

---

## 3. Modèle de données

### 3.1 Entités

| Entité | Description | Stockage |
|---|---|---|
| `RagSource` | Une source de documents (configuration d'un connecteur : type, credentials, root path, polling interval) | SQLite |
| `RagFolder` | Un dossier logique au sein d'une source (chemin / préfixe S3 / dossier GDrive). Hiérarchique. | SQLite |
| `RagDocument` | Un fichier individuel (id, `sourceId`, `folderId`, `path`, `mimeType`, `hash`, `lastIndexedAt`) | SQLite |
| `RagChunk` | Un chunk indexé (id, `documentId`, `text`, `tokenCount`, `embedding`, `position`) | SQLite + sqlite-vec |
| `RagJob` | État d'ingestion / re-index (status, progress, error) — utile pour l'UI | SQLite |

### 3.2 Liaison Profile ↔ RAG (la question centrale)

Reproduire le pattern `selectedTables: Record<string, string[]>` mais pour le RAG. Trois granularités possibles, **à supporter en parallèle** :

```ts
interface ProfileRagAccess {
  // Sélection au niveau source (tout ce qu'elle contient, présent ET futur)
  allowedSources: string[];            // ["s3-prod-kb", "local-onboarding"]

  // Sélection au niveau dossier (tout ce qu'il contient, récursif, incl. futurs fichiers)
  allowedFolders: Record<string, string[]>;  // { "s3-prod-kb": ["faq/", "guides/"] }

  // Sélection au niveau fichier (allowlist exacte, n'inclut PAS les nouveaux fichiers)
  allowedDocuments: Record<string, string[]>; // { "local-onboarding": ["doc-id-123"] }
}
```

**Réponse directe à "que se passe-t-il si on ajoute un fichier à un dossier dans un profile ?"** :

- Si le profile autorise le **dossier** → le nouveau fichier devient automatiquement accessible dès qu'il est indexé. **C'est le mode par défaut recommandé.**
- Si le profile autorise des **fichiers spécifiques** → le nouveau fichier reste invisible jusqu'à ce que l'admin le coche. Mode utile pour des données sensibles.

L'UI doit afficher clairement ce mode (ex. badge « auto-include » vs « strict »).

---

## 4. Connecteurs de sources

### 4.1 Interface

Calquée sur `DatabaseConnector` (`packages/connectors/src/types.ts`) :

```ts
interface DocumentSourceConnector {
  type: DocumentSourceType;            // 'local' | 's3' | 'gdrive' | 'gsheets' | 'http' | …
  testConnection(config): Promise<void>;
  listFolders(config, parent?): Promise<RagFolder[]>;
  listDocuments(config, folder?): Promise<RagDocument[]>;
  fetchDocument(config, docId): Promise<{ stream: Readable; mimeType: string }>;
  // Optionnel : detect changes for incremental sync
  watch?(config, onChange: (event) => void): Unsubscribe;
  // Optionnel : push-mode (webhooks)
  registerWebhook?(config, callbackUrl): Promise<WebhookHandle>;
}
```

Registry singleton dans `ee/rag-connectors/src/index.ts`, calqué sur le pattern de `packages/connectors/src/index.ts` mais hébergé en BUSL (cf. §10).

### 4.2 Quels connecteurs livrer & dans quel package ?

**Décision** : l'ensemble du RAG est une fonctionnalité premium → tout en `ee/` sous BUSL-1.1 (cf. §10). Les connecteurs sont regroupés par familles techniques, suivant le pattern de `ee/sso/` (un package avec `src/` backend + `src/web/` frontend, exports multiples).

| Connecteur | Package | License | Justification |
|---|---|---|---|
| Local FS | `ee/rag-connectors` | BUSL-1.1 | Brique de base, livrée avec le pack RAG |
| HTTP / URL crawler | `ee/rag-connectors` | BUSL-1.1 | Simple, livré dès la Phase 3 |
| S3 (et compatibles : R2, MinIO) | `ee/rag-connectors` | BUSL-1.1 | Standard de facto, livré dès la Phase 3 |
| Google Drive | `ee/rag-gdrive` | BUSL-1.1 | OAuth Google, maintenance lourde, usage entreprise |
| Google Sheets | `ee/rag-gsheets` | BUSL-1.1 | Idem GDrive |
| SharePoint / OneDrive | `ee/rag-microsoft` | BUSL-1.1 | Entreprise |
| Notion / Confluence | `ee/rag-saas-sources` | BUSL-1.1 | Entreprise |
| Git (repos privés indexés) | `ee/rag-git` | BUSL-1.1 | Niche enterprise |

Les connecteurs « de base » (Local, HTTP, S3) sont regroupés dans un seul package `ee/rag-connectors` pour simplifier l'install et parce qu'ils partagent peu de dépendances. Les connecteurs spécialisés (GDrive, SharePoint, Notion, Git) ont chacun leur propre package — ils tirent des SDK lourds qu'on ne veut pas dans le pack de base.

---

## 5. Pipeline d'indexation

```
[Source]
   │  (1) listDocuments + fetchDocument
   ▼
[Parser]   ──────────  pdf-parse, mammoth (docx), unified (md), papaparse (csv), node-html-parser
   │  (2) extractText → { text, structuredMetadata }
   ▼
[Chunker]  ──────────  Stratégie configurable (cf. §5.2)
   │  (3) splitIntoChunks
   ▼
[Embedder] ──────────  Modèle configurable (cf. §5.3)
   │  (4) embedBatch
   ▼
[Vector Store] ──────  sqlite-vec (default) | pgvector | externe
   │  (5) upsert avec hash → idempotent
   ▼
[Index prêt pour rag_search]
```

### 5.1 Vector store — choix recommandé

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **sqlite-vec** (extension SQLite) | Self-contained, cohérent avec le reste (profiles, audit déjà SQLite), zéro infra | Limité à ~1M vecteurs, recherche brute-force au-delà | ✅ **Default** |
| **pgvector** | Scalable, déjà familier (on parle à Postgres ailleurs) | Requiert Postgres (déjà optionnel) | ⚙️ Option avancée |
| **LanceDB** | Embedded, scalable, columnaire | Dépendance native lourde, moins éprouvée en TS | ❌ Pas maintenant |
| **Qdrant / Weaviate** | Production-grade | Service externe, complexifie l'install | ❌ Pas pour le core |

**Recommandation :** sqlite-vec en default ; abstraire derrière `VectorStore` interface pour pouvoir swap.

### 5.2 Chunking — stratégies

Commencer simple, ouvrir une option avancée plus tard :

- **v1 (core) :** chunking par tokens fixes avec overlap (ex. 512 tokens, overlap 64) — `tiktoken` ou `gpt-tokenizer`.
- **v2 (ee) :** chunking sémantique (split par titres Markdown, sections PDF), structure-aware pour CSV/sheets (1 ligne = 1 chunk avec en-têtes).

### 5.3 Embeddings — réutilisation de l'infra `AiSettings` existante

**Décision clé** : ne **pas** créer d'abstraction `EmbeddingProvider` séparée. OpenSmith dispose déjà d'un système complet de configuration IA (`packages/cli/src/ai-config.ts`, `AiSettingsManager`, route `/api/ai-settings`, composant `AiSettings.tsx`) avec :

- Stockage SQLite (table `ai_settings`)
- Providers `anthropic`, `openrouter`, `custom` — le mode `custom` pointe vers n'importe quel endpoint OpenAI-compatible (Ollama, vLLM, LM Studio, OpenAI direct, etc.)
- Allowlist par profile via `aiSettingNames` (`resolveAiSetting()` dans `ai-resolver.ts`)
- UI complète pour créer / éditer plusieurs configurations nommées

Le RAG **réutilise ce système** plutôt que d'en dupliquer un en parallèle.

#### 5.3.1 Extension du type `AiSetting`

Ajouter deux champs au type existant (`packages/cli/src/ai-config.ts`) :

```ts
interface AiSetting {
  // ... champs existants (name, label, provider, apiKey, model, baseUrl)
  capabilities?: ('chat' | 'embeddings')[];   // ce que la config sait faire
  embeddingModel?: string;                     // modèle distinct du modèle de chat
}
```

Migration SQLite : deux nouvelles colonnes nullable `capabilities TEXT` (JSON array) et `embedding_model TEXT`.

#### 5.3.2 Compatibilité par provider

Tous les providers existants ne savent pas faire des embeddings :

| Provider | Chat | Embeddings | Notes |
|---|---|---|---|
| `anthropic` | ✅ | ❌ | Anthropic ne propose pas de modèles d'embedding |
| `openrouter` | ✅ | ⚠️ Limité | Surtout proxy chat ; quelques modèles d'embedding récemment ajoutés |
| `custom` (Ollama) | ✅ | ✅ | `nomic-embed-text`, `bge-m3` — endpoint `/v1/embeddings` |
| `custom` (OpenAI direct) | ✅ | ✅ | `text-embedding-3-small` — `baseUrl: https://api.openai.com/v1` |
| `custom` (vLLM, LM Studio) | ✅ | ✅ selon modèle | Dépend du modèle servi |

L'admin déclare lui-même les capabilities supportées par chaque setting via deux toggles dans `AiSettings.tsx`.

#### 5.3.3 UI dans `AiSettings.tsx`

Section « Capacités » ajoutée au formulaire d'une AI setting :

```
Provider : [Custom ▼]
Endpoint : http://localhost:11434/v1
Clé API   : (optionnel pour Ollama)

Capacités :
  ☑ Chat        → modèle : [llama3.1 ▼]
  ☑ Embeddings  → modèle : [nomic-embed-text ▼]
```

Validation côté serveur : si `embeddings` est coché, `embeddingModel` doit être renseigné.

#### 5.3.4 Sélection au niveau d'une source RAG

Dans `SourceForm.tsx`, l'admin choisit quelle `AiSetting` est utilisée pour calculer les embeddings de cette source :

```
Configuration d'embeddings :
  [Sélectionner une config IA ▼]
    - Ollama local           (chat + embeddings)
    - OpenAI principal       (chat + embeddings)
    - Anthropic Claude       — grisé, ne supporte pas les embeddings
```

Le dropdown filtre automatiquement sur `setting.capabilities?.includes('embeddings')`.

La source stocke `embeddingSettingName: string` (ref vers `AiSetting.name`) + un `embeddingModelVersion` figé pour traçabilité (cf. §13).

#### 5.3.5 Allowlist par profile — déjà gérée

Le mécanisme `aiSettingNames` existant sur `ServeProfile` couvre déjà le RAG :
- Si un profile restreint son accès à certaines AI settings, le RAG respecte la même restriction au moment du `rag_search` (l'embedding de la query passe par une setting autorisée).
- Aucune nouvelle allowlist à créer pour les embeddings.

#### 5.3.6 Recommandations pour l'admin

| Cas d'usage | Setting recommandée | Modèle d'embeddings |
|---|---|---|
| Démarrage rapide, pas sensible | `custom` → OpenAI | `text-embedding-3-small` (1536 dims, ~$0.02/M tokens) |
| Données sensibles, souveraineté | `custom` → Ollama local | `nomic-embed-text` (768 dims, gratuit, multilingue moyen) |
| Multilingue (FR + EN + autres) | `custom` → Ollama local | `bge-m3` (1024 dims, multilingue fort) |
| Pro entreprise (qualité max) | `custom` → Voyage / Cohere via baseUrl | `voyage-3-lite` ou `embed-multilingual-v3` |

> ⚠️ **Coût** : un dossier de 10k docs PDF = ~50M tokens = ~$1 en OpenAI. Acceptable, mais à signaler dans l'UI avant ingestion. Ollama local = gratuit mais ~30 min à 2h pour la même volumétrie selon CPU/GPU.

> ⚠️ **Drift de modèle** : changer la setting d'embeddings d'une source = re-indexation complète obligatoire (les dimensions et la sémantique des vecteurs diffèrent entre modèles). À confirmer dans l'UI avec un warning explicite.

---

## 6. Synchronisation (le point dur)

Quand une source change (nouveau fichier S3, doc GDrive édité, fichier local ajouté), il faut **réindexer sans rebuild complet**.

### 6.1 Modes de sync — proposer les 3

| Mode | Comment | Connecteurs | Trade-off |
|---|---|---|---|
| **Manual refresh** | Bouton « Re-sync » dans l'UI | Tous | Simple, prévisible. L'admin contrôle le coût des embeddings |
| **Polling** | Cron interne, hash/etag check | S3 (etag), GDrive (modifiedTime), HTTP (If-Modified-Since) | Fiable, latence ~minutes |
| **Push (webhooks/watch)** | Local : `chokidar`. S3 : Event Notifications. GDrive : Push Notifications | Local, S3, GDrive | Faible latence, plus complexe (endpoint exposé, gestion duplicats) |

**Recommandation v1 :** **Manual + Polling** pour tous les connecteurs. **Watch local via chokidar** parce que c'est trivial. Webhooks remote → v2/ee.

### 6.2 Algorithme d'incrémentalité

Pour chaque document dans la source :

```
hash_actuel = sha256(stream)
si hash_actuel == document.hash en DB → skip
sinon → re-parse, re-chunk, re-embed, upsert (delete old chunks first)
```

Pour les fichiers supprimés à la source : marquer `deletedAt` en DB → soft-delete pour garder l'audit. Optionnellement vider après N jours.

### 6.3 Impact sur les profiles

**C'est ce qui inquiétait le user.** Le contrat est simple :

- Les profiles ne référencent **jamais** un chunk ou un embedding directement, seulement des `sourceId` / `folderId` / `documentId`.
- Lors d'un `rag_search`, on : (a) calcule l'embedding de la query, (b) cherche les top-K chunks dans le vector store, (c) **filtre a posteriori** via un join SQL sur l'allowlist du profile.
- Donc : ajouter, modifier ou supprimer un fichier ne casse jamais un profile. Si le dossier est dans `allowedFolders`, le nouveau fichier apparaît automatiquement au prochain search une fois indexé.
- Le profile lui-même n'est jamais ré-écrit lors d'une sync.

---

## 7. Exposition MCP — nouveaux tools

À enregistrer dans une nouvelle fonction `registerRagTools(options)` à côté de `registerDynamicTools` (`packages/core/src/serve/dynamic-tools.ts`). Même pattern : reçoit `options.profileAccess`, valide chaque appel, log via `onAuditLog`.

| Tool | Args | Retour | Notes |
|---|---|---|---|
| `rag_search` | `query: string`, `topK?: number`, `folders?: string[]`, `fileTypes?: string[]` | `{ chunks: [{ text, score, sourceId, folder, fileName, position }] }` | Le 95% des usages |
| `rag_list_sources` | — | `{ sources: [{ id, name, type, folderCount, documentCount }] }` | Pour que le LLM sache où chercher |
| `rag_list_folders` | `sourceId?: string` | `{ folders: [{ id, sourceId, path, parent, documentCount }] }` | Navigation |
| `rag_list_documents` | `folder: string`, `limit?: number` | `{ documents: [{ id, name, mimeType, size, modifiedAt }] }` | Navigation |
| `rag_get_document` | `documentId: string` | `{ text, metadata }` | Rapatrier un document complet (cap. de taille) — **uniquement si dans allowlist** |

Comme pour le SQL, **chaque tool valide ses arguments contre l'allowlist** avant exécution. Pas de filtrage juste à la couche embedding ou retrieve, sinon contournable.

---

## 8. Frontend — nouveaux écrans

Suivre le pattern `App.tsx` (View enum) + composants stateless + appels `fetch('/api/...')`.

```
Nouvelle View : 'knowledge'
Nouveaux composants packages/web/src/components/ :
├── KnowledgeBaseManager.tsx   ← page principale (liste sources + bouton "+")
├── SourceForm.tsx              ← création/édition d'une source (type, config)
├── FolderTreeView.tsx          ← arborescence dossiers + fichiers d'une source
├── DocumentUploader.tsx        ← drag & drop pour sources locales
├── IngestionStatusCard.tsx     ← progress des RagJob (indexation en cours)
└── RagAccessSelector.tsx       ← analogue de TableOptionsCard, pour cocher dossiers/fichiers dans un profile
```

Intégration dans `ProfileManager` : ajouter un onglet « Bases de connaissance » à côté de l'onglet tables, qui rend `RagAccessSelector`.

Intégration dans `ServePanel` : afficher les tools RAG disponibles pour le profile actif (read-only).

### 8.1 UX détaillée du `RagAccessSelector`

Ce composant est le pendant direct de `TableOptionsCard` pour les bases de connaissance. Il doit appliquer **les mêmes patterns d'interaction** que la sélection des tables/colonnes existante, pour que l'admin retrouve ses repères.

#### Structure visuelle

```
┌─ Profile : "support-client" ─────────────────────────────┐
│                                                           │
│  Onglet : [Tables] [Bases de connaissance ●]             │
│                                                           │
│  ▼ ☑ S3 — Documentation produit            [auto-include]│
│      ▼ ☑ docs/faq/              (47 fichiers)             │
│          ☑ produit-a.pdf                                  │
│          ☑ produit-b.pdf                                  │
│          ☑ tarifs.md                                      │
│          ...                                              │
│      ▼ ☑ docs/guides/           (23 fichiers)             │
│      ▶ ☐ docs/internal/         (12 fichiers — caché)     │
│      ▶ ☐ docs/legal/            (8 fichiers — caché)      │
│                                                           │
│  ▶ ☐ Local — Onboarding         (non sélectionné)         │
│  ▶ ☐ HTTP — Blog public         (non sélectionné)         │
│                                                           │
│  ───────────────────────────────────────────────────────  │
│  📊 70 documents accessibles, ~840 chunks                 │
│                                                           │
│                                    [Annuler] [Enregistrer]│
└───────────────────────────────────────────────────────────┘
```

#### Checkboxes 3-états

Chaque nœud de l'arborescence (source, dossier, fichier) a une checkbox avec 3 états visuels, comme pour les colonnes des tables :

- **☑ Cochée** : tout le contenu de ce nœud est inclus.
- **◪ Partielle** : certains enfants seulement sont cochés (état dérivé, non cliquable directement).
- **☐ Décochée** : rien de ce nœud n'est inclus.

Cliquer sur une checkbox parent applique récursivement à tous les descendants. Cliquer sur un enfant peut basculer le parent en état partiel.

#### Mode `auto-include` vs `strict` (au niveau dossier)

Chaque dossier coché affiche un **badge** indiquant comment il traite les futurs fichiers :

- **`[auto-include]`** (par défaut) — Le dossier est mappé dans `allowedFolders`. Tout fichier ingéré ultérieurement dans ce dossier devient automatiquement accessible au profile.
- **`[strict]`** — Le dossier passe en mode liste blanche. Seuls les fichiers individuellement cochés sont accessibles. Les nouveaux fichiers ingérés restent invisibles jusqu'à validation manuelle.

**Bascule automatique du mode** :

- Au départ, cocher un dossier → mode `auto-include` (correspond à `allowedFolders[sourceId]`).
- Si l'admin **décoche un fichier individuel** dans un dossier `auto-include` → le dossier bascule en `strict`, les autres fichiers passent dans `allowedDocuments[sourceId]`, et un toast confirme : « Le dossier `docs/faq/` est maintenant en mode strict. Les nouveaux fichiers ne seront pas accessibles automatiquement. »
- L'admin peut **forcer le retour en `auto-include`** via un bouton contextuel sur le badge (clic droit ou menu ⋯).

Cette logique encapsule les 3 granularités de `ProfileRagAccess` (§3.2) dans une UI unique sans exposer les 3 listes brutes à l'admin.

#### Compteurs

- À côté de chaque dossier : `(N fichiers)` ou `(N fichiers — caché)` si non sélectionné.
- À côté de chaque source : nombre de documents et chunks accessibles dans le scope actuel.
- En bas du composant : récapitulatif global `📊 X documents accessibles, ~Y chunks` mis à jour en temps réel à chaque clic.

Ces compteurs viennent d'un appel à `GET /api/profiles/:name/rag-access/preview` qui renvoie les totaux côté serveur (cohérent avec le filtrage runtime).

#### Lazy loading

Une source S3 ou GDrive peut contenir des milliers de fichiers. Pour éviter de charger toute l'arborescence à l'ouverture :

- À l'ouverture du composant, on liste uniquement les **sources** + leurs **dossiers racine**.
- Les sous-dossiers et fichiers sont chargés à la demande lors de l'expansion (`▶` → `▼`), via `GET /api/rag/sources/:id/folders` et `GET /api/rag/sources/:id/documents?folder=...`.
- Spinner local sur le nœud en cours de chargement.

#### États visuels particuliers

- **Source en cours d'ingestion** : badge `[indexation 47/200…]` non cliquable, lien vers `IngestionStatusCard`.
- **Source en erreur de sync** : badge rouge `[sync échouée]` avec tooltip détaillant l'erreur.
- **Document non encore indexé** : grisé, tooltip « Pas encore indexé — sera disponible après la prochaine sync ». Cochable quand même (sera pris en compte dès que l'indexation est complète).
- **Document supprimé à la source mais encore en DB** (`deletedAt` set) : barré, badge `[supprimé]`. Décoché automatiquement.

#### Persistance et feedback

- Pas de save automatique : les changements sont locaux jusqu'au clic sur **Enregistrer**.
- Bouton **Annuler** restaure l'état initial (dernier `ragAccess` sauvegardé du profile).
- Au save : `POST /api/profiles/:name/rag-access` avec le payload `ProfileRagAccess` complet, puis toast « Accès RAG mis à jour pour le profile ".." ».

#### Cohérence avec `TableOptionsCard`

| Pattern | Tables (existant) | RAG (nouveau) |
|---|---|---|
| Checkbox 3-états | ✅ | ✅ |
| Search/filtre dans la liste | ✅ | ✅ (sur path/nom de fichier) |
| Compteur en bas | ✅ | ✅ |
| Save explicite avec bouton | ✅ | ✅ |
| Toggle « tout cocher / tout décocher » par groupe | ✅ | ✅ (par source ou par dossier) |

Le composant doit réutiliser autant que possible les sous-composants existants (checkbox tri-état, accordion, search input) pour ne pas dupliquer les styles Tailwind.

---

## 9. Routes API à ajouter

Dans `packages/cli/src/routes/`, suivre le pattern `function registerXxxRoute(app, state)` :

```
rag-sources.ts
  POST   /api/rag/sources              ← create source
  GET    /api/rag/sources              ← list sources
  PATCH  /api/rag/sources/:id          ← update config
  DELETE /api/rag/sources/:id
  POST   /api/rag/sources/:id/test     ← testConnection

rag-content.ts
  GET    /api/rag/sources/:id/folders
  GET    /api/rag/sources/:id/documents?folder=...
  GET    /api/rag/documents/:id

rag-upload.ts
  POST   /api/rag/sources/:id/upload   ← multipart, sources locales uniquement

rag-index.ts
  POST   /api/rag/sources/:id/sync     ← trigger ré-indexation
  GET    /api/rag/jobs                 ← status des jobs
  POST   /api/rag/search               ← debug/preview depuis l'UI

rag-profiles.ts
  POST   /api/profiles/:name/rag-access         ← set allowedSources/Folders/Documents
  GET    /api/profiles/:name/rag-access/preview ← compteurs temps réel pour RagAccessSelector
                                                  (documents accessibles, chunks, par source)
```

---

## 10. Découpage open-core (récapitulatif)

**Décision** : **l'ensemble du RAG est une fonctionnalité Enterprise** → tout sous BUSL-1.1 dans `ee/`. Aucune partie du RAG ne vit dans `packages/`.

Cette décision est cohérente avec :
- La memory `project_commercial_tiers` : le RAG est un différenciateur commercial fort, justifiant le tier Pro/Enterprise.
- La memory `project_open_core_split` : `ee/*` reçoit les premium features.
- Le précédent `ee/sso/` qui a un backend (`src/`) et un frontend (`src/web/`) dans le même package, avec exports multiples — pattern reproduit ici.

### 10.1 Liste des packages `ee/`

| Package | Contenu | Phase |
|---|---|---|
| `ee/rag-core` | Types, interfaces, schema SQLite, sqlite-vec, chunker, client embeddings (via `AiSettings`), MCP tools `rag_*`, routes API, composants React (`RagAccessSelector`, `KnowledgeBaseManager`, etc.), pipeline d'ingestion, parsers (PDF via `unpdf`, DOCX, MD, CSV, HTML) | 1, 2 |
| `ee/rag-connectors` | Connecteurs de base : `LocalFolderConnector`, `S3Connector`, `HttpConnector` | 1 (Local), 3 (S3, HTTP) |
| `ee/rag-gdrive` | Connecteur Google Drive (OAuth + watch) | 5 |
| `ee/rag-gsheets` | Connecteur Google Sheets | 5 |
| `ee/rag-microsoft` | Connecteur SharePoint / OneDrive | 5 |
| `ee/rag-saas-sources` | Connecteurs Notion, Confluence | 5 |
| `ee/rag-git` | Connecteur Git (repos privés indexés) | 5 |
| `ee/rag-advanced` | Reranking (Cohere/Voyage), hybrid search (BM25 + vector), chunking sémantique, adapter pgvector / Qdrant | 5 |

### 10.2 Conventions à respecter pour chaque package `ee/`

- **License** : BUSL-1.1 dans le `package.json`.
- **SPDX header** en tête de chaque fichier source : `// SPDX-License-Identifier: BUSL-1.1`.
- **Nom npm** : `@calame-ee/<nom>` (cf. `@calame-ee/sso`).
- **Structure** : `src/` (backend) + `src/web/` (composants React) si applicable, exports multiples dans `package.json` (cf. `ee/sso/package.json`).
- **peerDependencies optionnelles** sur `react`, `react-dom`, `express`, `better-sqlite3` — reproduit le pattern SSO pour ne pas forcer les consumers à tout installer.

### 10.3 Intégration avec le core (Apache)

Le RAG en `ee/` consomme les types et services exposés par `packages/core` et `packages/cli` :
- `AiSettingsManager` (`packages/cli/src/ai-config.ts`) — étendu avec `capabilities` + `embeddingModel`. **Cette extension reste dans `packages/cli/`** (Apache) car c'est un mécanisme générique réutilisable.
- `ServeProfile` (`packages/core`) — étendu avec `ragAccess?: ProfileRagAccess`. Le **type** est dans le core (Apache), mais la **logique de filtrage** et les tools `rag_*` sont en `ee/rag-core` (BUSL).
- `AppState` (`packages/cli/src/state.ts`) — reçoit une référence optionnelle à `RagIndex` chargée dynamiquement depuis `@calame-ee/rag-core` si la license est valide.

**Règle** : le core (Apache) ne dépend jamais du `ee/`. C'est l'inverse — le `ee/` dépend du core. Si `@calame-ee/rag-core` n'est pas installé, OpenSmith fonctionne normalement sans le RAG.

---

## 11. Phases d'implémentation proposées

Découper pour livrer de la valeur incrémentalement :

### Phase 0 — Décisions (avant de coder)
- [x] **Vector store : sqlite-vec** (validé)
- [x] **Embeddings : réutilisation de `AiSettings` existant** — extension du type avec `capabilities` + `embeddingModel`, pas de nouveau système (cf. §5.3)
- [x] **Split open-core : tout le RAG en BUSL-1.1 sous `ee/`** (validé) — cf. §10
- [x] **Parser PDF : `unpdf`** (validé) — moderne, ESM, sans dépendance native, maintenu

### Phase 1 — MVP local (1-2 semaines)
- Migration SQLite (dans `packages/cli`, Apache) : ajout colonnes `capabilities`, `embedding_model` sur `ai_settings`
- Package `ee/rag-core` (BUSL-1.1) :
  - Types, interfaces (`RagSource`, `RagFolder`, `RagDocument`, `RagChunk`, `RagJob`, `VectorStore`)
  - Schema SQLite (sources, folders, documents, chunks via sqlite-vec)
  - Chunker (token-based, 512/64)
  - Client embeddings consommant `AiSettingsManager` du core
  - Parsers : PDF (`unpdf`), DOCX (`mammoth`), MD (`unified`), CSV (`papaparse`), HTML (`node-html-parser`)
  - Routes API (`rag-sources.ts`, `rag-content.ts`, `rag-upload.ts`, `rag-index.ts`)
  - Composants React de base : `KnowledgeBaseManager`, `SourceForm`, `FolderTreeView`, `DocumentUploader`, `IngestionStatusCard` (dans `src/web/`)
- Package `ee/rag-connectors` (BUSL-1.1) avec `LocalFolderConnector`
- Extension de `AiSettings.tsx` (dans `packages/web`, Apache) : section « Capacités » (toggles chat / embeddings + modèle d'embedding)
- Wiring dynamique dans `packages/cli` : chargement optionnel de `@calame-ee/rag-core` si présent (sinon RAG désactivé)
- UI minimale : créer une source locale, drag & drop fichiers, voir les fichiers indexés ; choix de la config d'embeddings au niveau source
- Pas encore de profile/MCP — juste valider la pipeline

### Phase 2 — Intégration profiles + MCP (1 semaine)
- `ProfileRagAccess` dans le type `ServeProfile` (`packages/core`, Apache — type uniquement)
- `RagAccessSelector` dans `ProfileManager` (composant exposé par `@calame-ee/rag-core/web`, intégré conditionnellement dans `packages/web/ProfileManager.tsx` si le RAG est chargé)
- `registerRagTools()` dans le runtime MCP (en `ee/rag-core`)
- Filtrage allowlist au runtime, audit logging
- Route `POST /api/profiles/:name/rag-access` + `GET .../preview` (en `ee/rag-core/src/routes/`)

### Phase 3 — Connecteurs externes (1-2 semaines)
- `S3Connector` dans `ee/rag-connectors` (S3 + R2 + MinIO via `@aws-sdk/client-s3`)
- `HttpConnector` dans `ee/rag-connectors` (URL list, sitemap.xml)
- Sync incrémentale par hash/etag
- UI de création de source distante (form + test connection) — composants ajoutés dans `ee/rag-core/src/web/SourceForm.tsx`

### Phase 4 — Sync continu (3-5 jours)
- `chokidar` pour les sources locales
- Polling configurable pour S3/HTTP
- UI : statut de sync, dernière mise à jour par source

### Phase 5 — EE features (selon priorité commerciale)
- `ee/rag-gdrive`, `ee/rag-gsheets` (OAuth + watch)
- `ee/rag-advanced` : reranking (Cohere), hybrid search, chunking sémantique
- `ee/rag-microsoft` (SharePoint)

---

## 12. Questions ouvertes à trancher avec toi

1. **Multi-tenancy** : une instance OpenSmith = un seul espace de connaissance partagé, ou plusieurs « workspaces » isolés ? (impact gros sur le schema SQLite et l'UI)
2. **Coût des embeddings** : qui paie ? clé API admin = facture admin. Faut-il un compteur de tokens visible dans l'UI ? un cap configurable ?
3. **Granularité allowlist** : on supporte les 3 niveaux (source / folder / document) ou on commence par 2 (source + folder) pour simplifier ?
4. **Audit** : un appel `rag_search` par un LLM doit-il logger la query complète + les chunks retournés ? (RGPD ; cf. ton contexte Québec)
5. ~~**Vie privée des extraits**~~ → ✅ **tranché 2026-05-11** : **OUI**, on applique le **même** `applyPiiMasking` de `@calame/core` que celui utilisé pour les colonnes DB. Implémentation dans `ee/rag-core/src/pii-masking.ts` (wrapper `maskSearchResult`), appliqué en RESPONSE-time dans `source-adapter.ts:493-503`. Config via env `CALAME_RAG_PII_MASK` (safe-by-default). Coût : ~1 scan regex par chunk au moment du `rag_search` — négligeable.
6. **Limite de taille** : on cap la taille d'un upload local ? (sinon risque de saturer l'instance) Suggestion : 50 MB par fichier, configurable.
7. **Suppression d'une source** : on garde les chunks orphelins quelques jours pour rollback, ou on hard-delete ? (impact sur les profiles qui la référencent)
8. **Parsers OCR** : on inclut OCR pour PDF scannés (Tesseract) ? Sinon ces PDF seront indexés vides. Probablement ee/.
9. **Rate limiting des sources externes** : GDrive, S3 ont des quotas. Faut-il une queue d'ingestion globale avec backoff ? (oui, mais à designer en phase 4)

---

## 13. Risques & points d'attention

- **Coût embeddings** sous-estimé sur gros corpus → afficher une estimation avant ingestion.
- **Drift d'embeddings** : si on change de modèle plus tard, **tous les vecteurs sont invalidés**. Stocker `embeddingModelVersion` par chunk pour permettre une re-indexation propre.
- **Sécurité credentials sources** : credentials S3/GDrive doivent être chiffrés au repos (réutiliser le mécanisme déjà en place pour les DB connection strings).
- **Limites de contexte MCP** : ne pas retourner 100 chunks de 2k tokens chacun. Cap raisonnable : `topK ≤ 10`, longueur chunk ≤ 1000 tokens.
- **Cohérence avec l'audit existant** : chaque appel RAG doit produire la même structure d'audit que les appels SQL.

---

*Brouillon initial 2026-05-06 — Phases A + B livrées 2026-05-06, Polish UX et RAG-Phase-2 (via plan unifié) livrés 2026-05-07/08, **Phase 4 du plan unifié (UI Sources unifiée + `RagAccessSelector`) en cours 2026-05-09 (non commité)**. Cf. §0 "État d'avancement" pour le détail des commits et `docs/sources-unified-plan.md` pour la suite de la roadmap (Phase 5 du plan unifié + Phases 3-5 du plan RAG original toujours à faire).*
