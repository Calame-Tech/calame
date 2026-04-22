# Quick Start

End-to-end walkthrough — from download to your first MCP client query.
Estimated time: **~15 minutes**.

> Prefer to skim? The minimal version lives in the [README](../README.md#quick-start).

---

## 1. Prerequisites

Pick one runtime:

| Runtime | Requires |
|---|---|
| **Docker** *(recommended)* | Docker Desktop (Win/Mac) or Docker Engine + Compose (Linux) |
| **Node.js (dev mode)** | Node ≥ 18, pnpm ≥ 9 (`corepack enable && corepack prepare pnpm@9.15.4 --activate`) |

You also need:
- A database to expose (Postgres / MySQL / SQLite). For testing, you can use the bundled demo SQLite — see [§4.1](#41-create-a-test-sqlite-database).
- An LLM API key *if you want to use the built-in chat* (Anthropic, OpenRouter, or a local Ollama install — none required to serve MCP).

---

## 2. Install & launch

### Option A — Docker (recommended)

```bash
git clone https://github.com/mgasnier95/calame.git
cd calame
docker compose up
```

Wait for the line:
```
calame-1  | Calame is running on http://localhost:4567/
```

The first build takes 3–5 minutes. Subsequent starts are instant.

A persistent volume `calame-data` is created — your admin account, profiles, tokens, and audit log survive restarts.

### Option B — Node.js (development mode)

```bash
git clone https://github.com/mgasnier95/calame.git
cd calame
pnpm install
pnpm dev
```

Same target: http://localhost:4567.

### Common flags

| Variable | Default | Purpose |
|---|---|---|
| `CALAME_PORT` | `4567` | Port to bind |
| `CALAME_DATA_DIR` | `/data` (Docker) / cwd (dev) | Where SQLite state + secret live |
| `CALAME_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `CALAME_LOG_FORMAT` | `text` | `text` / `json` |
| `CALAME_CORS_ORIGINS` | `*` | Comma-separated origins for the API |

Full list: see `packages/cli/src/config.ts`.

---

## 3. Create the admin account

Open <http://localhost:4567> in your browser.

On first launch you land on the **Setup** page:
1. Choose an admin **email** and **password** (min 12 chars recommended).
2. Submit. You are now logged in as the workspace admin.

The admin can manage everything: connections, profiles, users, tokens, audit, settings.

> Lost the password? Stop the server, delete the `users` table inside `calame.db` (or remove the entire DB file in `CALAME_DATA_DIR` to reset everything), restart.

---

## 4. Add a database connection

In the **Connections** panel, click **New connection**.

### 4.1 Create a test SQLite database

If you just want to try Calame without touching real data, use the bundled demo generator:

```bash
node scripts/generate-demo-db.js
```

This creates `demo-logistique-v2.db` in the repo root with a fictional logistics dataset (~5 MB, ~30 tables, fake personal data). Use the path `./demo-logistique-v2.db` in the SQLite connection form.

### 4.2 Connection examples

**SQLite**
- Type: `sqlite`
- File path: `./demo-logistique-v2.db` (or absolute path inside Docker volume)

**PostgreSQL**
- Type: `postgresql`
- Host: `localhost` (or `host.docker.internal` if Calame is in Docker reaching your host)
- Port: `5432`
- Database, User, Password, SSL options

**MySQL** — same shape, port `3306`.

Click **Test connection** to validate, then **Save**. Calame introspects the schema (tables, columns, foreign keys) and shows a tree under **Schema explorer**.

> Calame opens connections in **read-only mode** (`SET TRANSACTION READ ONLY` on Postgres, `--readonly` on SQLite). Even a malicious LLM cannot mutate your data through a Calame profile unless you explicitly enable the write queue.

---

## 5. Create a profile

A **profile** is a published view of your database, with its own auth, masking and permissions. One DB → many profiles.

In the **Profiles** panel → **New profile**:

### 5.1 Tables & columns
- Pick which tables to expose
- For each table, pick which columns are visible
- Untick columns you don't want the LLM to see (e.g. internal IDs, raw passwords, etc.)

### 5.2 PII masking
- Calame auto-detects likely PII columns (`email`, `phone`, `address`, `credit_card`, `ssn`, etc.)
- For each detected (or any) column, choose a masking strategy: full redaction, hash, partial mask (`j***@example.com`), or custom regex
- Define **global masking rules** (apply to all profiles by column name pattern) under Settings

### 5.3 Row-level scoping (optional)
- Restrict the profile to rows matching a condition: e.g. `client_email = '<authenticated user email>'`
- Used for per-user data isolation (e.g. a customer can only query their own orders)

### 5.4 Auth mode
Pick one:

| Mode | Best for |
|---|---|
| `open` | Local dev / personal use, zero auth |
| `token` | Bearer token in `Authorization` header (one or many users) |
| `password` | Email/password login (browser flow) |
| `oauth` | OAuth 2.1 — Claude Desktop / Cursor / VS Code do auto Dynamic Client Registration |
| `sso` | OIDC SSO (Google Workspace, Okta, Azure AD, Keycloak…) |
| `external` | Custom validation URL — Calame POSTs the token to your endpoint, your endpoint returns 200/401 |

Click **Save**. Then **Start** the profile — Calame spins up the MCP endpoint at `http://localhost:4567/mcp/<profile-name>`.

---

## 6. (Optional) Test in the built-in chat

You don't need an external client to validate the profile.

1. Settings → **AI Settings** → choose your provider:
   - **Anthropic** — paste an API key from console.anthropic.com
   - **OpenRouter** — paste a key from openrouter.ai (gateway to Claude, GPT, Gemini, Llama…)
   - **Custom** — your local Ollama (`http://localhost:11434/v1`), vLLM, LM Studio… Leave API key empty if your endpoint doesn't require auth
2. Pick a model (e.g. `claude-sonnet-4-20250514`, `openrouter/anthropic/claude-sonnet-4`, `llama3.1:8b`)
3. Open **Chat** → pick the profile → ask: *"How many tables are in this database? Show me a sample row of each."*

If the chat returns coherent answers grounded in your data, your profile is correctly configured.

---

## 7. Generate a user token

For external MCP clients with `token` auth mode:

1. **Users** panel → **New user**
2. Email, name, assign one or more profiles
3. **Generate token** — Calame shows the token **once**. Copy it now (it's hashed at rest).

For `oauth` / `sso` modes, no token needed — the client handles the flow.

---

## 8. Connect an MCP client

The MCP endpoint URL is always `http://localhost:4567/mcp/<profile-name>`.

### Claude Desktop

Edit `claude_desktop_config.json` (Mac: `~/Library/Application Support/Claude/`, Win: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "calame": {
      "transport": {
        "type": "http",
        "url": "http://localhost:4567/mcp/<profile-name>",
        "headers": {
          "Authorization": "Bearer <your-token>"
        }
      }
    }
  }
}
```

For `oauth` mode, drop the `headers` block — Claude Desktop will prompt you to log in via browser.

Restart Claude Desktop. The profile shows up in the tool selector as `calame`.

### Cursor

Cursor → Settings → Features → MCP → Add MCP server:
- URL: `http://localhost:4567/mcp/<profile-name>`
- Headers (token mode): `Authorization: Bearer <your-token>`

### VS Code

Install the [official MCP extension](https://marketplace.visualstudio.com/) (or Cline / Continue / Roo Code / etc.). Each has its own MCP server config UI — point it at the same URL + token.

### ChatGPT Desktop / Other MCP clients

Same pattern — any MCP-compliant client supporting HTTP transport works.

### Verify with curl

Quick sanity check before configuring a client:

```bash
curl -X POST http://localhost:4567/mcp/<profile-name> \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should get a JSON response listing the MCP tools auto-generated for your profile (one per table + a query tool).

---

## 9. What's next

- **Deploy in production** — see Caddy / nginx templates in `docs/Caddyfile` and `docs/nginx.conf`. Set `CALAME_TLS_CERT` / `CALAME_TLS_KEY` if Calame should terminate TLS itself.
- **Audit log** — every query, who, when, with what scope. Filter & export from the Audit panel.
- **Multiple users with SSO** — Settings → OIDC, plug Calame to Google / Okta / Keycloak / Azure AD.
- **Secrets in Vault** — Calame can fetch DB credentials from HashiCorp Vault instead of storing them locally. Settings → Secrets.

---

## Troubleshooting

### "Port 4567 already in use"
Stop the conflicting process (`netstat -ano | findstr :4567` on Windows, `lsof -i :4567` on Mac/Linux) or set `CALAME_PORT=4568`.

### "Cannot connect to database"
- Postgres/MySQL on host but Calame in Docker → use `host.docker.internal` (Win/Mac) or `--network host` (Linux) instead of `localhost`
- SQLite path → must be readable by the container user (`node`). Mount the file into `/data` and reference it by `/data/yourfile.db`.

### Claude Desktop / Cursor doesn't see the server
- Check the URL is reachable from your local machine (open it in a browser — should return a 405 Method Not Allowed for GET, that's expected)
- Token mode → confirm the `Authorization` header is set (not `X-Auth-Token`)
- OAuth mode → check the profile is **started** (not just saved). Settings → restart it if needed.

### "Generated CALAME_SECRET_KEY" appears every restart
Your `dataDir` is not persistent. In Docker, ensure the `calame-data` volume is mounted. In dev, run from the same working directory each time.

### Build fails in Docker on `pnpm install`
Try `docker compose build --no-cache` to invalidate cached layers. If it persists, open an issue with the full log.

### "I broke something, how do I reset?"
```bash
docker compose down -v   # removes the volume too — full reset
docker compose up        # fresh state
```

---

Found a bug or missing piece? **[Open an issue](https://github.com/mgasnier95/calame/issues/new)** or start a discussion.
