# Document write tool (`rag_write_document`)

An **opt-in** MCP capability that lets a client (Claude Desktop, etc.) create and
fully replace text notes inside a **local folder** RAG source — e.g. an
Obsidian-style vault of mission notes. It is **off by default**: nothing changes
for existing profiles.

Two tools are registered, only when the capability is enabled on the MCP profile:

| Tool                 | Purpose                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rag_read_note`      | Returns the exact text of a `.md`/`.txt` note (front-matter included, which `rag_get_document` strips) and its `version` (sha256 of the raw file). PII masking of the profile is applied. |
| `rag_write_document` | Creates a note (omit `expectedVersion`) or replaces it (pass the `version` last read).                                                                                                    |

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
`unsupported_filesystem`, `unsupported_platform`, `published_unverified`, `io_error`.

`published_unverified` means the publish step ran but the helper could not
confirm its result (the folder was modified concurrently): the target may now
hold something other than what was sent. Nothing is rolled back; re-read the
file before retrying. All other errors mean nothing was published.

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
  On macOS and Linux the check is done with `openat(O_NOFOLLOW)` along the path;
  on Windows with an `lstat` walk plus a canonical-name check (see "Honest limits").
- Only `.md` / `.txt`, UTF-8, default max 256 KiB (hard cap 2 MiB).
- Writes are atomic: temp file (`O_EXCL | O_NOFOLLOW`) + fsync, then a kernel
  create-only publish or an atomic replace:
  - macOS: `renameatx_np` with `RENAME_EXCL` / `RENAME_SWAP`, relative to the
    validated directory fd (temp file in a staging folder held by fd);
  - Linux: `renameat2` with `RENAME_NOREPLACE` / `RENAME_EXCHANGE`, same scheme;
  - Windows: sibling temp file, `link()` (create-only) or `rename()` (replace).
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
- The conflict check and the final swap are not a single atomic filesystem
  operation and this is not a multi-process compare-and-swap: an external editor
  writing between the final check and the swap can still be overwritten (if it
  replaced the file, the swap reports `published_unverified`; an in-place edit is
  not detected). Create-only is enforced by the kernel (`RENAME_EXCL` /
  `RENAME_NOREPLACE` / `link()`).
- Calls through this writer module share a single in-process mutex, including
  case aliases and overlapping source roots. This intentionally trades parallel
  write throughput for safety on case-insensitive filesystems. It does not lock
  external editors or other server processes.
- Requires a filesystem supporting atomic exclusive/swap renames
  (`unsupported_filesystem` otherwise, e.g. some network shares).
- Indexing is asynchronous and can be `unavailable`/`already_running`; the file is
  still saved and picked up by the next sync.
- The content is written as-is: PII masking applies on **read** (`rag_read_note`
  and search), not to what the client chooses to write.
- A local source's root is trusted; if it is itself a symlink, writes are refused.
- The audit log records tool, source, path, size and outcome — not the content.
- **Concurrent local processes (parent/ancestor swap), macOS and Linux**: every
  access goes through the bundled `calame-fsat` helper (`ee/rag-core/native/fsat.c`),
  which opens the root once and walks each folder with
  `openat(O_DIRECTORY | O_NOFOLLOW)`, then creates the temp file in a staging
  folder it holds by fd, publishes it and cleans up. Every syscall takes a
  single name relative to a held directory fd; no path containing `/` is ever
  resolved, so a parent, ancestor or staging folder swapped for a symlink (or
  renamed away) while a write is in flight cannot redirect any step — including
  cleanup — outside the folders reached from the root. Cleanup only removes
  entries it can still identify as its own (device/inode); it never deletes
  foreign entries. An open directory fd does **not** lock the folder: the write
  may land in the folder that was validated even though its name now points
  elsewhere, or be refused. The in-process mutex only orders callers; it is not
  what confines paths.
- **Same-user processes are out of scope for integrity.** The staging folder is
  created with mode `0700`, which only keeps _other_ users out: any process
  running as the same user can rename, replace or delete its entries and the
  target. The helper checks device/inode before publishing (refusing with
  `io_error`, nothing published) and after publishing; a mismatch detected after
  the publish step is reported as `published_unverified`, never as a plain
  refusal, because something was published. What this design achieves is
  directory-fd confinement, not protection against a hostile same-user process.
- **Concurrent local processes, Windows (weaker)**: Node offers no
  directory-handle-relative file API on Windows, so the helper is not used there.
  Paths are checked by an `lstat` walk and a `realpath` canonical check, re-done
  inside the lock and right before publishing; replace also re-checks
  inode/size/mtime/content. This shrinks, but does **not** close, the window in
  which a concurrent local process swaps a parent folder for a link or junction
  between the check and the publish. Same behaviour as 0.8.3.
- **Platforms**: the helper is compiled from C at build time on macOS and Linux
  (`pnpm build` in `ee/rag-core` needs `cc`; a missing compiler fails the build;
  the Docker builder image has one). If it is missing at runtime on macOS/Linux,
  writes fail closed with `unsupported_platform` before touching the disk; there
  is no silent path-based fallback there. Windows ships no helper and uses the
  path-based mode above.

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
