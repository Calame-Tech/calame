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
 * Scope: whole-file create or whole-file replace, plus `rag_append_note`
 * (server-side read + version + atomic replace, retried on conflict). There is
 * no patch / partial edit, no delete, no rename, no binary.
 */

import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuditLogEntry, ScopeSelection } from '@calame/core';
import {
  effectiveMaxBytes,
  FsWriteError,
  readFileVersion,
  readTextFile,
  writeTextFile,
  sha256Hex,
} from './fs-write.js';
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
export const APPEND_NOTE_TOOL_NAME = 'rag_append_note';

/** Max size of the text added by one rag_append_note call, in UTF-8 bytes. */
export const APPEND_MAX_BYTES = 64 * 1024;
/** Total attempts (read + conditional publish) before an append gives up. */
export const APPEND_MAX_ATTEMPTS = 5;

const json = (obj: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Recovery guidance for a refused write, built from the file's current version.
 * Only called once the target passed every access check (resolveTarget, folder,
 * read scope), so the version never leaks outside the authorized perimeter.
 */
function recoveryMessage(code: 'already_exists' | 'version_conflict', version: string): string {
  const snapshot =
    'This version is a snapshot, not a reservation: if the file changes again, the replace is refused with version_conflict.';
  return code === 'already_exists'
    ? `File already exists (current version ${version}). ` +
        `To REPLACE it, call ${WRITE_TOOL_NAME} again with expectedVersion="${version}" and the COMPLETE new content (read it first with ${READ_NOTE_TOOL_NAME} if you need the current text). ` +
        `To ADD text at the end, use ${APPEND_NOTE_TOOL_NAME} instead (no version needed). ${snapshot}`
    : `The file changed since you read it (current version ${version}); nothing was modified. ` +
        `Re-read it with ${READ_NOTE_TOOL_NAME}, apply your change to the current text, then retry with the COMPLETE new content and expectedVersion set to the version you re-read. ` +
        `To ADD text at the end, use ${APPEND_NOTE_TOOL_NAME} instead. ${snapshot}`;
}

/** "saved" is on disk; this reports the (asynchronous) search index side only. */
function indexingInfo(indexing: IndexTriggerResult) {
  return {
    status: indexing.status,
    indexed: false,
    note:
      indexing.status === 'queued'
        ? 'Re-index job started; the note becomes searchable when it completes.'
        : indexing.status === 'already_running'
          ? 'A sync is already running for this source; the file watcher / next sync will pick up this change.'
          : 'Indexing could not be triggered; the file is saved and will be indexed by the next sync.',
  };
}

/**
 * Server-side append: read the note, publish old + text conditioned on the
 * version just read (or create-only when absent), retry on a refusal that
 * guarantees nothing was published (version_conflict / already_exists /
 * not_found). Any other error — notably published_unverified — is thrown
 * as-is and never retried, so a retry cannot duplicate the text.
 *
 * In-process appends are queued (single queue, like the writer's mutex, so
 * case aliases and overlapping roots are covered); the retries handle other
 * writers (rag_write_document, external editors, other processes).
 */
let appendQueue: Promise<unknown> = Promise.resolve();

function appendToNote(
  target: ResolvedWriteTarget,
  relPath: string,
  text: string,
): ReturnType<typeof appendOnce> {
  const run = appendQueue.then(() => appendOnce(target, relPath, text));
  appendQueue = run.catch(() => {});
  return run;
}

async function appendOnce(
  target: ResolvedWriteTarget,
  relPath: string,
  text: string,
): Promise<{
  relPath: string;
  version: string;
  bytes: number;
  created: boolean;
  attempts: number;
}> {
  const limits = { maxBytes: target.maxBytes, allowedExtensions: target.allowedExtensions };
  const maxBytes = effectiveMaxBytes(limits);
  for (let attempt = 1; attempt <= APPEND_MAX_ATTEMPTS; attempt++) {
    let current: { content: string; version: string } | null = null;
    try {
      current = await readTextFile({ rootPath: target.rootPath, relPath, ...limits });
    } catch (err) {
      if (!(err instanceof FsWriteError) || err.code !== 'not_found') throw err;
    }
    let prefix = '';
    if (current) {
      // TextDecoder drops a leading BOM: put it back so the existing bytes are
      // preserved exactly, and refuse rather than rewrite anything else.
      prefix = current.content;
      if (sha256Hex(prefix) !== current.version) prefix = '\uFEFF' + prefix;
      if (sha256Hex(prefix) !== current.version) {
        throw new FsWriteError(
          'invalid_content',
          'The existing note cannot be appended to without altering it.',
        );
      }
    }
    const content = prefix + text;
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new FsWriteError(
        'too_large',
        `Appending would make the file exceed the ${maxBytes}-byte limit; nothing was appended.`,
      );
    }
    try {
      const res = await writeTextFile({
        rootPath: target.rootPath,
        relPath,
        content,
        expectedVersion: current?.version,
        ...limits,
      });
      return { ...res, attempts: attempt };
    } catch (err) {
      const retryable =
        err instanceof FsWriteError &&
        (err.code === 'version_conflict' ||
          err.code === 'already_exists' ||
          err.code === 'not_found');
      if (!retryable) throw err;
    }
  }
  throw new FsWriteError(
    'version_conflict',
    `The note kept changing during ${APPEND_MAX_ATTEMPTS} attempts; nothing was appended by this call. It is safe to call ${APPEND_NOTE_TOOL_NAME} again.`,
  );
}

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

  const startIndexing = (sourceId: string): IndexTriggerResult => {
    try {
      return triggerIndex(sourceId);
    } catch {
      return { status: 'unavailable' };
    }
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
      `already_exists and version_conflict errors include the file's current "version" (a snapshot) and how to recover. ` +
      `If the call returns published_unverified, the write probably happened: re-read the file with rag_read_note before retrying, never resend blindly. ` +
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
      // Set only once every access check passed (gates version disclosure).
      let authorized: ResolvedWriteTarget | undefined;
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
        authorized = target;
        const res = await writeTextFile({
          rootPath: target.rootPath,
          relPath: args.path,
          content: args.content,
          expectedVersion: args.expectedVersion,
          maxBytes: target.maxBytes,
          allowedExtensions: target.allowedExtensions,
        });
        const indexing = startIndexing(target.sourceId);
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
          indexing: indexingInfo(indexing),
        });
      } catch (err) {
        if (err instanceof FsWriteError) {
          if (authorized && (err.code === 'already_exists' || err.code === 'version_conflict')) {
            let version: string | null = null;
            try {
              version = await readFileVersion({
                rootPath: authorized.rootPath,
                relPath: args.path,
                allowedExtensions: authorized.allowedExtensions,
              });
            } catch {
              version = null;
            }
            if (version) {
              audit(
                WRITE_TOOL_NAME,
                { ...baseArgs, sourceId: authorized.sourceId, currentVersion: version },
                `refused: ${err.code}`,
                'error',
                t0,
              );
              return json(
                { error: recoveryMessage(err.code, version), code: err.code, version },
                true,
              );
            }
          }
          audit(WRITE_TOOL_NAME, baseArgs, `refused: ${err.code}`, 'error', t0);
          return json({ error: err.message, code: err.code }, true);
        }
        audit(WRITE_TOOL_NAME, baseArgs, 'internal error', 'error', t0);
        return json({ error: 'Write failed.', code: 'io_error' }, true);
      }
    },
  );

  // -------------------------------------------------------------------------
  // rag_append_note
  // -------------------------------------------------------------------------
  server.tool(
    APPEND_NOTE_TOOL_NAME,
    `Add text at the END of a .md / .txt note in an explicitly authorized local folder source, or create the note with that text if it does not exist. ` +
      `PREFER this tool to add a remark, a log entry or a paragraph; use ${WRITE_TOOL_NAME} only to replace the WHOLE content. ` +
      `No version is needed: the server reads the note, appends and publishes atomically, retrying internally if another writer changes the file meanwhile, so concurrent appends are never lost. ` +
      `The text is appended byte for byte: no newline or separator is added, so start it with "\\n" if it must begin on a new line. ` +
      `Max ${APPEND_MAX_BYTES} UTF-8 bytes per call, and the resulting file must stay within the source's file size limit (otherwise nothing is appended). ` +
      `If the call returns published_unverified, the append probably happened: re-read the file with ${READ_NOTE_TOOL_NAME} before retrying, never resend blindly (the text could be added twice). ` +
      `The result separates "saved" (on disk, immediate) from "indexing" (search index updated asynchronously).` +
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
      text: z
        .string()
        .min(1)
        .describe(
          `Text to add at the end of the note, verbatim (UTF-8, max ${APPEND_MAX_BYTES} bytes).`,
        ),
    },
    async (args) => {
      const t0 = Date.now();
      const baseArgs = { source: args.source, path: args.path, op: 'append' };
      try {
        const normalizedPath = args.path.normalize('NFC');
        const target = await resolveTarget(args.source, normalizedPath);
        if (!target.ok) {
          audit(APPEND_NOTE_TOOL_NAME, baseArgs, 'denied: ' + target.reason, 'error', t0);
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
          audit(APPEND_NOTE_TOOL_NAME, baseArgs, 'denied: outside authorized folder', 'error', t0);
          return json(
            {
              error: `Writes to this source are limited to the folder "${target.folder}".`,
              code: 'outside_authorized_folder',
            },
            true,
          );
        }
        const textBytes = Buffer.byteLength(args.text, 'utf8');
        if (textBytes > APPEND_MAX_BYTES) {
          throw new FsWriteError(
            'too_large',
            `Text to append exceeds the ${APPEND_MAX_BYTES}-byte limit (${textBytes} UTF-8 bytes); nothing was appended. Split it into several calls.`,
          );
        }
        const res = await appendToNote(target, args.path, args.text);
        const indexing = startIndexing(target.sourceId);
        const op = res.created ? 'created' : 'appended';
        audit(
          APPEND_NOTE_TOOL_NAME,
          {
            ...baseArgs,
            sourceId: target.sourceId,
            version: res.version,
            bytes: res.bytes,
            appendedBytes: textBytes,
            attempts: res.attempts,
          },
          `${op} ok, +${textBytes} bytes (${res.bytes} total), attempts=${res.attempts}, index=${indexing.status}`,
          'success',
          t0,
        );
        return json({
          saved: true,
          operation: op,
          source: target.sourceName,
          path: res.relPath,
          version: res.version,
          bytes: res.bytes,
          appendedBytes: textBytes,
          indexing: indexingInfo(indexing),
        });
      } catch (err) {
        if (err instanceof FsWriteError) {
          audit(APPEND_NOTE_TOOL_NAME, baseArgs, `refused: ${err.code}`, 'error', t0);
          return json({ error: err.message, code: err.code }, true);
        }
        audit(APPEND_NOTE_TOOL_NAME, baseArgs, 'internal error', 'error', t0);
        return json({ error: 'Append failed.', code: 'io_error' }, true);
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
