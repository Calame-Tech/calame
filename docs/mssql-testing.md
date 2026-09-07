# Testing the MSSQL connector

This page covers the throwaway SQL Server container used to develop and
validate `packages/connectors/src/mssql.ts` locally and in the integration
suite, plus a checklist for validating against a client's real server before
shipping a change.

**Test-only.** `docker-compose.mssql-test.yml` and
`scripts/mssql-test-seed.sql` are fixtures — never point them at production
data, and never reuse the SA password they contain for anything real.

## 1. Spin up the container

Requires Docker (Docker Desktop on Windows/macOS, or the Docker Engine on
Linux) to be running.

```bash
./scripts/mssql-test-up.sh
```

This:

1. Runs `docker compose -f docker-compose.mssql-test.yml up -d` — starts SQL
   Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`) on host port
   **14330** (not the default 1433, to avoid colliding with a locally
   installed instance).
2. Waits for the container's healthcheck to report `healthy` (first run pulls
   the ~1.5GB image, so this can take a few minutes; subsequent runs are
   fast).
3. Pipes `scripts/mssql-test-seed.sql` through `sqlcmd` inside the container.
   The seed script is idempotent — it drops and recreates the `calame_test`
   database each time, so re-running `mssql-test-up.sh` gives you a clean
   slate.

Works from Git Bash on Windows as well as macOS/Linux.

## 2. What gets seeded

Database `calame_test`:

| Table         | Schema   | Notes                                                                                                            |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `clients`     | `dbo`    | IDENTITY pk, PII (`email`, `telephone`), `actif` BIT, `date_creation` DATETIME2, `notes` NVARCHAR(MAX). 25 rows. |
| `products`    | `dbo`    | IDENTITY pk, BIT (`en_stock`). 8 rows.                                                                           |
| `orders`      | `dbo`    | IDENTITY pk, FK → `clients`. 15 rows.                                                                            |
| `order_items` | `dbo`    | **Composite pk** (`order_id`, `line_no`), FK → `orders`/`products`. ~24 rows.                                    |
| `commandes`   | `ventes` | **Non-dbo schema** (required test case), FK → `dbo.clients`. 12 rows.                                            |
| `employes`    | `rh`     | **Non-dbo schema** (required test case), PII salary column (`salaire`). 8 rows.                                  |

Data is fabricated (fictitious French names/emails/phones) — no real people.

## 3. Set `CALAME_TEST_MSSQL_DSN`

`mssql-test-up.sh` prints both accepted forms at the end of its run. They are
also reproduced here for reference — both describe the exact same local
container:

**ADO-style** (`Server=...;Key=Value;...`):

```
CALAME_TEST_MSSQL_DSN='Server=localhost,14330;Database=calame_test;User Id=sa;Password=CalameTest!2026x;TrustServerCertificate=true;Encrypt=true'
```

**URL-style** (`mssql://user:pass@host:port/db?...`):

```
CALAME_TEST_MSSQL_DSN='mssql://sa:CalameTest!2026x@localhost:14330/calame_test?encrypt=true&trustServerCertificate=true'
```

`TrustServerCertificate=true` / `trustServerCertificate=true` is required
here because the container serves a self-signed certificate — see the
checklist below for why this must **not** carry over to a real client
deployment.

Export it in your shell:

```bash
export CALAME_TEST_MSSQL_DSN='mssql://sa:CalameTest!2026x@localhost:14330/calame_test?encrypt=true&trustServerCertificate=true'
```

## 4. Run the integration suite

```bash
pnpm exec vitest run packages/connectors/src/__tests__/mssql.integration.test.ts
```

The suite (`packages/connectors/src/__tests__/mssql.integration.test.ts`)
uses `describe.skipIf(!process.env.CALAME_TEST_MSSQL_DSN)`, so:

- **`CALAME_TEST_MSSQL_DSN` unset** (the normal state in CI — no SQL Server
  available there): the suite is reported as **skipped**, never failed.
- **`CALAME_TEST_MSSQL_DSN` set**: it introspects the seeded schema (dbo and
  non-dbo tables, single-column and composite primary keys), runs a
  parameterized `WHERE` query, checks that pagination beyond page 1 returns
  disjoint/ordered rows, round-trips `BIT`/`DATETIME2`/`NVARCHAR(MAX)`
  values, and queries the schema-qualified `[ventes].[commandes]` table.

The suite also resolves `packages/connectors/src/mssql.ts` dynamically at
runtime, so it degrades to "skipped" rather than breaking `pnpm test` at any
point in time where that file doesn't exist yet or isn't wired up.

Run the whole workspace suite as usual with `pnpm test` — it picks up this
file like any other `*.test.ts`.

## 5. Tear down

```bash
./scripts/mssql-test-down.sh
```

Stops the container and removes its data volume (fresh state next time).
Pass `-k`/`--keep-data` to stop the container but keep the volume around.

## Checklist: validating against a client's real SQL Server

The seeded container above exercises the _shape_ of MSSQL — the connector
still needs to be validated against a real, client-managed server before
being trusted in production. Things this container does **not** cover:

- [ ] **Non-dbo schemas.** Confirm introspection surfaces every schema the
      connection's login has access to, not just `dbo` — and that schema
      qualification (`[schema].[table]`) is used consistently everywhere a
      table name is referenced (queries, FK targets, PII sampling). The
      container covers this in principle (`ventes`, `rh`), but a real server
      often has many more schemas with inconsistent naming/casing.
- [ ] **Collations.** Client databases frequently use a non-default
      collation (e.g. `SQL_Latin1_General_CP1_CI_AS` vs `French_CI_AS` vs a
      case-sensitive `*_CS_*` collation). Verify: identifier comparisons in
      introspection queries, `LIKE`/`contains` filters, and column-level
      collations that differ from the database default (`column COLLATE ...`
      on a specific column is common on legacy schemas).
- [ ] **Named instances.** Real deployments are often reached as
      `SERVER\INSTANCENAME` (dynamic port via the SQL Server Browser
      service, UDP 1434) rather than `host:port`. Confirm the DSN parser
      accepts `Server=host\instance` (ADO-style) and that the equivalent
      URL-style form is documented/handled (or explicitly rejected with a
      clear error).
- [ ] **`Encrypt` / `TrustServerCertificate`.** The test container forces
      `TrustServerCertificate=true` because it uses a self-signed cert —
      that is **not** acceptable against a client server. Validate:
  - `Encrypt=true` with a proper CA-signed certificate and
    `TrustServerCertificate=false` (or omitted) is the default expectation.
  - A clear, actionable error surfaces when the server presents a
    certificate the client doesn't trust (rather than a generic TLS
    failure), given `SslConfig` in `packages/connectors/src/types.ts` allows
    passing a custom CA.
  - Some client environments still run `Encrypt=false`/legacy TLS
    (older SQL Server, restrictive network appliances) — confirm the
    fallback path, if supported, is intentional and documented rather than
    silently downgrading security.
- [ ] **Login vs. Windows/AD authentication.** This container only exercises
      SQL login (`sa`). Confirm behavior (or the documented lack of support)
      when a client requires Windows Authentication / Azure AD.
- [ ] **Firewall / VPN reachability.** Client SQL Servers are frequently
      only reachable from an on-prem network or via VPN — confirm
      `testConnection()` produces a timeout error a non-DBA user can act on,
      rather than an opaque driver exception.
- [ ] **Read-only enforcement.** Re-verify the read-only guarantee
      (`query()`'s read-only transaction) against server-level settings a
      client might have that differ from the container (e.g.
      `READ_COMMITTED_SNAPSHOT`, custom permissions that already restrict
      the login to read-only, linked servers).
