# Faire une release desktop (`.exe` / `.msi`)

Guide pas à pas pour publier une nouvelle version de Calame Desktop.
Durée totale : ~10 min de manipulations + ~20 min de build CI.

## Comment ça marche (vue d'ensemble)

- La version vit dans **un seul endroit logique** : le `package.json` à la racine
  (`tauri.conf.json` pointe dessus via `"version": "../package.json"`).
- Pousser un tag `vX.Y.Z` déclenche le workflow **Release desktop app**
  ([.github/workflows/release.yml](../.github/workflows/release.yml)) sur un runner
  Windows, qui :
  1. vérifie que le tag correspond à la version du `package.json` (échec immédiat sinon) ;
  2. builde tout (packages → bundle serveur → sidecar Node → Tauri) ;
  3. produit l'installeur **NSIS `.exe`**, le **`.msi`**, leurs signatures updater
     `.sig` et le manifeste **`latest.json`** ;
  4. attache le tout à une **release GitHub en draft**.
- Un humain relit la draft, rédige les notes et **publie**. C'est la publication
  qui rend la mise à jour visible par l'updater intégré des apps installées.

La clé de signature updater (`TAURI_SIGNING_PRIVATE_KEY`) est déjà configurée
dans les secrets GitHub du repo : **rien à installer localement** pour releaser.

## Étapes

### 1. Partir d'un `main` propre

```bash
git checkout main && git pull
```

Vérifier que la CI est verte sur le dernier commit de `main`.

### 2. Mettre à jour le CHANGELOG

Dans [CHANGELOG.md](../CHANGELOG.md), renommer la section `## [Unreleased]` en
`## [X.Y.Z] - AAAA-MM-JJ` et recréer une section `## [Unreleased]` vide au-dessus.

### 3. Bumper la version (3 fichiers, même valeur)

| Fichier | Champ |
|---|---|
| `package.json` (racine) | `"version"` |
| `apps/desktop/package.json` | `"version"` |
| `apps/desktop/src-tauri/Cargo.toml` | `version` |

Puis rafraîchir le `Cargo.lock` :

```bash
cd apps/desktop/src-tauri
cargo check    # met à jour la ligne version de calame-desktop dans Cargo.lock
```

(Pas de Rust installé ? Éditer à la main la `version` du bloc
`name = "calame-desktop"` dans `Cargo.lock`.)

### 4. Committer et pousser le bump

```bash
git add -A
git commit -m "chore(release): bump version to X.Y.Z"
git push origin main
```

### 5. Tagger — c'est le déclencheur

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

⚠️ Le `v` est obligatoire, et le tag doit être **exactement** `v` + la version
du `package.json`, sinon le workflow s'arrête tout de suite (c'est voulu).

### 6. Suivre le build

Onglet **Actions → Release desktop app** sur GitHub. Compter ~15–25 min
(compilation Rust). En cas d'échec : corriger sur `main`, puis relancer via
**Run workflow** (`workflow_dispatch`) — pas besoin de re-pousser le tag, le
workflow retrouve la version tout seul et met à jour la même release.

### 7. Vérifier et publier la release draft

Dans **Releases**, une draft « Calame vX.Y.Z » doit contenir :

- `Calame_X.Y.Z_x64-setup.exe` (installeur NSIS) + `.exe.sig`
- `Calame_X.Y.Z_x64_en-US.msi` + `.msi.sig`
- `latest.json` (manifeste updater — indispensable pour la mise à jour auto)

Coller les notes depuis le CHANGELOG, tester l'installeur si besoin, puis
**Publish release**. À partir de là, les apps installées proposeront la mise à
jour automatiquement.

## Build local de test (optionnel)

Pour vérifier un installeur sans passer par la CI :

```bash
pnpm install
pnpm build
pnpm desktop:build
```

Binaires dans `apps/desktop/src-tauri/target/release/bundle/{nsis,msi}/`.

Prérequis locaux : **Node 22.18.0 exactement** (contrainte ABI du sidecar,
cf. `scripts/prepare-desktop.mjs`), pnpm, Rust stable + build tools MSVC.
Sans la clé de signature, pas de `.sig` générés — normal, l'installeur
fonctionne quand même.

## Pièges connus

- **Ne jamais re-tagger une version déjà publiée.** En cas de raté, bumper en
  `X.Y.Z+1` et refaire le cycle.
- **SmartScreen** affiche un avertissement à l'installation : pas encore de
  certificat de signature de code Authenticode (dans le backlog). La signature
  `.sig` est celle de l'updater Tauri, ce n'est pas la même chose.
- Le build release CI est un **build from scratch** volontairement (pas de cache
  tsc) — ne pas s'étonner qu'il soit plus long que la CI normale.
