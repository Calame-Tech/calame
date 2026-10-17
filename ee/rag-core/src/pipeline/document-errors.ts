// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Why a single document was rejected by the sync. Every kind is a property
 * of THAT file (its content, its size, a lock held on it, its permissions) —
 * never of the shared infrastructure (storage, embedding engine). The sync
 * worker relies on this split: a rejection is logged with the file path and
 * the loop moves on, and rejections never trip the consecutive-failure
 * circuit-breaker, which exists to detect infrastructure outages.
 *
 *  - `parse_failed`  — the parser threw (corrupt DOCX/PDF, worker crash/OOM).
 *  - `parse_timeout` — the parser exceeded its time budget and was stopped.
 *  - `too_large`     — the file is bigger than the per-document byte cap.
 *  - `locked`        — the file is in use by another program (e.g. Word on
 *                      Windows: EBUSY) and stayed locked after bounded retries.
 *  - `unreadable`    — any other read error (access denied, vanished, …).
 */
export type DocumentRejectionKind =
  | 'parse_failed'
  | 'parse_timeout'
  | 'too_large'
  | 'locked'
  | 'unreadable';

/** A per-file failure that must not stop the rest of the sync. */
export class DocumentRejectedError extends Error {
  readonly kind: DocumentRejectionKind;

  constructor(kind: DocumentRejectionKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DocumentRejectedError';
    this.kind = kind;
  }
}

/**
 * errno codes that mean "someone else holds the file right now". On Windows
 * libuv maps ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION to EBUSY, and a
 * file opened exclusively (or pending deletion, or being scanned by an
 * antivirus) surfaces as EPERM. These are worth a short, bounded retry.
 */
const LOCK_ERRNO_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EAGAIN']);

function errnoCode(err: unknown): string | null {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code;
  }
  return null;
}

/**
 * Translate a filesystem error raised while READING a document into a
 * {@link DocumentRejectedError}. Returns `null` when the error carries no
 * errno code — e.g. an HTTP/S3 connector failure — so the caller keeps
 * treating it as a generic (possibly infrastructure) failure.
 */
export function classifyReadError(err: unknown): DocumentRejectedError | null {
  if (err instanceof DocumentRejectedError) return err;
  const code = errnoCode(err);
  if (code === null) return null;
  if (LOCK_ERRNO_CODES.has(code)) {
    return new DocumentRejectedError(
      'locked',
      `File is locked or in use by another program (${code}). Close it (e.g. in Word) and sync again.`,
      { cause: err },
    );
  }
  if (code === 'EACCES') {
    return new DocumentRejectedError(
      'unreadable',
      `Access denied while reading the file (${code}).`,
      {
        cause: err,
      },
    );
  }
  if (code === 'ENOENT') {
    return new DocumentRejectedError(
      'unreadable',
      `File disappeared during the sync (${code}); it will be picked up again on the next sync if it comes back.`,
      { cause: err },
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new DocumentRejectedError('unreadable', `File could not be read (${code}): ${detail}`, {
    cause: err,
  });
}

/**
 * True for Microsoft Office "owner" lock files (`~$Report.docx`,
 * `~$udget.xlsx`, …). Word creates one next to every document it has open:
 * a ~162-byte binary stub that is NOT a valid Office document, so parsing it
 * always fails. They are never worth indexing. Accepts both `/` and `\`
 * separators so Windows-style paths are handled too.
 */
export function isOfficeTempFile(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.startsWith('~$');
}
