# Document write tool (`rag_write_document`)

An **opt-in** MCP capability that lets a client (Claude Desktop, etc.) create and
fully replace text notes inside a **local folder** RAG source — e.g. an
Obsidian-style vault of mission notes. It is **off by default**: nothing changes
for existing profiles.

Two tools are registered, only when the capability is enabled on the MCP profile:

| Tool | Purpose |
| --- | --- |
| `rag_read_note` | Returns the exact text of a `.md`/`.txt` note (front-matter included, which `rag_get_document` strips) and its `version` (sha256 of the raw file). PII masking of the profile is applied. |
| `rag_write_document` | Creates a note (omit `expectedVersion`) or replaces it (pass the `version` last read). |

## Enabling it

1. Open the MCP profile page → "Allow file creation and editing" (toggle).
2. Tick each local folder source that may be written to.
   Read access to a source **never** implies write access.
3. The source must also be in the profile's knowledge scope.

API equivalent: `PATCH /api/profiles/:name/document-write` with
`{ "enabled": true, "sources": { "<sourceId>": { "folder": "optional/subfolder" } } }`.
Only live `local` sources of the caller's tenant are accepted; `folder` (optional)
restricts writes to a sub-folder (no absolute path, `..`, `\`, `//`, control chars).

Stored in the profile as `documentWrite: { enabled, sources }`.

## Tool contract

`rag_write_document({ source, path, content, expectedVersion? })`

- `source`: name of an authorized local source; `path`: relative, `/`-separated,
  e.g. `nationex/2026-10-09-standup.md`.
- Create: omit `expectedVersion`; fails with `already_exists` if the file exists.
- Replace: `expectedVersion` must equal the current version, else
  `version_conflict` and nothing is modified (re-read, merge, retry).
- Result: `saved` (on disk, immediate) is reported separately from `indexing`
  (`queued` | `already_running` | `unavailable`, always `indexed: false` at return).
  Search results may lag until the re-index job completes.

Error codes: `not_permitted`, `outside_authorized_folder`, `invalid_path`,
`forbidden_path`, `extension_not_allowed`, `too_large`, `invalid_content`,
`root_unavailable`, `parent_missing`, `symlink_refused`, `not_a_regular_file`,
`not_found`, `already_exists`, `version_required`, `version_conflict`,
`unsupported_filesystem`, `io_error`.

## Safety guarantees

- Authorization (profile flag, source row, tenant, soft-delete, source type) is
  re-evaluated against live state on **every call**; revoking takes effect
  immediately, even for sessions already open.
- Both note tools enforce the intersection of the original session's document
  scope, the live profile/configuration scope, and the source's write-folder grant.
  Deleted profiles/configurations and removed sources fail closed. A live scope
  expansion never broadens an already-open session; reconnect for expanded access.
- Paths: relative only; `..`, empty/`.` segments, backslashes, control characters,
  encoded separators/dots rejected; hidden files/folders, `node_modules` and
  sensitive names (credentials, keys…) refused.
- Windows-hostile names are rejected on every platform: `<>:"|?*` (`:` would
  address an NTFS alternate data stream), names ending with a dot or a space,
  and DOS device names (`CON`, `NUL`, `COM1`, `LPT1`… whatever the extension).
- Existing folders and files must be reached by their real on-disk name (case
  aside): aliases such as Windows 8.3 short names (`CREDEN~1.TXT`) are refused,
  so they cannot bypass the name checks above.
- Symlinks are refused (root, parents, target). Parent folders are **never created**.
  On Windows `O_NOFOLLOW` does not exist: the protection relies on the `lstat`
  walk plus a check that the opened file is the one inspected (same inode/device).
- Only `.md` / `.txt`, UTF-8, default max 256 KiB (hard cap 2 MiB).
- Writes are atomic: temp file (`O_EXCL`, plus `O_NOFOLLOW` where available) + fsync, then rename (replace)
  or `link()` (create-only, race-safe).
- No delete, rename, append, patch or binary files.
- Each attempt (success or refusal) goes through the profile audit log.
- Re-indexing uses the real sync queue (same path as a manual sync).

## Example: Nationex mission notes

1. Add the notes folder as a `local` source "Nationex notes".
2. On the MCP profile used by Claude Desktop, enable file creation and tick it.
3. Ask: "Summarize today's standup and save it as `standup/2026-10-09.md`".
   The client calls `rag_write_document`; later edits call `rag_read_note` first
   to get the `version`.

## Honest limits

- **Replace-whole-file only**: the client sends the full content. Concurrent edits
  made by another tool between read and write are detected (`version_conflict`),
  but there is no merge.
- The conflict check and the final rename are not a single atomic filesystem
  operation: an external editor writing in the microseconds between the final check
  and the rename can still be overwritten. Create-only is race-safe.
- Calls through this writer module share a single in-process mutex, including
  case aliases and overlapping source roots. This intentionally trades parallel
  write throughput for safety on case-insensitive filesystems. It does not lock
  external editors or other server processes.
- Requires a filesystem supporting hard links for create-only
  (`unsupported_filesystem` otherwise, e.g. some network shares).
- Indexing is asynchronous and can be `unavailable`/`already_running`; the file is
  still saved and picked up by the next sync.
- The content is written as-is: PII masking applies on **read** (`rag_read_note`
  and search), not to what the client chooses to write.
- A local source's root is trusted; if it is itself a symlink, writes are refused.
- The audit log records tool, source, path, size and outcome — not the content.

## Verification

The host regression suite uses the real authorization closure and SQLite source
lookup, including persisted non-default tenant profiles, linked configuration
deletion/reduction, and restrictions on both read and write in an open session.

`packages/cli/src/routes/__tests__/serve-document-write-indexing.integration.test.ts`
is an opt-in integration test using the real local connector, sync queue,
ingestion pipeline, bundled ONNX model, and sqlite-vec store. Set
`CALAME_TEST_MODEL_ROOT` to the directory containing `embeddinggemma-300m/` and
run it with Vitest. It verifies creation/replacement, raw-content versions,
completed sync jobs, persisted chunks/vectors, `indexed: true`, and grants using
real indexed document/folder IDs. It never downloads a model or fabricates vectors.

For an actual MCP Streamable HTTP round-trip, first check a free loopback port in
8100–8199, then set `CALAME_TEST_MCP_PORT` while running
`packages/cli/src/routes/__tests__/serve-document-write.test.ts`. The smoke server
is closed at test completion; it does not touch the active Calame instance.
