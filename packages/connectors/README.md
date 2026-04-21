# @calame/connectors

Database connector plugins for Calame. Each connector implements the
`DatabaseConnector` interface, providing a uniform API for testing connectivity
and introspecting schema information from different database engines.

## Architecture

```
@calame/connectors
├── src/types.ts        — DatabaseConnector interface + DatabaseType union
├── src/postgresql.ts   — PostgreSQL connector (pg driver)
├── src/mysql.ts        — MySQL / MariaDB connector (mysql2 driver)
├── src/sqlite.ts       — SQLite connector (better-sqlite3 driver)
└── src/index.ts        — Registry: getConnector(), getAvailableConnectors()
```

The package depends on `@calame/core` for the shared `DatabaseSchema` type.
`@calame/core` does NOT depend on this package — the dependency is one-way,
avoiding circular imports.

## Usage

```typescript
import { getConnector, getAvailableConnectors } from '@calame/connectors';

// Get a specific connector
const connector = getConnector('postgresql');
const schema = await connector.introspect('postgresql://user:pass@localhost/mydb');

// List all registered connectors (for UI dropdowns, etc.)
const connectors = getAvailableConnectors();
// → [PostgreSQLConnector, MySQLConnector, SQLiteConnector]
```

## DatabaseConnector interface

```typescript
interface DatabaseConnector {
  name: string;          // "postgresql" | "mysql" | "sqlite"
  displayName: string;   // Human-readable, e.g. "PostgreSQL"
  placeholderDsn: string; // Example DSN shown in UI forms

  testConnection(dsn: string): Promise<boolean>;
  introspect(dsn: string): Promise<DatabaseSchema>;
  disconnect(): Promise<void>;
}
```

## Supported databases

| Database       | Status      | Driver           |
|----------------|-------------|------------------|
| PostgreSQL     | Implemented | `pg`             |
| MySQL/MariaDB  | Implemented | `mysql2`         |
| SQLite         | Implemented | `better-sqlite3` |

## Adding a new connector

1. Create `src/my-db.ts` implementing `DatabaseConnector`.
2. Add `'my-db'` to the `DatabaseType` union in `src/types.ts`.
3. Register the connector in the `registry` object in `src/index.ts`.
4. Export the class from `src/index.ts`.
