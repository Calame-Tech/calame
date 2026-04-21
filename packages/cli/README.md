# calame CLI

Point d'entree principal pour Calame. Lance un serveur Express qui sert le frontend et expose une API REST pour l'introspection PostgreSQL et la generation de serveurs MCP.

## Usage

```bash
npx calame [--port 4567]
```

Par defaut, le serveur demarre sur le port `4567` et ouvre le navigateur automatiquement.

## API Endpoints

### `POST /api/connect`

Teste la connexion a une base PostgreSQL et lance l'introspection.

**Body :** `{ "connectionString": "postgresql://user:pass@host:5432/db" }`

**Response :** `{ "success": true, "tableCount": 12 }`

### `GET /api/schema`

Retourne le schema introspect (tables, colonnes, relations).

**Response :** `{ "tables": [...], "relations": [...] }`

### `POST /api/generate`

Genere un serveur MCP a partir de la configuration et des tables selectionnees.

**Body :**

```json
{
  "config": {
    "serverName": "my-mcp-server",
    "transport": "stdio",
    "outputDir": "./generated-server",
    "clientTarget": "claude-desktop"
  },
  "selectedTables": {
    "users": ["id", "name", "email"],
    "posts": ["id", "title"]
  }
}
```

**Response :** `{ "success": true, "outputDir": "./generated-server", "configSnippet": "..." }`

### `POST /api/test`

Installe les dependances et compile le serveur genere (build & verify).

**Body :** `{ "outputDir": "./generated-server" }`

**Response :** `{ "success": true, "status": "ready", "outputDir": "/absolute/path" }`
