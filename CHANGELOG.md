# Changelog

All notable changes to Calame are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project ships as a
single-version product (see `docs/adr/0002-single-version-releases.md` — the
root `package.json` version flows to the Docker image and `create-calame`).

## [Unreleased]

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
