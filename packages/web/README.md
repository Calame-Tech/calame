# @calame/web

Frontend React pour Calame. Interface wizard en 4 etapes pour connecter une base PostgreSQL, explorer le schema, configurer et generer un serveur MCP.

## Developpement

```bash
pnpm dev
```

Lance le serveur de developpement Vite (avec hot reload).

## Build

```bash
pnpm build
```

Compile TypeScript puis genere le bundle de production via Vite. Les fichiers statiques sont servis par le CLI.

## Composants principaux

- **`App`** -- Composant racine, gere le wizard multi-etapes et l'etat global.
- **`ConnectionForm`** -- Formulaire de connexion PostgreSQL (etape 1).
- **`SchemaExplorer`** -- Exploration et selection des tables/colonnes (etape 2).
- **`ConfigPanel`** -- Configuration du serveur MCP : nom, transport, client cible, repertoire de sortie (etape 3).
- **`TestChat`** -- Generation du serveur, build & verify, affichage du snippet de configuration (etape 4).

## Stack

- React 18
- Vite 6
- Tailwind CSS 3
- TypeScript 5.7
