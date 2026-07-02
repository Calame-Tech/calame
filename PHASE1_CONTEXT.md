# Phase 1 — Filets de sécurité (revu 25/06/2026)

## Contexte

Branch actuelle : `refacto/tooling-qualite` (issue #330).
Objectif : ajouter des filets de sécurité CI/CD au monorepo Calame avant de continuer la refonte de l'UX.

## Fichiers modifiés ou créés

### 1. `package.json` (racine)
- **Ajout** : script `"typecheck": "tsc -b --noEmit"`
- Cible : typecheck complet du monorepo via TypeScript build mode

### 2. `tsconfig.json` (racine, **nouveau**)
- Étend `tsconfig.base.json` (qui définit `composite: true`, `strict`, `moduleResolution: NodeNext`)
- `include` couvre **tous** les `src/` des 11 packages (core + ee/* + cli)
- `noEmit: true`, `jsx: react-jsx`
- **Note** : ce n'est pas du project references (pas de `references: [...]`), mais un flat include qui compile tout en un. `tsc -b --noEmit` passe proprement.

### 3. `.github/workflows/ci.yml`
- **Step "Typecheck"** (lignes 36-37) : ajouté après le build dans le job `lint-and-test`, tourne sur la matrice Node 18/20
- **Job "security-scan"** (lignes 73-82) : nouveau job semgrep utilisant le **pattern container** (`semgrep/semgrep` image Docker)
  - L'ancienne version `uses: semgrep/semgrep@v1.130.0` était cassée (pas d'`action.yml`)
  - Suppression de `pnpm install` (inutile dans un container semgrep)
  - Règles : `p/javascript`, `p/owasp-top-ten`, `p/security-audit`

### 4. `packages/web/package.json`
- **Ajout** : `@testing-library/react@^16.3.0` (dépendance de test)
- **Ajout** : `@testing-library/jest-dom@^6.9.0` (dépendance de test)
- Ces deps sont dans `devDependencies` uniquement

### 5. `packages/web/vitest.config.ts`
- **Ajout** : `setupFiles: ['./src/__tests__/setup.ts']`
- Permet d'importer les jest-dom matchers avant chaque test

### 6. `packages/web/src/__tests__/setup.ts` (**nouveau**)
- Une seule ligne : `import '@testing-library/jest-dom/vitest';`
- Enregistre les matchers jest-dom pour Vitest

### 7. `packages/web/src/__tests__/App.smoke.test.tsx` (**nouveau**)
- **6 smoke tests** (exécutions réelles de composants, pas de mocks sur les composants eux-mêmes) :
  1. `LoginPage` — rendu sans erreur
  2. `SetupPage` — rendu sans erreur
  3. `ChatEntryPage` — rendu sans erreur (attention : warning `act(...)` non-fatal)
  4. `SchemaExplorer` — rendu sans erreur
  5. `SourcesPage` tab `databases` — vérifie le rendu + le texte "Sources" + la présence de "Databases"
  6. `SourcesPage` tab `knowledge` — vérifie que l'onglet knowledge est bien présent (disabled quand RAG off)
- `SourcesPage` a **2 onglets** (`databases` | `knowledge`), pas 5
- `KnowledgeBaseManagerComponent` est mocké via `vi.fn(() => null)`

## Résultats d'exécution

| Commande | Résultat |
|---|---|
| `pnpm typecheck` | ✅ 0 erreur |
| `pnpm --filter @calame/web run test` | ✅ 36/36 pass |
| `pnpm build` | ✅ toutes les packages buildées |

## Corrections post-revue Claude

1. **Semgrep CI** : remplacé `uses: semgrep/semgrep@v1.130.0` (cassé, pas d'`action.yml`) par le pattern container
2. **Smoke test SourcesPage** : réécrit pour couvrir le vrai composant avec ses 2 onglets et ses props réelles

## Points d'attention

- `ChatEntryPage` émet un `act(...)` warning en test (state update on mount) — non-fatal
- 3 tests `@calame/connectors` échouent sur les 2 branches (pré-existants, **pas causés** par ces changements) :
  - `api-adapter.test.ts` : mismatch sur les messages d'erreur (`ECONNREFUSED` vs `Network error`)
- Le `tsconfig.json` racine utilise un `include` flat, pas du project references

## Ce que Claude doit regarder pour la suite

Pour la **Phase 2** (restructuration des imports), il faut :
1. Lire `AGENTS.md` à la racine du repo
2. Comprendre la structure du monorepo (11 packages : 4 core + 7 ee/* + cli)
3. Identifier les imports cross-packages à réorganiser (notamment les imports `@calame-ee/*` qui doivent rester lazy dans `SourcesPage`)
4. Les changements de Phase 1 ne touchent **aucun** import — ils sont purement tooling
