# Plan d'unification des Sources — OpenSmith

> **Statut :** validé 2026-05-07 par l'utilisateur. Plan de migration en 6 phases (~14-19 jours-dev).
> Origine : suite de `docs/rag-integration-plan.md`. La RAG-Phase-2 originale (profile + MCP) est satisfaite par la Phase 3 de ce plan.

---

## 0. Vision

OpenSmith part d'une logique « DB-first » : une `Connection` = une base de données SQL. Le RAG ajoute un second type de source. À terme, **toute source exploitable par MCP** doit être un connecteur de premier ordre dans l'UI :

- Bases de données SQL (existant)
- Sources de documents pour RAG (Phase 1 livrée)
- HTTP / REST / OpenAPI / GraphQL (futur)
- Services SaaS (Stripe, Notion, GitHub, Slack, etc.) (futur)
- Streams / événements (Kafka, webhooks, SSE) (futur)
- Types non-encore-imaginés — extensibilité explicite

L'extensibilité est un **objectif de premier rang**, pas une simple unification DB+RAG.

---

## 1. Décisions architecturales

### 1.1 Type system & abstractions (A)

**Pattern :** thin marker `Source` (donnée persistée) + `SourceAdapter<TConfig, TSchema, TCaps>` (runtime, registre).

```
Source         (record)         { id, name, type, configEncrypted, capabilities[], embedding…?, createdAt, updatedAt }
SourceAdapter  (registry entry) { type, displayName, capabilities, configSchema (Zod),
                                  testConnection(cfg),
                                  introspect?(cfg, sourceId),
                                  query?(cfg, …),
                                  listScopes?(cfg, sourceId, parent?),
                                  listItems?(cfg, sourceId, scope?),
                                  fetchItem?(cfg, sourceId, itemId),
                                  search?(cfg, query),
                                  registerMcpTools?(ctx)
                                }
```

**Capabilities initiales :** `introspect`, `query`, `search`, `enumerate`, `fetch`, `subscribe`, `sample`. À terme : `tools` (HTTP/SaaS adapter qui ship ses propres tools MCP), `write`.

**Schémas en union discriminée** :

```ts
SourceSchema =
  | { kind: 'relational'; tables: TableInfo[]; relations: Relation[] }
  | { kind: 'document';   folders: FolderInfo[]; documents: DocumentInfo[] }
  | { kind: 'api';        services: ServiceInfo[]; operations: OperationInfo[] }   // futur
  | { kind: 'stream';     topics: TopicInfo[] }                                     // futur
```

> **Tradeoff** : on rejette une abstraction tree-générique (`SourceNode { id, label, children, kind: 'folder' | 'leaf' }`) parce qu'elle perdrait la spécificité des colonnes/relations/operations dont les tools MCP ont besoin.

**Localisation des types** : `packages/core/src/sources/` (Apache).

```
packages/core/src/sources/
├── types.ts          # Source, SourceAdapter, Capability, SourceSchema, ScopeSelection
├── registry.ts       # SourceAdapterRegistry — register/lookup
├── selection.ts      # types ScopeSelection per-kind + helpers
├── mcp-context.ts    # McpRegistrationContext passé à adapter.registerMcpTools
├── migrate.ts        # upgradeProfileShape / upgradeConfigurationShape
└── index.ts
```

### 1.2 Profile allowlist (B)

**Nouvelle shape ServeProfile :**

```ts
ServeProfile {
  ...,
  sources: string[]                                     // remplace `connections`
  scopes: Record<sourceId, ScopeSelection>              // remplace selectedTables/tableOptions/columnMasking
}

ScopeSelection =
  | { kind: 'relational';
      selectedTables: Record<tableName, columnName[]>;
      tableOptions?: Record<tableName, TableToolOptions>;
      columnMasking?: Record<tableName, Record<columnName, ColumnMasking>>;
    }
  | { kind: 'document';
      mode: 'allowAll' | 'allowList';
      allowedFolders: string[];        // récursif / auto-include
      allowedDocuments: string[];      // strict whitelist
    }
  | { kind: 'api';      // futur
      allowedServices: string[];
      allowedOperations: Record<service, operation[]>;
    }
  | { kind: 'stream';   // futur
      allowedTopics: string[];
    }
```

**Migration on-read, persist-on-save** : un migrateur (`upgradeProfileShape`) détecte les profiles legacy (présence de `selectedTables` à la racine) et synthétise `scopes[connId] = { kind: 'relational', ... }`. Pas de migration SQLite.

**Validation par kind** : `SourceAdapter.scopeSelectionSchema: z.ZodType<ScopeSelection>` → validateur Zod par kind, appelé sur `/api/profiles/save`.

### 1.3 Storage & state (C)

**Décision : on garde `connections` et `rag_sources` séparés en SQLite.** Raison : open-core boundary (rag_sources est BUSL via `runRagMigrations`, indépendamment versionné). Fusion impose de bouger `rag_sources` dans Apache ou `connections` dans BUSL — interdit.

**Unification au niveau runtime** :
- `state.getAllSources(): Iterable<SourceState>` agrège DB connections + rag_sources + types futurs
- `state.connections` reste exposé (deprecated, DB-only) pour compat tests
- Hydratation **lazy** : `getAllSources()` ne touche pas aux tunnels SSH ni aux pools

**RagIndex / search** restent une couche distincte des adapters (le 3-layer model du plan RAG est préservé).

**Encryption** : AES-256-GCM via `encryptString/decryptString/deriveKeyFromEnv`. Connection strings legacy continuent à décrypter via l'ancien schéma jusqu'à ré-écriture.

### 1.4 MCP tool registration (D)

**Adapter-driven registration** : chaque adapter ship `registerMcpTools(ctx)`. Le route `serve.ts` itère les sources actives du profile, lookup l'adapter, appelle `registerMcpTools` une fois par source.

**Contrat :**

```ts
SourceAdapter.registerMcpTools(ctx: {
  server: McpServer,
  source: Source,
  config: TConfig,
  schema: SourceSchema,
  selection: ScopeSelection,
  profileName: string,
  scopeGuard: ScopeGuard,
  toolNamespace: string,
  onAuditLog: (entry) => void,
  responseMode: 'friendly' | 'raw',
  // capability-specific extras:
  executeQuery?: ...,
  searchIndex?: RagSearchIndex,
}): void
```

**Tool name disambiguation : préfixe `<sourceName>_`** (décision validée). Profile mono-source → pas de prefix (compat). Multi-source → `prod_query_users`, `kb1_rag_search`. Corrige un bug latent (deux DB avec table `users` colissionnent silencieusement aujourd'hui).

### 1.5 Routes & API (E)

**Type-prefixed sous `/api/sources/<kind>/*`** + middleware d'alias rétrocompat.

```
/api/sources                                  GET     — list all sources
/api/sources/db/connections                   POST/PATCH/DELETE/GET (alias: /api/connections)
/api/sources/db/connections/:id/test
/api/sources/db/schema                        GET (alias: /api/schema)
/api/sources/rag/sources                      POST/PATCH/DELETE/GET (alias: /api/rag/sources)
/api/sources/rag/sources/:id/folders          GET
/api/sources/rag/sources/:id/documents        GET
/api/sources/rag/sources/:id/sync             POST
/api/sources/rag/jobs                         GET
/api/sources/rag/search                       POST
/api/sources/rag/upload                       POST
/api/profiles/:name/scopes                    POST    — remplace /api/profiles/:name/rag-access ; couvre tous kinds
/api/profiles/:name/scopes/preview            GET
```

**Alias layer** : middleware Express qui rewrite `/api/connections/*` → `/api/sources/db/connections/*` et `/api/rag/*` → `/api/sources/rag/*`. Header `Sunset: <date>` + log une fois.

### 1.6 UI (F)

- **`AddSourceModal`** (NEW) : kind picker → form spécifique au kind. Découvre les kinds disponibles à runtime (DB toujours ; KB si `ragEnabled` ; futurs kinds quand leur EE package se charge).
- **`ConnectionForm.tsx`** et **`SourceForm.tsx` (RAG)** restent séparés (deeply specialized, polymorphiser ferait un kitchen-sink).
- **`SourcesPage.tsx`** (NEW, remplace ConnectionManager+KnowledgeBaseManager au niveau navigation) : tabs DB / KB / future.
- **`ProfileManager.tsx`** : refonte multi-kind, tabbed (un tab par source active dans le profile, ou master/detail si nombreuses) + summary header `X tables, Y folders, Z documents accessible`.
- **Sidebar** : `Connections` → **`Sources`** ; entrée `Bases de connaissance` fusionnée dans Sources (validé).
- Lazy import : `RagAccessSelector` et autres composants kind-spécifiques chargés à la demande depuis `@calame-ee/rag-core/web`.

### 1.7 Open-core (G)

| Concern | Localisation | License |
|---|---|---|
| `Source`, `SourceAdapter`, `Capability`, `SourceSchema`, `ScopeSelection` | `packages/core/src/sources/` | Apache |
| `SourceAdapterRegistry` | `packages/core/src/sources/registry.ts` | Apache |
| `DatabaseSourceAdapter` impls (postgresql/mysql/sqlite) | `packages/connectors/` | Apache |
| `DocumentSourceAdapter` interface | `ee/rag-connectors/src/types.ts` | BUSL |
| `LocalFolderConnector` (et futurs S3/Http) | `ee/rag-connectors/` | BUSL |
| `RagIndex` / `IngestionPipeline` / sqlite-vec store | `ee/rag-core/` | BUSL |
| MCP registration : DB adapter | `packages/connectors/` | Apache |
| MCP registration : RAG adapter | `ee/rag-core/` | BUSL |

**Futurs types** :
- HTTP/REST/OpenAPI : Apache pour le générateur basique, EE pour OAuth/auth-headers/multi-API
- GraphQL : idem
- SaaS (Stripe, Notion, GitHub, Slack) : `ee/saas-<vendor>/` BUSL
- Streams : `ee/stream-sources/` BUSL

**Boundary enforcement** : ESLint rule `no-cross-license-import` qui fail quand un fichier sous `packages/` importe depuis `@calame-ee/*` autrement qu'en dynamic import (cf. `packages/cli/src/rag-runtime.ts:79`).

---

## 2. Phases de migration

| # | Phase | Taille | Jours |
|---|---|---|---|
| 0 | Types abstraits seuls | S | 1 |
| 1 | `DatabaseSourceAdapter` wrap l'existant | M | 2-3 |
| 2 | Profile shape migration + alias routes | M | 3-4 |
| 3 | MCP unifié + `DocumentSourceAdapter` (= RAG-Phase-2) | L | 4-5 |
| 4 | UI : SourcesPage + ProfileManager + Sidebar | M | 3-4 |
| 5 | Cleanup : retirer deprecated, alias sunset, ESLint | S | 1-2 |
| | **Total** | | **14-19 dev-days** |

### Phase 0 — Types contracts only (S, ~1 jour)

**Scope :** ajouter les types abstraits dans `packages/core/src/sources/`. Rien wired.

- Créer `packages/core/src/sources/{types,registry,selection,mcp-context,migrate,index}.ts`
- Exporter depuis `packages/core/src/index.ts`
- Définir `Capability`, `Source`, `SourceAdapter<TConfig, TSchema, TCaps>`, `SourceSchema` (union discriminée avec arms `relational`+`document` ; `api`/`stream` marqués TODO), `ScopeSelection`, `SourceAdapterRegistry`, `McpRegistrationContext`
- Tests unitaires : registry register/lookup/duplicate-error
- TS strict, no `any`

**Deliverable :** types compilent, importables. Aucun changement runtime. 388 tests passent toujours.

**Pourquoi en premier :** toutes les phases suivantes en dépendent.

### Phase 1 — DB adapter wraps existing connector (M, ~2-3 jours)

**Scope :** `packages/connectors/` ship un `DatabaseSourceAdapter` qui implémente `SourceAdapter` et **délègue à l'existant `DatabaseConnector`**. Zero behavior change.

- New : `packages/connectors/src/db-adapter.ts` exporte `DatabaseSourceAdapter` pour postgresql/mysql/sqlite. Composition, pas rewrite. Capabilities = `['introspect', 'query', 'enumerate', 'sample']`
- Chaque adapter `registerMcpTools(ctx)` appelle internement `registerDynamicTools` (`packages/core/src/serve/dynamic-tools.ts:22`) avec la sélection projetée vers `selectedTables / tableOptions / columnMasking / executeQuery`
- Update : `packages/connectors/src/index.ts` enregistre les 3 adapters dans le `SourceAdapterRegistry` au load
- Garder : le legacy `getConnector(type)` (utilisé par `packages/cli/src/routes/serve.ts:4` et tests CLI)

**Tests :** existing connector tests passent unchanged. Nouveaux tests vérifient que `registerMcpTools` produit le même MCP tool set qu'aujourd'hui.

### Phase 2 — Profile migration & alias routes (M, ~3-4 jours)

**Scope :** introduire `ServeProfile.scopes` + `ServeProfile.sources` ; migrateur on-read ; alias routes ; preview API.

- Ajouter les nouveaux champs à `ServeProfile` (`packages/core/src/serve/types.ts`). Anciens champs `@deprecated`
- Ajouter `upgradeProfileShape` + `upgradeConfigurationShape` (`packages/core/src/sources/migrate.ts`). Appelés à chaque hydratation (`packages/cli/src/routes/profiles.ts`, `configurations.ts`, `serve.ts`)
- Sur save : nouveau shape uniquement, anciens champs droppés
- Ajouter `/api/profiles/:name/scopes` + `/api/profiles/:name/scopes/preview`
- Update `mergeConfigurations` (`packages/cli/src/routes/serve.ts:55`) : migrer au boundary
- Alias middleware : `/api/connections/*` → `/api/sources/db/connections/*` ; `/api/rag/*` → `/api/sources/rag/*`. Pas encore de renames de fichiers route
- YAML loader (`packages/cli/src/yaml-config.ts`) accepte les 2 shapes via le migrateur

**Tests :** fixtures de profiles legacy → vérifier load + emit nouveau shape on save. 388 tests stables.

### Phase 3 — MCP unifié + RAG adapter (L, ~4-5 jours)

**Scope :** rewrite `serve.ts` pour que les MCP tools viennent de `SourceAdapter.registerMcpTools` ; ship `DocumentSourceAdapter` ; livre la RAG-Phase-2 du plan original.

- New : `ee/rag-core/src/source-adapter.ts` — `DocumentSourceAdapter` par `RagSourceType`. `registerMcpTools` implémente `rag_search`/`rag_list_sources`/`rag_list_folders`/`rag_list_documents`/`rag_get_document`, gated sur `ScopeSelection.allowedFolders/allowedDocuments`
- Host (`packages/cli/src/rag-runtime.ts`) enregistre le document adapter dans le `SourceAdapterRegistry` après que `initRagRuntime` réussit. EE absent → registry sans `'local'/'s3'/...`, route serve skip silencieusement
- Rewrite du tool registration block dans `packages/cli/src/routes/serve.ts:445-559` : itérer `profile.sources`, lookup adapter, calculer `toolNamespace`, appeler `adapter.registerMcpTools(ctx)`
- Replace `state.connections` iteration par `state.getAllSources()`
- Adapter les 388 tests (la plupart des assertions ne dépendent pas de l'indirection)
- Tool-namespacing multi-source + tests anti-collision

**Backward compat vérifié à la fin :** profiles single-DB existants émettent les mêmes tool names. Routes RAG existantes via aliases.

### Phase 4 — UI consolidation (M, ~3-4 jours)

**Scope :** ship `SourcesPage`, refonte `ProfileManager`, polish Sidebar.

- New : `packages/web/src/components/SourcesPage.tsx` — tab Databases (existing `ConnectionManager`) + tab Knowledge bases (existing `KnowledgeBaseManager` lazy depuis `@calame-ee/rag-core/web`)
- New : `packages/web/src/components/AddSourceModal.tsx` — kind picker
- Update : `ProfileManager.tsx` — multi-kind tabbed/master-detail. `RagAccessSelector` (planifié dans `docs/rag-integration-plan.md:474`) implémenté dans `ee/rag-core/src/web/RagAccessSelector.tsx`, lazy-loaded
- Update : `Sidebar.tsx` — `Connections` → `Sources` ; entrée KB merged dans Sources page
- Update : `App.tsx` route table — ajouter view `'sources'`, alias `'connections'` et `'knowledge'`

### Phase 5 — Cleanup & deprecation (S, ~1-2 jours)

**Scope :** purement additif.

- Remove `@deprecated` fields sur `ServeProfile` (`packages/core/src/serve/types.ts:86-93`)
- Décider : renommer `DatabaseConnector` en alias narrow vers `SourceAdapter<…>` ou retirer
- Drop alias middleware (E.2) après une release avec header `Sunset`
- Ajouter ESLint rule `no-cross-license-import` (G.3) + run
- Documentation pass : MAJ `docs/rag-integration-plan.md` pour signaler que la RAG-Phase-2 est satisfaite par la Phase 3 de ce plan

---

## 3. Décisions ouvertes (toutes tranchées 2026-05-07)

| # | Question | Décision |
|---|---|---|
| 1 | Tool name collision multi-source | **Préfixer `<sourceName>_`** (corrige le bug latent multi-DB) |
| 2 | Sidebar | **Renommer Connections → Sources, fusionner KB dedans** |
| 3 | Configurations SQLite | **Garder colonnes existantes, migration in-memory** |
| 4 | Hydratation des sources | **Lazy** (comme aujourd'hui) |
| 5 | Encryption migration | **Indéfiniment read-compat avec l'ancien schéma**, new-write-only en AES-GCM |

---

## 4. Risques & limites

- **Phase 3** est la plus grosse — `serve.ts` (845 lignes) peut cacher des surprises sur scope-guard et audit format
- Fenêtre du buffer : 2-3 semaines (10-15 jours-dev) accordées par l'utilisateur, plan à 14-19 jours-dev → on est à la limite haute, marge serrée
- ESLint rule `no-cross-license-import` doit être en place AVANT que les contributeurs externes commencent à patcher, sinon des régressions de boundary peuvent passer
- Le futur HTTP/SaaS/stream est **aspirationnel** : le type system doit les accepter mais on ne les implémente PAS dans ce refactor

---

*Document validé. Phase 0 démarre immédiatement.*
