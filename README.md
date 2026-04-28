<p align="center">
  <img src="./docs/assets/logo.png" alt="Calame" width="120" />
</p>

<h1 align="center">Calame</h1>

<p align="center">
  <strong>Turn any database into an MCP server — visually.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#license">License</a>
</p>

---

Calame is a self-hosted web app that connects to your PostgreSQL, MySQL, or
SQLite database, lets you configure **access profiles** — per-table
permissions, PII masking, row-level scoping — and serves them as MCP (Model
Context Protocol) servers with fine-grained auth.

Plug your profile into any MCP client (LLM, Claude Desktop, Cursor, VS Code,
ChatGPT Desktop…) or use the **built-in chat** to query your data in natural
language. No code generation, no lock-in — Calame is the control plane.

## Quick start

```bash
git clone https://github.com/mgasnier95/calame.git
cd calame
pnpm install
pnpm dev
```

Open <http://localhost:4567> — create the admin account, connect a database,
create a profile, and you're live.

Or with Docker:

```bash
docker compose up
```

On the first run Calame auto-generates a `CALAME_SECRET_KEY` used to encrypt
tokens and connection strings, and persists it next to your database
(`.calame-secret`). If you deploy with Docker, mount a persistent volume on
`/data` so that file survives restarts — otherwise every restart invalidates
your saved tokens. You can also set `CALAME_SECRET_KEY` yourself via the
environment to reuse an existing secret.

→ **[Detailed Quick Start](./docs/QUICKSTART.md)** — full walkthrough from install to your first MCP client query (~15 min).

## Features

### Database connectors
- **PostgreSQL** · **MySQL** · **SQLite** — schema introspection, relations,
  sample data
- Read-only by design (`SET TRANSACTION READ ONLY`), parameterized queries only
- Optional SSH tunneling for remote databases

### Access profiles
- Pick tables & columns to expose per profile
- **PII detection & masking** (auto + custom rules, global or per-column)
- **Row-level data scoping** (e.g. restrict a profile to `client_email = X`)
- Write queue with approval workflow for mutating queries

### Auth — per profile
- **Open**, **Bearer token**, **password**, **OIDC SSO**, **OAuth 2.1**
  (Google, Microsoft, GitHub…), or **external validation URL**
- Per-user tokens with revocation
- MCP OAuth 2.1 Dynamic Client Registration (Claude Desktop / Cursor / VS Code
  auto-discover)
- Full audit log with export

### Built-in chat
- Query your data in natural language from the UI — no external client needed
- Pluggable LLM providers:
  - **Anthropic** (Claude direct)
  - **OpenRouter** (Claude, GPT, Gemini, Llama, …)
  - **Custom OpenAI-compatible** — self-hosted **Ollama**, vLLM, LM Studio

### Operations
- Email invitations (SMTP), user management, metrics dashboard
- HashiCorp Vault integration for secrets
- Docker + reverse-proxy templates (Caddy, nginx) included

## How it works

```
┌────────────┐   ┌─────────────┐   ┌───────────────────────────────┐
│  Your DB   │──▶│   Calame    │──▶│  MCP client (Claude Desktop, │
│ (Pg/My/Lt) │   │ (profiles,  │   │  Cursor, VS Code, ChatGPT,    │
│            │   │  auth, PII) │   │  built-in chat, LLM…)         │
└────────────┘   └─────────────┘   └───────────────────────────────┘
```

1. Connect a database (Calame introspects the schema).
2. Create a **profile** — pick tables, mask PII columns, pick auth mode.
3. Start the profile. Its MCP endpoint is `http://localhost:4567/mcp/<profile>`.
4. Point your MCP client at it, or open the built-in chat.

## Feedback

Something broken? Have a use case we missed? Open an issue or start a
discussion.

## License

Calame is **dual-licensed**:

- **Apache 2.0** — root, [`packages/*`](./packages), `scripts/`, and everything else outside `ee/`. See [`LICENSE`](./LICENSE).
- **Business Source License 1.1 (BUSL-1.1)** — the entire [`ee/`](./ee) directory (currently `ee/sso`, the SSO/OIDC implementation). See [`ee/LICENSE.BUSL`](./ee/LICENSE.BUSL) and [`ee/README.md`](./ee/README.md).

In short: you can self-host, fork, and modify Calame freely; the BUSL on `ee/*` only restricts repackaging it as a paid competing product. Each BUSL-licensed version automatically converts to Apache 2.0 four years after its publication.
