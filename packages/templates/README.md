# @calame/templates

Templates Handlebars utilises par `@calame/core` pour generer le code des serveurs MCP.

## Templates

### `server/`

| Fichier              | Description                                                      |
| -------------------- | ---------------------------------------------------------------- |
| `index.ts.hbs`       | Point d'entree du serveur MCP (imports, setup transport, tools)  |
| `db.ts.hbs`          | Module de connexion a la base de donnees (pool `pg`)             |
| `tool.ts.hbs`        | Outil MCP pour une table (query avec filtres, pagination)        |
| `package.json.hbs`   | package.json du serveur genere                                   |
| `tsconfig.json`      | Configuration TypeScript du serveur genere (copie directe)       |

### `configs/`

| Fichier                    | Description                                    |
| -------------------------- | ---------------------------------------------- |
| `claude-desktop.json.hbs`  | Snippet de configuration pour Claude Desktop   |
| `cursor.json.hbs`          | Snippet de configuration pour Cursor           |
| `vscode.json.hbs`          | Snippet de configuration pour VS Code          |
