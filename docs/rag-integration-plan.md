# Plan d'intégration RAG — OpenSmith / Calame

Ce document propose une architecture pour ajouter une couche RAG (Retrieval-Augmented Generation) à OpenSmith, exposée via MCP au même titre que les bases de données. Il est rédigé pour cadrer la discussion : plusieurs choix sont laissés ouverts et présentés avec leurs tradeoffs.

---

## 0. État d'avancement (mis à jour 2026-05-08)

> **Pivot stratégique (2026-05-07)** — La suite de la roadmap RAG est désormais portée par un plan plus large : **`docs/sources-unified-plan.md`**. La RAG-Phase-2 originale de ce document (intégration profiles + MCP) **est livrée comme Phase 3 de ce plan unifié**, dans le cadre d'une refonte qui généralise « Connection (DB) » et « RagSource » en un concept polymorphique `Source` accueillant aussi les futurs APIs / SaaS / streams. Lire les deux docs en parallèle pour comprendre le contexte.

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

### 🛑 Limitations restantes (après 2026-05-08)

- **Une seule dimension d'embedding par instance** (sqlite-vec exige une dim fixée au create de la virtual table). Auto-heal possible si rag_chunks est vide (cf. fix #3). Phase 5 du plan original prévoyait un vec0 par dimension — **toujours d'actualité**.
- **Sync synchrone bloquante** : OK pour tester, pas pour de gros corpora. Phase 4 du plan original — **toujours pendant**.
- **Connecteurs externes absents** : seul `LocalFolderConnector`. S3/HTTP/GDrive — **toujours pendant**, Phase 3 du plan original (= ce qui suit dans ce document).
- **Watch incrémental absent** (`chokidar`, polling) : Phase 4 du plan original — **toujours pendant**.
- **PII detection non appliquée** sur les chunks (cf. §12 question 5) : décision toujours non tranchée. À discuter à la prochaine session.
- **Pas d'UI** pour assigner un scope `document` à un profile. L'admin doit utiliser `POST /api/profiles/:name/scopes` via curl. Phase 4 du plan unifié (`docs/sources-unified-plan.md`) le livre.
- **Tests E2E manquants** : pas de test qui upload un fichier puis fait `rag_search` end-to-end. Aurait évité plusieurs fixes runtime ; aurait évité aussi le bug `sourceId` placeholder du commit `781fca4`.

### ✅ Limitations résolues 2026-05-07/08

- ~~**Pas de profile/MCP** : les routes `rag_*` n'ont pas encore d'`registerRagTools()`~~ → livré via `DocumentSourceAdapter.registerMcpTools` (Phase 3 du plan unifié)
- ~~**MCP `rag_*` tools non enregistrés au runtime serveur**~~ → enregistrés automatiquement quand un profile a un scope `kind: 'document'`
- ~~**Audit log RAG : pas encore intégré au format unifié**~~ → format unifié via `McpRegistrationContext.onAuditLog`, identique pour DB et RAG
- ~~**Polish UX `ragDisabledReason`**~~ → livré dans le commit `d774228`

### 🟢 Statut technique (2026-05-08)

- `pnpm install` : OK 8 packages
- `pnpm build` : OK tous packages compilent (TS strict, no `any`)
- `pnpm lint` : 0 erreur 0 warning
- `pnpm test` : **768 tests verts** (28 sso + 204 core + 38 rag-core + 72 connectors + 426 cli). Pré-existing better-sqlite3 NODE_MODULE_VERSION mismatch (115 vs 137) sur tests SQLite — résolu localement par `pnpm rebuild better-sqlite3`.
- Smoke test manuel : drag & drop d'un .txt fonctionne, ingestion complète + chunking + embeddings + sqlite-vec OK. Sync via le bouton fonctionne après les fixes.
- Smoke test 2026-05-08 : chat MCP DB fonctionne après le fix `781fca4` (test "donne moi le nombre de colis total" → LLM voit `query_<table>`, `describe_<table>`, etc., et répond).

### 🔜 Prochaine session — Priorités

1. ~~**Lancer Phase 2** (intégration MCP + profiles)~~ → ✅ **livré** via Phase 3 du plan unifié
2. ~~**Polish UX `ragDisabledReason`**~~ → ✅ **livré** (commit `d774228`)
3. **Tests E2E manquants** : un test qui crée une source RAG, upload un fichier, fait un `rag_search` via le MCP server. Aurait évité plusieurs fixes runtime ET le bug `sourceId` placeholder. **Priorité haute** — la confiance dans la chain RAG repose dessus.
4. **Sync async (Phase 4 plan original)** : passer la sync `LocalFolderConnector` en mode background job + queue. Toujours pertinent pour gros corpora.
5. **Connecteurs externes (Phase 3 plan original)** : `S3Connector`, `HttpConnector` dans `ee/rag-connectors`. Important pour passer du POC à un vrai usage.
6. **UI scope document (Phase 4 plan unifié)** : `SourcesPage` tabbed + `RagAccessSelector` + `ProfileManager` multi-kind. Aujourd'hui l'admin doit curl `POST /api/profiles/:name/scopes` à la main pour tester le RAG via MCP — c'est le frein UX principal.
7. **Décision PII** (cf. §12 question 5) : applique-t-on le PII detector aux chunks avant retour MCP ? Coût vs cohérence avec l'existant DB.

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
5. **Vie privée des extraits** : appliquer le même PII detector que les colonnes DB sur le texte des chunks avant retour MCP ? (cohérent avec l'existant, mais coûteux à grande échelle)
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

*Brouillon initial 2026-05-06 — Phases A + B livrées 2026-05-06, Polish UX et RAG-Phase-2 (via plan unifié) livrés 2026-05-07/08. Cf. §0 "État d'avancement" pour le détail des commits et `docs/sources-unified-plan.md` pour la suite de la roadmap (Phases 4-5 du plan unifié + Phases 3-5 du plan RAG original toujours à faire).*
