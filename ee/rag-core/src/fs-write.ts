// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Safe create / replace of UTF-8 text files under a local-folder source root.
 *
 * Threat model: the caller (an MCP client holding a profile token) controls
 * `relPath` and `content`; the source root is admin-configured and trusted.
 *
 * Guarantees (see docs/rag-write-tool.md for the honest limits):
 *  - `relPath` is a strict, relative, forward-slash path. Absolute POSIX /
 *    Windows / UNC paths, `..`, backslashes, NUL / control chars,
 *    percent-encoded separators and dot segments are rejected.
 *  - Every directory component below the root and the target itself is
 *    `lstat`-checked: symlinks are refused (parents and file). The root
 *    itself must not be a symlink.
 *  - Parents are NEVER created.
 *  - Writes go to a sibling temp file (`O_EXCL | O_NOFOLLOW`), fsync'd, then:
 *      create  → `link(tmp, target)` (atomic, fails with EEXIST: create-only
 *                is enforced by the kernel, even against external writers),
 *      replace → compare-then-`rename` under a module-wide in-process mutex.
 *  - Error messages never include absolute paths or content.
 *
 * NOT a multi-writer CAS: replace re-hashes the current file and re-stats it
 * right before `rename`, which shrinks — but cannot close — the window in
 * which an EXTERNAL writer (editor, sync client, another process) can change
 * the file. Concurrent calls through this module are fully serialized.
 */

import { constants as fsc } from 'node:fs';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { posix, relative } from 'node:path';

export const DEFAULT_WRITE_ALLOWED_EXTENSIONS: ReadonlyArray<string> = ['.md', '.txt'];
export const DEFAULT_WRITE_MAX_BYTES = 256 * 1024;
/** Hard ceiling regardless of configuration. */
export const ABSOLUTE_WRITE_MAX_BYTES = 2 * 1024 * 1024;

export type FsWriteErrorCode =
  | 'invalid_path'
  | 'forbidden_path'
  | 'extension_not_allowed'
  | 'too_large'
  | 'invalid_content'
  | 'root_unavailable'
  | 'parent_missing'
  | 'symlink_refused'
  | 'not_a_regular_file'
  | 'not_found'
  | 'already_exists'
  | 'version_required'
  | 'version_conflict'
  | 'unsupported_filesystem'
  | 'io_error';

export class FsWriteError extends Error {
  constructor(
    public readonly code: FsWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FsWriteError';
  }
}

export interface FsWriteLimits {
  allowedExtensions?: ReadonlyArray<string>;
  maxBytes?: number;
}

export interface WriteTextFileInput extends FsWriteLimits {
  /** Admin-configured absolute root of the local source. */
  rootPath: string;
  /** Relative path inside the root (forward slashes). */
  relPath: string;
  content: string;
  /**
   * `undefined` → create-only (fails if the file exists).
   * A sha256 hex string → replace only if the current file hashes to it.
   */
  expectedVersion?: string;
}

export interface WriteTextFileResult {
  relPath: string;
  version: string;
  bytes: number;
  created: boolean;
}

export interface ReadTextFileInput extends FsWriteLimits {
  rootPath: string;
  relPath: string;
}

export interface ReadTextFileResult {
  relPath: string;
  content: string;
  version: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_PATH_LENGTH = 512;
const MAX_SEGMENT_LENGTH = 255;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[a-zA-Z]:/;
const PERCENT_ENCODED_SPECIAL = /%(2e|2f|5c|00)/i;
const SENSITIVE_NAME =
  /^(\.env.*|.*credentials?.*|.*secrets?.*|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|dsa|ecdsa|ed25519).*|\.npmrc|\.netrc|authorized_keys|passwd|shadow)$/i;
// Characters Windows refuses in names. `:` would otherwise address an NTFS
// alternate data stream. Rejected on every platform so vaults stay portable.
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;
// DOS device names, reserved whatever the extension ("CON.md", "COM¹.txt").
const WINDOWS_RESERVED_STEM = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Validate & normalize a client-supplied relative path. Returns its segments. */
export function validateRelPath(relPath: unknown, limits: FsWriteLimits = {}): string[] {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new FsWriteError('invalid_path', 'Path must be a non-empty string.');
  }
  if (relPath.length > MAX_PATH_LENGTH) {
    throw new FsWriteError('invalid_path', 'Path is too long.');
  }
  const p = relPath.normalize('NFC');
  if (CONTROL_CHARS.test(p)) {
    throw new FsWriteError('invalid_path', 'Path contains control characters.');
  }
  if (p.includes('\\')) {
    throw new FsWriteError('invalid_path', 'Backslashes are not allowed; use "/" separators.');
  }
  if (p.startsWith('/') || WINDOWS_DRIVE.test(p)) {
    throw new FsWriteError('invalid_path', 'Path must be relative to the source root.');
  }
  if (PERCENT_ENCODED_SPECIAL.test(p)) {
    throw new FsWriteError('invalid_path', 'Encoded path separators or dots are not allowed.');
  }
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new FsWriteError('invalid_path', 'Path contains empty, "." or ".." segments.');
    }
    if (seg.length > MAX_SEGMENT_LENGTH) {
      throw new FsWriteError('invalid_path', 'Path segment is too long.');
    }
    if (WINDOWS_INVALID_CHARS.test(seg)) {
      throw new FsWriteError(
        'invalid_path',
        'Path contains a character that is not allowed in file names.',
      );
    }
    // Windows silently strips trailing dots/spaces, which makes the name alias another one.
    if (/[. ]$/.test(seg)) {
      throw new FsWriteError('invalid_path', 'Names must not end with a dot or a space.');
    }
    if (WINDOWS_RESERVED_STEM.test((seg.split('.')[0] as string).trimEnd())) {
      throw new FsWriteError('forbidden_path', 'This file or folder name is reserved by Windows.');
    }
    if (seg.startsWith('.')) {
      throw new FsWriteError('forbidden_path', 'Hidden files and folders are not allowed.');
    }
    if (seg === 'node_modules' || SENSITIVE_NAME.test(seg)) {
      throw new FsWriteError('forbidden_path', 'This file or folder name is not allowed.');
    }
  }
  const allowed = limits.allowedExtensions ?? DEFAULT_WRITE_ALLOWED_EXTENSIONS;
  const ext = posix.extname(segments[segments.length - 1] as string).toLowerCase();
  if (!allowed.map((e) => e.toLowerCase()).includes(ext)) {
    throw new FsWriteError(
      'extension_not_allowed',
      `Only these extensions are allowed: ${allowed.join(', ')}.`,
    );
  }
  return segments;
}

function effectiveMaxBytes(limits: FsWriteLimits): number {
  const n = limits.maxBytes ?? DEFAULT_WRITE_MAX_BYTES;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WRITE_MAX_BYTES;
  return Math.min(Math.floor(n), ABSOLUTE_WRITE_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// Filesystem walk (no symlinks, no parent creation)
// ---------------------------------------------------------------------------

interface Resolved {
  rootReal: string;
  dir: string;
  target: string;
  name: string;
}

async function resolveParents(rootPath: string, segments: string[]): Promise<Resolved> {
  let rootReal: string;
  try {
    const rootStat = await lstat(rootPath);
    if (rootStat.isSymbolicLink()) {
      throw new FsWriteError('symlink_refused', 'The source root must not be a symbolic link.');
    }
    if (!rootStat.isDirectory())
      throw new FsWriteError('root_unavailable', 'Source root unavailable.');
    rootReal = await realpath(rootPath);
  } catch (err) {
    if (err instanceof FsWriteError) throw err;
    throw new FsWriteError('root_unavailable', 'Source root is unavailable.');
  }
  let dir = rootReal;
  for (const seg of segments.slice(0, -1)) {
    const next = posix.join(dir, seg);
    let st;
    try {
      st = await lstat(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FsWriteError(
          'parent_missing',
          'A parent folder does not exist (it is never created).',
        );
      }
      throw new FsWriteError('io_error', 'Cannot inspect parent folder.');
    }
    if (st.isSymbolicLink()) {
      throw new FsWriteError('symlink_refused', 'Symbolic links are not allowed in the path.');
    }
    if (!st.isDirectory()) {
      throw new FsWriteError('invalid_path', 'A parent path component is not a folder.');
    }
    dir = next;
  }
  const name = segments[segments.length - 1] as string;
  const target = posix.join(dir, name);
  if (segments.length > 1) await assertCanonical(rootReal, dir, segments.slice(0, -1));
  let targetStat;
  try {
    targetStat = await lstat(target);
  } catch {
    targetStat = undefined; // Missing target: nothing to alias yet.
  }
  // Symlinked targets are refused later by readRegular.
  if (targetStat && !targetStat.isSymbolicLink()) await assertCanonical(rootReal, target, segments);
  return { rootReal, dir, target, name };
}

/**
 * Refuses a path that only reaches an existing entry through an on-disk alias,
 * e.g. a Windows 8.3 short name (`CREDEN~1.TXT` → `credentials.txt`), which
 * would slip past the name checks of validateRelPath. The real names must
 * match the requested ones; only case may differ (case-insensitive volumes,
 * serialized by the module-wide mutex).
 */
async function assertCanonical(
  rootReal: string,
  absPath: string,
  requested: string[],
): Promise<void> {
  let real: string;
  try {
    real = await realpath(absPath);
  } catch {
    throw new FsWriteError('io_error', 'Cannot resolve path.');
  }
  const actual = relative(rootReal, real).split(/[\\/]/).filter(Boolean);
  const fold = (s: string) => s.normalize('NFC').toLowerCase();
  const same =
    actual.length === requested.length &&
    actual.every((seg, i) => fold(seg) === fold(requested[i] as string));
  if (!same) {
    throw new FsWriteError(
      'forbidden_path',
      'Use the real file or folder name (short or aliased names are not allowed).',
    );
  }
}

async function readRegular(
  target: string,
  maxBytes: number,
): Promise<{ buf: Buffer; ino: number; mtimeMs: number; size: number; mode: number } | null> {
  let fh: FileHandle | undefined;
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink())
      throw new FsWriteError('symlink_refused', 'Target is a symbolic link.');
    if (!st.isFile()) throw new FsWriteError('not_a_regular_file', 'Target is not a regular file.');
    fh = await open(target, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    const fst = await fh.stat();
    if (!fst.isFile())
      throw new FsWriteError('not_a_regular_file', 'Target is not a regular file.');
    // O_NOFOLLOW does not exist on Windows (constant undefined → no-op): make
    // sure the opened file is still the one lstat inspected.
    if (fst.ino !== st.ino || fst.dev !== st.dev) {
      throw new FsWriteError('symlink_refused', 'Target changed while it was being opened.');
    }
    if (fst.size > maxBytes)
      throw new FsWriteError('too_large', 'Existing file exceeds the size limit.');
    const buf = await fh.readFile();
    return { buf, ino: fst.ino, mtimeMs: fst.mtimeMs, size: fst.size, mode: fst.mode & 0o777 };
  } catch (err) {
    if (err instanceof FsWriteError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new FsWriteError('symlink_refused', 'Target is a symbolic link.');
    throw new FsWriteError('io_error', 'Cannot read target file.');
  } finally {
    await fh?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// In-process serialization (per absolute target path)
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function readTextFile(input: ReadTextFileInput): Promise<ReadTextFileResult> {
  const segments = validateRelPath(input.relPath, input);
  const maxBytes = effectiveMaxBytes(input);
  const { target } = await resolveParents(input.rootPath, segments);
  const file = await readRegular(target, maxBytes);
  if (!file) throw new FsWriteError('not_found', 'File not found.');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(file.buf);
  } catch {
    throw new FsWriteError('invalid_content', 'File is not valid UTF-8 text.');
  }
  return {
    relPath: segments.join('/'),
    content,
    version: sha256Hex(file.buf),
    bytes: file.buf.length,
  };
}

export async function writeTextFile(input: WriteTextFileInput): Promise<WriteTextFileResult> {
  const segments = validateRelPath(input.relPath, input);
  const maxBytes = effectiveMaxBytes(input);
  if (typeof input.content !== 'string') {
    throw new FsWriteError('invalid_content', 'Content must be a string.');
  }
  if (input.content.includes('\u0000')) {
    throw new FsWriteError('invalid_content', 'Content must be text (NUL byte found).');
  }
  const data = Buffer.from(input.content, 'utf8');
  if (data.length > maxBytes) {
    throw new FsWriteError('too_large', `Content exceeds the ${maxBytes}-byte limit.`);
  }
  if (input.expectedVersion !== undefined && !/^[0-9a-f]{64}$/.test(input.expectedVersion)) {
    throw new FsWriteError(
      'version_required',
      'expectedVersion must be a 64-char sha256 hex string.',
    );
  }

  await resolveParents(input.rootPath, segments);
  // Note writes are bounded, low-volume operations. Serialize module-wide:
  // path strings are not reliable file identities on case-insensitive volumes
  // or for overlapping source roots, and normalizing case would miss aliases.
  return withLock('document-write', async () => {
    // Re-resolve inside the lock: shrinks the window for parent swaps.
    const { dir, target, name } = await resolveParents(input.rootPath, segments);
    const tmp = posix.join(
      dir,
      `.calame-tmp-${randomBytes(8).toString('hex')}-${name}`.slice(0, 200),
    );
    let tmpCreated = false;
    try {
      const existing = await readRegular(target, ABSOLUTE_WRITE_MAX_BYTES);

      if (input.expectedVersion === undefined) {
        if (existing)
          throw new FsWriteError(
            'already_exists',
            'File already exists; pass expectedVersion to replace it.',
          );
      } else {
        if (!existing)
          throw new FsWriteError(
            'not_found',
            'File does not exist; omit expectedVersion to create it.',
          );
        if (sha256Hex(existing.buf) !== input.expectedVersion) {
          throw new FsWriteError(
            'version_conflict',
            'The file changed since you read it. Re-read it and retry.',
          );
        }
      }

      const fh = await open(
        tmp,
        fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW,
        existing ? existing.mode : 0o644,
      );
      tmpCreated = true;
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }

      if (input.expectedVersion === undefined) {
        try {
          // Kernel-enforced create-only: fails if anything appeared at `target`.
          await link(tmp, target);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') throw new FsWriteError('already_exists', 'File already exists.');
          if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV' || code === 'ENOSYS') {
            throw new FsWriteError(
              'unsupported_filesystem',
              'Filesystem does not support atomic create.',
            );
          }
          throw new FsWriteError('io_error', 'Cannot create file.');
        }
      } else {
        // Last re-check right before rename (best effort; see header note).
        await resolveParents(input.rootPath, segments);
        const again = await readRegular(target, ABSOLUTE_WRITE_MAX_BYTES);
        if (
          !again ||
          again.ino !== existing!.ino ||
          again.mtimeMs !== existing!.mtimeMs ||
          again.size !== existing!.size ||
          sha256Hex(again.buf) !== input.expectedVersion
        ) {
          throw new FsWriteError(
            'version_conflict',
            'The file changed during the write. Re-read it and retry.',
          );
        }
        try {
          await rename(tmp, target);
          tmpCreated = false;
        } catch {
          throw new FsWriteError('io_error', 'Cannot replace file.');
        }
      }
      return {
        relPath: segments.join('/'),
        version: sha256Hex(data),
        bytes: data.length,
        created: input.expectedVersion === undefined,
      };
    } catch (err) {
      if (err instanceof FsWriteError) throw err;
      throw new FsWriteError('io_error', 'Write failed.');
    } finally {
      if (tmpCreated) await unlink(tmp).catch(() => {});
    }
  });
}
