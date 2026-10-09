// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Opt-in MCP tools to create / replace / read back text notes in a LOCAL
 * document source: `rag_write_document` and `rag_read_note`.
 *
 * Authorization is re-evaluated on EVERY call through `resolveTarget`, which
 * the host implements against live state (profile flag, source row, tenant,
 * soft-delete, source type). Nothing about authorization is cached in this
 * module, so revoking the capability or the source takes effect on the next
 * call even for an already-open MCP session (fail-closed).
 *
 * Scope: whole-file create or whole-file replace. There is no patch / append
 * / partial edit, no delete, no rename, no binary.
 */

import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuditLogEntry, ScopeSelection } from '@calame/core';
import { FsWriteError, readTextFile, writeTextFile, sha256Hex } from './fs-write.js';
import { isDocumentAllowedByChain } from './merged-rag-tools.js';

type DocumentScope = Extract<ScopeSelection, { kind: 'document' }>;

export interface ResolvedWriteTarget {
  ok: true;
  sourceId: string;
  sourceName: string;
  /** Absolute root of the local source (server side only, never returned). */
  rootPath: string;
  /** Optional sub-folder restriction ('' / undefined = whole root). */
  folder?: string;
  maxBytes?: number;
  allowedExtensions?: ReadonlyArray<string>;
  /**
   * Document read scopes that must ALL admit the path (registered + live
   * selection), with the same allowList semantics as rag_get_document. A
   * scope with directFetchDisabled refuses note access entirely.
   */
  readScopes?: ReadonlyArray<DocumentScope>;
  /** Indexed document id for the path, when known (matches id allowList entries). */
  documentId?: string;
  /** Indexed folder ancestors of the path (ids + relative paths), when known. */
  folderChain?: ReadonlyArray<{ id: string; path: string }>;
  /** True only when every applicable selection turns PII masking off. */
  piiMaskingOff?: boolean;
}

export type ResolveWriteTarget = (
  sourceName: string,
  relPath: string,
) => Promise<ResolvedWriteTarget | { ok: false; reason: string }>;

export type IndexTriggerResult =
  | { status: 'queued'; jobId: string }
  | { status: 'already_running' }
  | { status: 'unavailable' };

export interface RegisterDocumentWriteToolsOpts {
  server: McpServer;
  profileName: string;
  /** Names the caller may pick from (for error hints only — NOT authorization). */
  sourceNames: ReadonlyArray<string>;
  resolveTarget: ResolveWriteTarget;
  /** Asks the real sync pipeline to (re)index a source. */
  triggerIndex: (sourceId: string) => IndexTriggerResult;
  /** Whether the stored index currently holds `version` for this note. */
  isIndexed?: (sourceId: string, relPath: string, version: string) => Promise<boolean>;
  /** Masks PII in text returned to the client (version is computed on raw bytes). */
  maskText?: (
    text: string,
    sourceId: string,
    target?: ResolvedWriteTarget,
  ) => { text: string; redacted: boolean };
  onAuditLog: (entry: AuditLogEntry) => void;
}

export const WRITE_TOOL_NAME = 'rag_write_document';
export const READ_NOTE_TOOL_NAME = 'rag_read_note';

const json = (obj: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
  ...(isError ? { isError: true } : {}),
});

function insideFolder(relPath: string, folder: string | undefined): boolean {
  if (!folder) return true;
  const f = folder.replace(/^\/+|\/+$/g, '');
  if (f === '') return true;
  return relPath === f || relPath.startsWith(f + '/');
}

/** Path-derived ancestors; a root-level note gets the synthetic root entry rag_list_documents uses. */
function pathChain(relPath: string): Array<{ id: string; path: string }> {
  const parts = relPath.split('/').slice(0, -1);
  if (parts.length === 0) return [{ id: '', path: '' }];
  return parts.map((_, i) => {
    const p = parts.slice(0, i + 1).join('/');
    return { id: p, path: p };
  });
}

function insideReadScope(relPath: string, target: ResolvedWriteTarget): boolean {
  const chain = [...(target.folderChain ?? []), ...pathChain(relPath)];
  return (target.readScopes ?? []).every(
    (scope) =>
      scope.directFetchDisabled !== true &&
      isDocumentAllowedByChain(target.documentId ?? relPath, relPath, chain, scope),
  );
}

export function registerDocumentWriteTools(opts: RegisterDocumentWriteToolsOpts): void {
  const { server, profileName, resolveTarget, triggerIndex, onAuditLog } = opts;

  const audit = (
    tool: string,
    args: Record<string, unknown>,
    summary: string,
    result: 'success' | 'error',
    t0: number,
  ) => {
    onAuditLog({
      id: nanoid(),
      timestamp: new Date().toISOString(),
      profileName,
      toolName: tool,
      // Metadata only — never the note content.
      toolArgs: args,
      result,
      resultSummary: summary,
      durationMs: Date.now() - t0,
    });
  };

  const hint =
    opts.sourceNames.length > 0
      ? ` Writable sources: ${opts.sourceNames.map((n) => `"${n}"`).join(', ')}.`
      : '';

  // -------------------------------------------------------------------------
  // rag_write_document
  // -------------------------------------------------------------------------
  server.tool(
    WRITE_TOOL_NAME,
    `Create a NEW text file or REPLACE THE WHOLE CONTENT of an existing one in an explicitly authorized local folder source. ` +
      `This is a full-file write, not a patch: to change a note, read it with rag_read_note, edit the text, and send the complete new content back. ` +
      `Only UTF-8 .md and .txt files are accepted (size-limited); no delete, rename, binary files, or new folders. ` +
      `Optimistic concurrency: to CREATE, omit expectedVersion (fails if the file already exists). To REPLACE, pass the "version" returned by rag_read_note (or a previous write); ` +
      `if the file changed since, the call is refused with version_conflict and nothing is modified — re-read and retry. ` +
      `The result separates "saved" (on disk, immediate) from "indexing" (search index updated asynchronously: queued / already_running / unavailable); search results may lag by a few seconds.` +
      hint,
    {
      source: z
        .string()
        .min(1)
        .describe('Name of an authorized local source (see rag_list_sources).'),
      path: z
        .string()
        .min(1)
        .max(512)
        .describe(
          'Relative path inside the source, forward slashes, e.g. "notes/nationex.md". Parent folders must already exist.',
        ),
      content: z
        .string()
        .describe('Complete new file content (UTF-8 text, front-matter included if wanted).'),
      expectedVersion: z
        .string()
        .optional()
        .describe('sha256 "version" of the file you last read. Omit to create a new file.'),
    },
    async (args) => {
      const t0 = Date.now();
      const op = args.expectedVersion === undefined ? 'create' : 'replace';
      const baseArgs = { source: args.source, path: args.path, op };
      try {
        const normalizedPath = args.path.normalize('NFC');
        const target = await resolveTarget(args.source, normalizedPath);
        if (!target.ok) {
          audit(WRITE_TOOL_NAME, baseArgs, 'denied: ' + target.reason, 'error', t0);
          return json(
            {
              error: `Writing is not permitted for source "${args.source}".${hint}`,
              code: 'not_permitted',
            },
            true,
          );
        }
        if (
          !insideFolder(normalizedPath, target.folder) ||
          !insideReadScope(normalizedPath, target)
        ) {
          audit(WRITE_TOOL_NAME, baseArgs, 'denied: outside authorized folder', 'error', t0);
          return json(
            {
              error: `Writes to this source are limited to the folder "${target.folder}".`,
              code: 'outside_authorized_folder',
            },
            true,
          );
        }
        const res = await writeTextFile({
          rootPath: target.rootPath,
          relPath: args.path,
          content: args.content,
          expectedVersion: args.expectedVersion,
          maxBytes: target.maxBytes,
          allowedExtensions: target.allowedExtensions,
        });
        let indexing: IndexTriggerResult;
        try {
          indexing = triggerIndex(target.sourceId);
        } catch {
          indexing = { status: 'unavailable' };
        }
        audit(
          WRITE_TOOL_NAME,
          { ...baseArgs, sourceId: target.sourceId, version: res.version, bytes: res.bytes },
          `${op} ok, ${res.bytes} bytes, index=${indexing.status}`,
          'success',
          t0,
        );
        return json({
          saved: true,
          operation: res.created ? 'created' : 'replaced',
          source: target.sourceName,
          path: res.relPath,
          version: res.version,
          bytes: res.bytes,
          indexing: {
            status: indexing.status,
            indexed: false,
            note:
              indexing.status === 'queued'
                ? 'Re-index job started; the note becomes searchable when it completes.'
                : indexing.status === 'already_running'
                  ? 'A sync is already running for this source; the file watcher / next sync will pick up this change.'
                  : 'Indexing could not be triggered; the file is saved and will be indexed by the next sync.',
          },
        });
      } catch (err) {
        if (err instanceof FsWriteError) {
          audit(WRITE_TOOL_NAME, baseArgs, `refused: ${err.code}`, 'error', t0);
          return json({ error: err.message, code: err.code }, true);
        }
        audit(WRITE_TOOL_NAME, baseArgs, 'internal error', 'error', t0);
        return json({ error: 'Write failed.', code: 'io_error' }, true);
      }
    },
  );

  // -------------------------------------------------------------------------
  // rag_read_note
  // -------------------------------------------------------------------------
  server.tool(
    READ_NOTE_TOOL_NAME,
    `Read back the exact current text of a .md / .txt note in an authorized writable local source, including its YAML front-matter (which rag_get_document strips), ` +
      `together with its "version" (sha256 of the raw file) to pass as expectedVersion to rag_write_document. ` +
      `If PII masking applies to the source the returned text is masked, but the version still identifies the real file — a masked text must NOT be written back as-is.` +
      hint,
    {
      source: z.string().min(1).describe('Name of an authorized local source.'),
      path: z.string().min(1).max(512).describe('Relative path inside the source.'),
    },
    async (args) => {
      const t0 = Date.now();
      const baseArgs = { source: args.source, path: args.path, op: 'read' };
      try {
        const normalizedPath = args.path.normalize('NFC');
        const target = await resolveTarget(args.source, normalizedPath);
        if (!target.ok) {
          audit(READ_NOTE_TOOL_NAME, baseArgs, 'denied: ' + target.reason, 'error', t0);
          return json(
            {
              error: `Source "${args.source}" is not available for note access.${hint}`,
              code: 'not_permitted',
            },
            true,
          );
        }
        if (
          !insideFolder(normalizedPath, target.folder) ||
          !insideReadScope(normalizedPath, target)
        ) {
          audit(READ_NOTE_TOOL_NAME, baseArgs, 'denied: outside authorized folder', 'error', t0);
          return json(
            {
              error: `Access is limited to the folder "${target.folder}".`,
              code: 'outside_authorized_folder',
            },
            true,
          );
        }
        const file = await readTextFile({
          rootPath: target.rootPath,
          relPath: args.path,
          maxBytes: target.maxBytes,
          allowedExtensions: target.allowedExtensions,
        });
        const masked = opts.maskText?.(file.content, target.sourceId, target) ?? {
          text: file.content,
          redacted: false,
        };
        let indexed: boolean | undefined;
        try {
          indexed = await opts.isIndexed?.(target.sourceId, file.relPath, file.version);
        } catch {
          indexed = undefined;
        }
        audit(
          READ_NOTE_TOOL_NAME,
          { ...baseArgs, sourceId: target.sourceId, version: file.version },
          `${file.bytes} bytes`,
          'success',
          t0,
        );
        return json({
          source: target.sourceName,
          path: file.relPath,
          version: file.version,
          bytes: file.bytes,
          content: masked.text,
          piiMasked: masked.redacted,
          indexed,
        });
      } catch (err) {
        if (err instanceof FsWriteError) {
          audit(READ_NOTE_TOOL_NAME, baseArgs, `refused: ${err.code}`, 'error', t0);
          return json({ error: err.message, code: err.code }, true);
        }
        audit(READ_NOTE_TOOL_NAME, baseArgs, 'internal error', 'error', t0);
        return json({ error: 'Read failed.', code: 'io_error' }, true);
      }
    },
  );
}

export { sha256Hex as noteVersion };
