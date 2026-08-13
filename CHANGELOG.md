# Changelog

All notable changes to Calame are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project ships as a
single-version product (see `docs/adr/0002-single-version-releases.md` — the
root `package.json` version flows to the Docker image and `create-calame`).

## [Unreleased]

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
