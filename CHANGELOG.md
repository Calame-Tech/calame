# Changelog

All notable changes to Calame are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project ships as a
single-version product (see `docs/adr/0002-single-version-releases.md` — the
root `package.json` version flows to the Docker image and `create-calame`).

## [Unreleased]

## [0.8.7] - 2026-10-22

### Added

- Optional **AI instructions** per MCP profile ("Consignes pour l'IA"): plain
  text or Markdown, at most 4,000 characters, edited on the profile page (FR/EN)
  and shown in the profile preview. Over the limit, the web form and the API
  refuse the save with an explicit error — no truncation, nothing saved.
  Existing profiles keep empty instructions and behave as before. When set, the
  instructions are sent in the MCP `initialize` result (`instructions`, after a
  short fixed preamble naming the profile and recalling that tool content is
  data) on `/mcp/<profile>` and `/mcp/<tenant>/<profile>`, in API key and
  Calame/OAuth modes; the `rag_*` tool descriptions of that profile get a short
  deterministic reminder (first line, 200 characters max) for clients that
  ignore `instructions`. Never injected into tool results. Same edit rights as
  the rest of the profile; changes are audited without the text. Clients read
  them at connection, so open sessions must reconnect, and support varies by
  client. See `docs/ai-instructions.md` / `docs/ai-instructions.fr.md`.

### Fixed

- OAuth clients registered dynamically by MCP clients (ChatGPT, Claude…,
  RFC 7591 `POST /register`) are no longer lost when the server restarts or is
  updated. They were kept in memory, so a connector reusing its `client_id`
  after a restart failed with "redirect_uri does not match registered client."
  They are now stored per tenant in `calame.db` (migration v19, existing data
  kept) and read on every OAuth request. Authorization codes (5 min) and
  pending SSO / OAuth logins (10 min) stay in memory and are lost on restart;
  the user just logs in again. Connectors registered before this fix are
  already lost: remove and recreate them once in the MCP client.
- An unknown `client_id` now gets its own error message asking to reconnect or
  recreate the connector, distinct from a different `redirect_uri`, in the
  JSON response and in the logs (no secrets logged). In `calame` mode the
  refusal happens before the login form is shown.
- `POST /register` is hardened: `redirect_uris` required (1 to 10 URLs of at
  most 2,048 characters, `https`, `http` only for the exact hosts
  `localhost`, `127.0.0.1` and `[::1]`, no fragment), `client_name` at most
  200 characters, body at most 32 KiB, with RFC 7591 `invalid_redirect_uri` /
  `invalid_client_metadata` errors; 20 registrations per IP and per minute;
  at most 200 clients per tenant, purging never-used clients (after 30 days,
  or the oldest ones over an hour old when full) and never a client already
  used. See `docs/oauth.md`.

## [0.8.6] - 2026-10-20

### Added

- Windows uninstall can remove the user's Calame data. Both installers (NSIS
  `.exe` and `.msi`) offer an unchecked "delete my Calame data" option; the NSIS
  uninstaller asks a second confirmation (default: No). Only the
  `%APPDATA%\Calame` folder of the Windows account that runs the uninstall is
  targeted, never during an update or a reinstall, never another account's
  profile, and never a junction, symbolic link or other reparse point (left
  intact with an explanation). The folder is renamed before deletion, so
  `calame.db` and `.calame-secret` go away together or not at all.
- Desktop tray menu: "Réinitialiser le compte administrateur…" for a forgotten
  administrator account. After an explicit confirmation (default: Cancel) it
  stops the local server, moves the whole data folder to a dated backup next to
  it (nothing is deleted, the backup can be put back) and restarts Calame empty
  so a new administrator can be created. It is reachable only from the native
  tray menu: no HTTP route or web command can trigger it. A folder chosen with
  `CALAME_DATA_DIR` is never moved.
- Login page: help for a forgotten administrator account, backed by the
  read-only `GET /api/auth/recovery-help` (it never changes anything and only
  shows the data folder as a placeholder such as `%APPDATA%\Calame`, without
  the OS user name).
- New MCP tool `rag_append_note({ source, path, text })`: adds text verbatim at
  the end of a `.md` / `.txt` note, or creates the note when it is absent, with
  no `expectedVersion` to pass. It is registered with `rag_write_document` and
  has the same opt-in and limits: write toggle on the profile, ticked source,
  authorized folder and read scope, path protections. The server reads the
  note, publishes `old + text` atomically and, if another writer got there
  first (conflict or concurrent creation), retries up to 5 attempts. A refused
  attempt never published anything, so no text is lost or duplicated by a
  retry; `published_unverified` is never retried. Appends are limited to
  64 KiB of UTF-8 per call, and the resulting file to the source's size limit;
  oversized appends are refused and nothing is written. The tool description
  tells AI clients to prefer append for adding a remark and write for
  replacing the whole content. Audit and indexing work as for writes
  (`saved` separate from `indexing`).

### Changed

- `rag_write_document` refusals are now actionable by an AI client:
  `already_exists` and `version_conflict` include the file's current `version`
  and an English instruction to recover (replace with `expectedVersion=<version>`
  and the complete content, or use `rag_append_note` to add text; after a
  conflict, re-read first). The version is only disclosed once every access
  check passed, and it is a snapshot, not a guarantee that the retry succeeds.

### Fixed

- `rag_write_document` no longer reports a false `published_unverified` when
  replacing a file on a Docker Desktop for macOS bind mount (virtiofs). There,
  `RENAME_EXCHANGE` succeeds but acts as a plain rename and never returns the old
  file to the staging folder, which failed the post-publish check (reproduced
  with Calame 0.8.5's helper on Docker Desktop 29.4). When the new file is
  verified at the target and only the old file is missing, the server re-reads
  the target and reports success if its SHA-256 matches what was sent. Every
  other post-publish mismatch still returns `published_unverified`. Native
  macOS/Linux checks are unchanged, and so is the Windows path.
- The `published_unverified` message now says the write probably happened and
  asks to re-read the file before retrying. The `rag_write_document`
  description says the same.

## [0.8.5] - 2026-10-17

### Fixed

- Knowledge base sync uses less of the machine: local ONNX embeddings run on
  at most half the CPUs (1–4 threads, `CALAME_LOCAL_EMBEDDING_THREADS` to
  override, `0` for the onnxruntime default) in batches of 4 that yield to
  pending requests between batches. Progress also moves while one long
  document is embedded (the per-document timeout now counts inactivity), an
  unchanged file rejected as corrupt / too large / parser timeout is not
  re-parsed on every sync, and a watcher event during an active sync triggers
  one follow-up sync instead of being dropped.
- DOCX files are read again: the `@xmldom/xmldom` override is pinned to
  `^0.8.15` (the `>=0.8.15` range resolved to 0.9.x, which mammoth cannot
  use). 0.8.15 is the patched 0.8.x release for the high advisory that motivated
  the override, and `pnpm audit --prod --audit-level=high` stays clean.
- Knowledge base source cards no longer show "undefined document · undefined
  folder": the source list API now returns each source's document and folder
  counts.
- Configuration → Knowledge bases: remaining English words in the French UI
  ("Scopes RAG", "profile", "knowledge bases") are translated, the selection
  summary keeps its space ("10 documents sélectionnés"), and the built-in
  local embedding option shows as "Local embeddings (built in)" in English.
- Local-folder sources: "Test" no longer creates a missing folder and reports
  "Connection verified". Testing, saving and syncing now check that the folder
  exists, is a folder and can be listed (drive letters and UNC shares included).
  A missing or unreadable folder fails with a translated error that shows in the
  sync history (ERROR column) and on the source card. A sync that completes
  between two polls now refreshes the card too, so it no longer stays on
  "Never synced".
- Knowledge bases (Sources and Configuration, ee/rag-core): every visible
  string now follows the chosen language (sync history, "+ New source",
  embedding usage, empty states, PII-masking toggle, save buttons, dialogs,
  relative times). The French embeddings help now points to « Paramètres IA ».
  A test checks fr/en key parity.
- Knowledge base, "+ Add source": saving a source now unwraps the server's
  `{ source }` response (the new source was shown as "undefined" and not
  selected), the source list shows an error with "Réessayer" instead of loading
  forever when the server does not answer, and running syncs show real
  `processed / total` document counters.
- Saving or testing a source no longer spins forever when the server cannot
  reach it (e.g. an unreachable network share): the request times out after
  90 s with an explicit message and a retry action.
- Getting-started checklist and dashboard no longer treat a knowledge base
  whose sync failed (or has not finished) as connected: step 1 only completes
  once a source is indexed, a failed sync is named with a link to the source
  and listed under "Needs attention", and the Sources card lists knowledge
  bases instead of "No sources yet".
- MCP server page: the status and Start/Stop button update right after
  starting or stopping, instead of after reopening the page.
- MCP test chat: with no AI provider for chat, it no longer shows "Using
  Anthropic" (the built-in local embedding model was mistaken for a chat
  provider) and explains what to configure in Settings → AI.
- Knowledge base screens (list, sync status, trash, upload, local-folder source
  form, help tips, sync errors) and the "No data source available" start error
  now follow the app language (EN/FR). Fields specific to the S3, HTTP, Google,
  Notion and SharePoint connectors are still French-only.

### Added

- "Getting started" guide in four steps, following the real model: connect
  data → create a data profile that contains it → create an MCP server attached
  to that profile → connect a client. Each step is derived from what the server
  reports (sources, data profiles, saved MCP servers, audit log), so it shows
  the same state after a reload and refreshes after each action. It stays
  available on every page (a column beside the content, a block above it on
  narrow windows) without covering page actions, and ends on a success screen
  (4/4) that only closes when you close it.
- "Test the MCP", without any AI provider: connects to the running server,
  performs the MCP handshake and lists the discovered tools, or explains why it
  failed (server stopped, unreachable, auth refused, timeout…) and what to do.
  Available on the MCP list cards and on the MCP page; a successful test shows
  as "Connection verified" in the guide, which still waits for a real client
  call to complete step 4.
- New sources start their first sync automatically, and the next step is
  offered in place: from a freshly indexed source, create a data profile that
  contains it; from a data profile, create or attach an MCP server (nothing is
  attached without confirmation).
- MCP "Connection" tab: the snippets use the server's real address, and an API
  key can be created there and inserted into the snippet (shown once).
- Unsaved work is kept when you move between pages: the new-MCP form and data
  profile edits are restored as drafts ("Unsaved changes", with Save and
  Discard), per account, and cleared on save, discard or sign-out.
- Sync history lists every skipped or failed file with its reason, and a
  summary of indexed / unchanged / skipped files; a sync that completed with
  skipped files is told apart from a global failure (storage, embeddings).
- Sync benchmark (`scripts/rag-sync-bench`) and before/after measurements in
  `docs/benchmarks/rag-sync/`.
- `GET /api/audit` accepts an optional `result=success|error` filter.
- The onboarding wizard's first screen offers a knowledge base next to
  databases, and shows which getting-started step each screen belongs to.
- `POST /api/serve/start` returns `code: "no_data_source"` alongside the
  existing message when no source is available.

### Changed

- New MCP servers (from the "New MCP" button and from the onboarding wizard)
  are saved with explicit safe defaults: API-key access, natural answers,
  file writing off. Existing profiles are never overwritten. Each first-launch
  option has a short explanation; file writing and other sign-in methods sit
  under "Advanced options".
- The source form's secondary explanations are folded behind "?" help tips
  (keyboard accessible; clicking pins a tip open).
- You stay signed in when the app restarts: sessions are stored server-side
  (only a SHA-256 hash of the session id), renewed while in use within a 7-day
  limit, and revoked on password change, account deactivation or deletion.
- One file can no longer stop a whole sync: each file is parsed in an
  interruptible worker with a size limit and a per-file timeout; unreadable,
  corrupt or too-large files (e.g. a broken `.docx`) are skipped and reported,
  Word lock files (`~$*.docx`) are ignored, and locked files are retried a
  bounded number of times.
- Ticking a folder (or a whole source) in a data profile selects everything
  inside it, including folders loaded later; a partial selection shows as such.
- Data profile page: a single save action.
- Knowledge base lists keep showing the last known sources during a resync or
  a network error ("Last known list shown") instead of emptying.
- The dashboard shows the MCP server's real address instead of "port 0".
- Wording and readability: plurals follow the count, technical messages
  ("Failed to fetch", internal variable names, "skipped (etag)", "No profiles
  found…") are replaced by translated explanations with an action, and small
  secondary texts on the dark dashboard are larger and higher-contrast.

## [0.8.4] - 2026-10-13

### Security

- Note writes (`rag_write_document`) on macOS and Linux go through a small
  native helper that holds every folder open from the source root and creates,
  replaces and cleans up files relative to those handles (`openat` with
  `O_NOFOLLOW`, then a kernel create-only rename or atomic exchange:
  `renameatx_np` on macOS, `renameat2` on Linux). A folder swapped for a
  symbolic link while a write is in flight can no longer redirect it outside
  the source. If the helper is missing on macOS or Linux, writes are refused
  (`unsupported_platform`) rather than silently falling back.
- Windows keeps the 0.8.3 path-based checks (no directory-handle API is
  reachable from Node), now re-run right before publishing. See the honest
  limits in `docs/rag-write-tool.md`.

### Added

- `published_unverified` error: the write was published but the folder was
  modified concurrently and the result could not be verified. Nothing is rolled
  back; re-read the file before retrying.

## [0.8.3] - 2026-10-09

### Added

- Opt-in note creation and editing over MCP for local folder sources
  (`rag_write_document`, `rag_read_note`). Off by default; enabled per MCP
  profile ("Allow file creation and editing") and per ticked local source.
  Creates `.md`/`.txt` notes without ever overwriting, replaces them only with
  the `expectedVersion` (SHA-256) last read, and reports "saved" separately from
  "indexed". Authorization, scopes and folder grants are re-checked on every
  call, so revoking takes effect immediately. See `docs/rag-write-tool.md`.

### Security

- Note writes refuse Windows path aliases that could bypass the name checks:
  8.3 short names (`CREDEN~1.TXT`), DOS device names (`CON`, `NUL`, `COM1`…),
  `<>:"|?*` (NTFS streams) and names ending with a dot or a space. On Windows,
  where `O_NOFOLLOW` does not exist, the opened file is checked to be the one
  inspected.
- Raised dependencies above newly published high/critical advisories via
  `pnpm.overrides`: `handlebars` (>=4.7.10), `proxy-addr` (>=2.0.8),
  `@modelcontextprotocol/sdk` (^1.31.0), `undici` (>=7.29.1), `sharp`
  (>=0.35.5) and `brace-expansion` (>=5.0.11).

## [0.8.1] - 2026-09-14

### Changed

- The HTTP server now binds to `127.0.0.1` (loopback) by default instead of all
  network interfaces. Because Calame can index local folders and serve database
  profiles over MCP, an all-interfaces default silently exposed that content to
  the local network on a fresh install. Set `CALAME_HOST=0.0.0.0` to listen on
  all interfaces (front it with a reverse proxy / firewall). The Docker image
  sets `CALAME_HOST=0.0.0.0` automatically, so containerized deployments are
  unaffected. The startup log now reports the bound host.

### Security

- Raised transitive dependencies above newly published high-severity advisories
  via `pnpm.overrides`: `@xmldom/xmldom` (>=0.8.15), `nodemailer` (>=9.1.0),
  `sharp` (>=0.35.4) and `js-yaml` (>=4.3.2). The nodemailer bump required a
  small type-only adjustment in the email service.

## [0.8.0] - 2026-09-07

### Added

- Microsoft SQL Server (MSSQL) support: SQL Server now sits alongside
  PostgreSQL, MySQL and SQLite as a source you can connect, explore and
  serve over MCP. Connection strings are accepted in both the ADO style you
  copy out of SSMS (`Server=localhost,1433;Database=mydb;User Id=sa;…`) and
  the URL style used by the other connectors
  (`mssql://user:password@host:1433/mydb`). Tables outside the default `dbo`
  schema are picked up and stay schema-qualified, and all six tools
  (`query`, `aggregate`, `join_aggregate`, `describe`, `list_tables`,
  distinct-value discovery) generate proper T-SQL — bracket-quoted
  identifiers, `OFFSET … FETCH NEXT` paging and `TOP (n)` capped reads.
  **SQL authentication only in this first version**: Windows / Active
  Directory integrated authentication is not supported and is reported as a
  clear error rather than silently failing. Statistical aggregations
  (`median`, `percentile`) remain PostgreSQL-only; `stddev` and `variance`
  work on SQL Server.

### Fixed

- A filter on a column that cannot be filtered — one hidden by masking,
  excluded from the profile, of an unsupported type, or simply misspelled —
  is now rejected with a clear error listing the columns you can filter on.
  Previously `query` and `aggregate` dropped such filters silently and
  returned the _unfiltered_ rows as if the filter had applied, which could
  quietly overstate a result; `join_aggregate` already reported the error, so
  all four tools (including `write`) now behave the same way. Filtering on a
  masked column remains blocked exactly as before.
- Column types that MySQL, SQLite and SQL Server report but PostgreSQL does
  not — notably `datetime`, `float`, `double` and `tinyint` — are now
  recognised, so filters, groupings and date buckets work on those columns
  instead of the column being treated as unfilterable.

## [0.7.3] - 2026-09-04

### Fixed

- Local folder sources now skip `node_modules`, `.git` and hidden files
  (dotfiles) by default, and ignore files larger than 50 MB without reading
  them. All of it is configurable: the source form gains include/exclude
  glob filters and an "include hidden files" checkbox, and skipped-too-large
  files are counted in the sync summary instead of disappearing silently.
- Re-syncing a local folder no longer re-reads every file: unchanged files
  are detected from their size + modification time (one `stat`, zero content
  reads) and skipped before any fetch. Content is still verified by hash
  when a file's timestamp changes without its content changing. Note: a
  write that preserves both size and mtime is not detected — in that rare
  case, delete and recreate the source to force a full re-read (a dedicated
  per-source force-resync is planned as a follow-up).
- The HTTP API now masks personal data (emails, phone numbers, …) in
  `POST /api/rag/search` results and `GET /api/rag/documents/:id` text, with
  the same safe-by-default configuration (`CALAME_RAG_PII_MASK`) already
  applied to the MCP RAG tools. Previously these two endpoints returned the
  indexed text unmasked.
- Files in an unsupported format are no longer re-downloaded and re-analyzed
  on every sync: they are diagnosed once and then skipped until the file
  actually changes (or the source is deleted and recreated). Transient
  errors (parser crash, embedding outage) are still retried on every sync.
- Security: transitive dependencies fast-uri and mysql2 raised above
  recently published high-severity advisories (GHSA-jqff-g426-hqxp and
  friends, GHSA-3f6p-5ww8-9rcr) via pnpm overrides.

## [0.7.1] - 2026-09-01

### Fixed

- Packaged desktop app could fail to locate the bundled local embedding
  model (embedded resource path resolution in the Tauri sidecar), breaking
  on-device RAG on fresh installs. Dev-mode and remote providers were
  unaffected.

## [0.7.0] - 2026-08-30

### Added

- French / English internationalization across the web UI.

### Changed

- `@calame-ee` moved from `dependencies` to `optionalDependencies` so the open-core build installs without the enterprise package.

### Fixed

- PII masking oracle bypass blocked; SSRF guard added to the MCP proxy adapter.
- `formidable` is now bundled into the packaged server (`rag-core`).

## [0.6.0] - 2026-08-20

### Added

- Bundled local embedding model (EmbeddingGemma-300M, q4 ONNX) for RAG:
  documents and search queries are now embedded entirely on-device by
  default, with zero configuration and no data leaving the machine. Remote
  providers (OpenRouter, custom OpenAI-compatible endpoints) remain fully
  available as an explicit choice. Existing installs configured with a
  remote embedding provider are unaffected; a new dimension-migration flow
  (`POST /api/rag/reindex`, surfaced in the UI when switching providers
  would otherwise conflict with already-indexed content) lets them opt in
  by purging and re-ingesting under the new model. See
  `third_party/NOTICES.md` for the bundled model's license (Gemma Terms of
  Use).
- Native OS folder-browse dialog when configuring a local-folder RAG source.
- Animated Metrics dashboard: KPI counters, bar chart, and donut/pool rings
  now tween instead of snapping, with a coherent staged reveal on load.

### Fixed

- RAG search results now expose a true, query-comparable `similarity`
  score alongside the existing internal ranking `score`, plus an optional
  `minSimilarity` cutoff — the ranking score alone couldn't distinguish a
  weak match from a real one.
- PDF documents are now chunked per page instead of as a single block,
  matching how other formats are chunked.
- `rag_list_documents` now recognizes `.` as a root-folder synonym and
  returns an explicit error for a genuinely unknown folder (across every
  source in a multi-source call), instead of silently returning an empty
  list indistinguishable from "this folder is really empty".
- `rag_list_sources` now reports `indexedDocumentCount` separately from
  `documentCount`, so a caller can tell "not indexed yet" from "missing
  access" when a discovered file produced no searchable chunks.
- The sync status badge could get stuck on "in progress" and the source
  list could keep showing a stale "never synced" after a successful sync.
- `resolveAiSetting` could hand back an embeddings-only setting for a chat
  turn; saving an AI setting with reranking enabled was silently dropped.
- Stale claude.ai custom-connector setup instructions in the token manager.

## [0.5.1] - 2026-08-16

### Fixed

- Dashboard activity chart could stay stuck on its empty state: the app
  fetched only the 10 most recent audit entries, so as soon as one server
  had been used that day the 7-day aggregation window collapsed to a
  single day. The dashboard now aggregates over the last 250 entries
  (the activity feed still shows 8).
- Lint: removed disable comments referencing an unconfigured ESLint rule.

## [0.5.0] - 2026-08-15

### Added

- Redesigned Dashboard: a Sources → Data Configurations → MCP Servers
  pipeline strip with per-item drill-down, an activity chart aggregated
  from the audit log (DST-safe), a needs-attention column surfacing
  pending writes, a real masked-columns PII card, and a servers table
  with trend sparklines — all with an orchestrated construction
  animation honoring `prefers-reduced-motion`.
- Data Configurations page: List | Graph toggle. The new graph view
  shows servers, configurations and sources as three aligned layers
  with lineage highlighting (hover any node to trace the full data
  path), click-to-pin details, and drag-to-reorder persisted locally
  with a Reset layout control. List cards now show per-source chips
  and which servers mount each configuration.
- Access visibility: pinning a server in the graph lists the users
  granted access; the Users page gains an "Access matrix" tab (users ×
  servers with R / R+W badges and table-restriction markers).
- ADR 0003: domain terminology decision (Sources, Data Profiles,
  MCP Servers) with a progressive migration plan.

## [0.4.1] - 2026-08-14

### Changed

- UI craft pass on the web app, identity unchanged: four small labels raised
  above the WCAG AA contrast floor (schema tool badge, "+ PII" button, user
  delete button, dashboard OFF pill); chat typing indicator replaced with a
  soft staggered pulse honoring `prefers-reduced-motion`; Metrics progress
  bars now animate on `transform: scaleX` (GPU) instead of `width`; text
  selection, input caret, and placeholders themed from the workspace accent.

### Added

- `docs/RELEASE.md`: step-by-step guide for shipping a desktop release
  (version bump, tagging, CI build, draft publication).
- Impeccable design-detector config (`packages/web/.impeccable/config.json`)
  so UI edits are scanned automatically with vetted ignores.

## [0.2.0] to [0.4.0] (consolidated, recorded late)

### Added

- Per-tenant branding: custom logo and favicon, configurable from
  Settings → Branding (stored as validated base64 data URLs).
- Component test suites for every admin page, plus regression tests for the
  connector error contract and profile-name slugs.
- Architecture Decision Records in `docs/adr/` (encrypted source configs,
  single-version release model).

### Changed

- Major internal refactor (behavior-preserving): backend god-files and the
  web `App.tsx` decomposed into focused modules; shared building blocks for
  RAG connectors (error hierarchy, doc-id codec, pagination); an 800-line
  file-size budget is now enforced in CI.

### Fixed

- Onboarding wizard could create profiles whose names the chat/auth routes
  reject (spaces) — profile names are now slugified, the typed text becomes
  the display label.
- Serving a profile could crash MCP registration in a loop on the relational
  fan-out path (query against a nonexistent table); tenant ownership is now
  resolved via `rag_sources` with a safe default-tenant fallback.
- CI: coverage runs use each package's environment, semgrep invocation fixed,
  Node 18 compatibility (webcrypto import) restored.

## [0.1.0]

Initial baseline — visual MCP-server builder over PostgreSQL/MySQL/SQLite,
profiles with scoped table/column access, PII masking, audit log, RAG document
sources (EE), SSO (EE), multi-tenancy foundations, Docker/GHCR packaging.
