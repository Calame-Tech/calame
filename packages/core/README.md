# @calame/core

Core logic for Calame -- PostgreSQL introspection and MCP server generation.

## API publique

### Introspection

- **`introspectDatabase(connectionString: string): Promise<DatabaseSchema>`** -- Se connecte a PostgreSQL, introspect les tables, colonnes, cles primaires et relations.

### Generation

- **`generateMCPServer(options: GenerateOptions): Promise<string>`** -- Genere un serveur MCP complet (fichiers TypeScript, package.json, tsconfig, README) dans le repertoire de sortie.
- **`generateServerCode(options: GenerateOptions): string`** -- Genere le code source `index.ts` du serveur MCP (synchrone).
- **`generateServerCodeAsync(options: GenerateOptions): Promise<string>`** -- Version asynchrone qui lit le template depuis le disque.
- **`generateToolCode(table: TableInfo, relations: Relation[]): string`** -- Genere le code d'un outil MCP pour une table donnee.
- **`generateToolCodeAsync(table: TableInfo, relations: Relation[]): Promise<string>`** -- Version asynchrone.
- **`generateConfigSnippet(serverName: string, target: ClientTarget): string`** -- Genere un snippet de configuration pour Claude Desktop, Cursor ou VS Code.
- **`generateReadme(serverName: string, tables: TableInfo[]): string`** -- Genere le README du serveur MCP genere.

## Types exportes

```typescript
interface DatabaseSchema {
  tables: TableInfo[];
  relations: Relation[];
}

interface TableInfo {
  name: string;
  schema: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
}

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
}

interface Relation {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

interface GenerateOptions {
  serverName: string;
  tables: TableInfo[];
  relations: Relation[];
  transport: 'stdio' | 'streamable-http';
  outputDir: string;
}

type ClientTarget = 'claude-desktop' | 'cursor' | 'vscode';
```
