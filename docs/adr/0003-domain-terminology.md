# ADR 0003 — Domain terminology: Sources, Data Profiles, MCP Servers

**Status:** Proposed (2026-08-14)

## Context

The product pipeline has three distinct concepts, but today's names cross each
other twice between the code and the UI:

| Pipeline step | What it is | Code type | UI label today |
| --- | --- | --- | --- |
| 1. Connect data | A connected system (PostgreSQL, Notion, S3, RAG connector…) | source | "Sources" |
| 2. Scope data | A named, scoped view over one or more sources: `sources[]` + per-source `scopes` (e.g. "HR sees these tables of the HR database and this Notion section") | `Configuration` (`types/schema.ts`) | "Data Configurations" |
| 3. Serve it | The servable unit: referenced configurations + `authMode` + AI settings + row-level `dataScopeRules`; once started it is a running MCP endpoint (`ServeStatus`) | `Profile` (`types/schema.ts`) | "MCP Servers" |

Two problems:

1. **The code's `Profile` is not what humans mean by "data profile".** In every
   product conversation, "the HR profile" means step 2 (a scoped view of data).
   The code uses `Profile` for step 3 (the serving definition), and ~1,200
   occurrences of "profile" in the web package refer to it (`ProfilePreview`,
   `profiles.yaml`, `UserProfileAccess.profileName`, `slugifyProfileName`…),
   while the UI calls that same object "MCP Server" (~130 occurrences).
2. **`Profile` still carries legacy direct `sources?`/`scopes?` fields**
   ("Phase 2+"), predating `Configuration`. Two types with the same shape keep
   the concepts blurred and invite scoping logic into the wrong layer.

## Decision

Adopt one vocabulary everywhere, aligned with the pipeline:

1. **Source** — a connected data system. (Unchanged.)
2. **Data Profile** — the scoped view (today's code `Configuration`). UI nav
   "Data Configurations" is renamed **"Data Profiles"**. Users compose them per
   audience: HR profile, sales profile, press-kit profile.
3. **MCP Server** — the serving unit (today's code `Profile`): one or more
   data profiles + auth mode + AI settings + row-level scoping, with a visible
   **Active / Stopped** state (verbs **Start / Stop**, as already used by
   `ServePanel`). The word "profile" never appears in the UI for this object.

The word "configuration" is retired from the domain vocabulary (it remains for
technical settings like `Config`/transport). The word "profile" always means
**data profile**, never the serving unit.

## Migration plan (progressive, no big bang)

Ordered so each step ships independently and user-visible wins land first:

1. **UI copy only** — rename nav "Data Configurations" → "Data Profiles" and
   sweep remaining user-visible "profile" strings that mean the serving unit
   (audit log labels, onboarding, tooltips). No type changes. Low risk.
2. **Type aliases** — introduce `type DataProfile = Configuration` and
   `type McpServer = Profile` in `types/schema.ts`; new code must use the new
   names. Zero runtime impact.
3. **Deprecate legacy fields** — mark `Profile.sources`/`Profile.scopes` as
   `@deprecated`, migrate remaining readers to go through configurations, then
   drop the fields behind a data migration for old `profiles.yaml` files.
4. **Mechanical renames, file by file** — flip imports to the new names
   (`Configuration` → `DataProfile`, `Profile` → `McpServer`), rename UI
   components as touched (`ProfilePreview` → `McpServerPreview`…). The CI
   800-line budget already forces small files; rename opportunistically with
   other work in the same file.
5. **On-disk formats last** — `profiles.yaml` / `configurations.yaml` keys and
   the persistence layer keep their current names until a dedicated versioned
   migration; serialized formats are a compatibility contract with existing
   installs and are NOT renamed as a side effect of steps 1–4.

## Consequences

- Product conversations, UI, and code converge on one mental model:
  **Sources → Data Profiles → MCP Servers (Start/Stop)**.
- "MCP Server" stays the outward-facing name (it is what Claude Desktop,
  Cursor, and the MCP ecosystem call the thing users connect to).
- Until step 4 completes, readers of the code must know that legacy
  `Profile` = MCP Server. The aliases in step 2 make this self-documenting at
  every new call site.
- `UserProfileAccess` (per-user access to a serving unit) becomes
  `UserServerAccess` in step 4; its `profileName` key follows step 5's rules.
