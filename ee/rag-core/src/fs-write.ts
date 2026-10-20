// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Safe create / replace of UTF-8 text files under a local-folder source root.
 *
 * Threat model: the caller (an MCP client holding a profile token) controls
 * `relPath` and `content`; the source root is admin-configured and trusted.
 * A LOCAL process able to rename/replace directories under the root while a
 * write is in flight is in scope for CONFINEMENT only (TOCTOU parent/ancestor
 * swap to a symlink): no step may act outside the directory objects reached
 * from the root. Integrity against a process running as the same UID (it can
 * rename/replace entries in the staging dir or the target folder) is OUT of
 * scope; such tampering is detected where possible and, after the publish
 * syscall, reported as `published_unverified` (never rolled back).
 *
 * Confinement (macOS, Linux):
 *  - Node's fs API only takes path strings, so a path validated by `lstat`
 *    can resolve differently by the time `open`/`rename` run. Every POSIX
 *    filesystem access therefore goes through the `calame-fsat` helper
 *    (native/fsat.c): it opens the root once, walks each component with
 *    `openat(O_DIRECTORY | O_NOFOLLOW)`, creates the temp file
 *    (`O_EXCL | O_NOFOLLOW`) in a staging dir held by fd, publishes it with a
 *    kernel create-only rename / exchange (`renameatx_np` RENAME_EXCL /
 *    RENAME_SWAP on macOS, `renameat2` RENAME_NOREPLACE / RENAME_EXCHANGE on
 *    Linux) and cleans up with single-component `unlinkat` relative to held
 *    fds. No path string is re-resolved between steps. A POSIX build without
 *    the helper fails closed (`unsupported_platform`).
 *  - An open directory fd does NOT lock the directory: it can still be renamed
 *    or have its entries swapped. The guarantee is that operations stay inside
 *    the directory objects reached from the root without following a symlink,
 *    not that the name -> directory mapping is frozen. The root path is
 *    trusted and resolved once; a symlink as its last component is refused.
 *
 * Windows (path-based, weaker): there is no directory-handle-relative API
 * reachable from Node, so reads and writes use path strings checked by an
 * `lstat` walk + `realpath` canonical check, re-resolved inside the lock and
 * right before publishing; the temp file is a sibling (`O_EXCL`), create uses
 * `link()` (kernel create-only), replace re-checks inode/size/mtime/content
 * then `rename`s. This shrinks but does NOT close the window in which a
 * concurrent local process swaps a parent folder for a link (honest limit,
 * documented in docs/rag-write-tool.md). Same behaviour as 0.8.3.
 *
 * Other guarantees (see docs/rag-write-tool.md):
 *  - `relPath` is a strict, relative, forward-slash path: no absolute / UNC /
 *    drive paths, `..`, backslashes, control chars, encoded separators, dot or
 *    hidden segments.
 *  - Symlinks are refused (parents, target); parents are NEVER created.
 *  - create -> RENAME_EXCL: kernel-enforced create-only (EEXIST).
 *  - replace -> compare-then-RENAME_SWAP, then the swapped-out entry must be
 *    the validated file (dev/ino) or the result is `published_unverified`. If
 *    the target is verified but the swap returned NO entry (exchange degraded
 *    to rename-over, seen on Docker Desktop virtiofs bind mounts), success
 *    requires a re-read of the target hashing to the content written. The
 *    content comparison cannot be atomic with the swap: this is not a
 *    multi-process CAS, an EXTERNAL writer can still change the file in that
 *    window (honest limit). In-process
 *    callers are serialized by a module-wide mutex, which only orders them; it
 *    does NOT confine paths.
 *  - Error messages never include absolute paths or content.
 */

import { constants as fsc, accessSync } from 'node:fs';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { posix, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  | 'unsupported_platform'
  /**
   * The publish syscall ran, but the post-publish identity check failed: the
   * target name may now point at something this module did not write (or the
   * replaced entry could not be identified). The write probably happened. Not
   * rolled back; re-read the file before retrying. A replace whose exchange
   * returned no old entry (virtiofs) is reported as success only when the
   * re-read target hashes to the content written.
   */
  | 'published_unverified'
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
// Path-based mode (Windows): lstat walk + canonical check
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
 * match the requested ones; only case may differ (case-insensitive volumes).
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

interface RegularFile {
  buf: Buffer;
  ino: number;
  dev: number;
  mtimeMs: number;
  size: number;
  mode: number;
}

async function readRegular(target: string, maxBytes: number): Promise<RegularFile | null> {
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
    return {
      buf,
      ino: fst.ino,
      dev: fst.dev,
      mtimeMs: fst.mtimeMs,
      size: fst.size,
      mode: fst.mode & 0o777,
    };
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
// calame-fsat helper (POSIX directory-fd anchored operations)
// ---------------------------------------------------------------------------

const HELPER_ERROR_CODES: ReadonlySet<string> = new Set<FsWriteErrorCode>([
  'invalid_path',
  'forbidden_path',
  'too_large',
  'root_unavailable',
  'parent_missing',
  'symlink_refused',
  'not_a_regular_file',
  'not_found',
  'already_exists',
  'version_conflict',
  'unsupported_filesystem',
  'published_unverified',
  'io_error',
]);

const PUBLISHED_UNVERIFIED_MESSAGE =
  'The write was probably published, but the result could not be verified. Re-read the file before retrying; do not repeat the write blindly.';

const HELPER_MESSAGES: Partial<Record<FsWriteErrorCode, string>> = {
  symlink_refused: 'Symbolic links are not allowed in the path.',
  parent_missing: 'A parent folder does not exist (it is never created).',
  invalid_path: 'A parent path component is not a folder.',
  root_unavailable: 'Source root is unavailable.',
  not_a_regular_file: 'Target is not a regular file.',
  too_large: 'Existing file exceeds the size limit.',
  already_exists: 'File already exists; pass expectedVersion to replace it.',
  not_found: 'File not found.',
  version_conflict: 'The file changed during the write. Re-read it and retry.',
  unsupported_filesystem: 'Filesystem does not support atomic create.',
  published_unverified: PUBLISHED_UNVERIFIED_MESSAGE,
};

/**
 * Helper-only status (replace): our temp file is verified at the target name,
 * but the exchange returned no old entry to the staging dir — it behaved like a
 * plain rename-over (observed on Docker Desktop macOS bind mounts, virtiofs).
 * writeTextFile re-reads the target and only reports success when it hashes to
 * the content just written; otherwise `published_unverified`.
 */
const DISPLACED_MISSING = 'published_displaced_missing';

class DisplacedMissingError extends FsWriteError {
  constructor() {
    super('published_unverified', PUBLISHED_UNVERIFIED_MESSAGE);
  }
}

let helperOverride: string | undefined;
let pathModeOverride = false;

/** Test seam: use the hook-enabled helper build. Pass undefined to reset. */
export function __setFsatHelperPathForTests(p: string | undefined): void {
  helperOverride = p;
}

/** Test seam: run the Windows path-based mode on any platform. */
export function __setPathModeForTests(on: boolean): void {
  pathModeOverride = on;
}

/** Windows (or the test seam): path-based mode instead of the helper. */
function usePathMode(): boolean {
  return pathModeOverride || process.platform === 'win32';
}

/** Throws `unsupported_platform` (before any disk access) when the helper is missing. */
function helperPath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = helperOverride
    ? [helperOverride]
    : [
        // dist/fs-write.js  → dist/native/calame-fsat
        resolvePath(here, 'native', 'calame-fsat'),
        // vitest running src/fs-write.ts against a built tree
        resolvePath(here, '..', 'dist', 'native', 'calame-fsat'),
      ];
  for (const c of candidates) {
    try {
      accessSync(c, 1 /* X_OK */);
      return c;
    } catch {
      /* try next */
    }
  }
  throw new FsWriteError(
    'unsupported_platform',
    'The file-confinement helper is not built; refusing to fall back to unsafe path-based writes.',
  );
}

/** Runs the helper; resolves with everything after the "OK" line's status text. */
function runHelper(args: string[], stdin: Buffer | undefined): Promise<Buffer> {
  const bin = helperPath();
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      bin,
      args,
    ) as ChildProcessWithoutNullStreams;
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(() => reject(new FsWriteError('io_error', 'File helper timed out.')));
    }, 60_000);
    function done(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stdin.on('error', () => {
      /* helper exited early; its stdout says why */
    });
    (child as unknown as EventEmitter).on('error', () =>
      done(() => reject(new FsWriteError('io_error', 'Cannot run the file helper.'))),
    );
    (child as unknown as EventEmitter).on('close', () => {
      const out = Buffer.concat(chunks);
      const nl = out.indexOf(0x0a);
      const first = (nl < 0 ? out : out.subarray(0, nl)).toString('utf8');
      if (first.startsWith('ERR ')) {
        const raw = first.slice(4).trim();
        if (raw === DISPLACED_MISSING) return done(() => reject(new DisplacedMissingError()));
        const code: FsWriteErrorCode = HELPER_ERROR_CODES.has(raw)
          ? (raw as FsWriteErrorCode)
          : 'io_error';
        return done(() =>
          reject(new FsWriteError(code, HELPER_MESSAGES[code] ?? 'File operation failed.')),
        );
      }
      if (!first.startsWith('OK') || nl < 0) {
        return done(() => reject(new FsWriteError('io_error', 'File helper failed.')));
      }
      done(() => resolve(out));
    });
    child.stdin.end(stdin);
  });
}

/** Reads the target through the helper. Resolves null when it does not exist. */
async function helperRead(
  rootPath: string,
  segments: string[],
  maxBytes: number,
): Promise<Buffer | null> {
  const out = await runHelper(['read', rootPath, String(maxBytes), '--', ...segments], undefined);
  const nl = out.indexOf(0x0a);
  const size = Number(out.subarray(0, nl).toString('utf8').slice(2).trim());
  if (size === -1) return null;
  const data = out.subarray(nl + 1);
  if (!Number.isInteger(size) || data.length !== size) {
    throw new FsWriteError('io_error', 'Cannot read target file.');
  }
  return data;
}

// ---------------------------------------------------------------------------
// In-process serialization (ordering only — NOT confinement)
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
  let buf: Buffer | null;
  if (usePathMode()) {
    const { target } = await resolveParents(input.rootPath, segments);
    buf = (await readRegular(target, maxBytes))?.buf ?? null;
  } else {
    buf = await helperRead(input.rootPath, segments, maxBytes);
  }
  if (!buf) throw new FsWriteError('not_found', 'File not found.');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new FsWriteError('invalid_content', 'File is not valid UTF-8 text.');
  }
  return {
    relPath: segments.join('/'),
    content,
    version: sha256Hex(buf),
    bytes: buf.length,
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
  if (usePathMode()) return writeTextFilePathMode(input, segments, data);
  helperPath(); // fail closed (helper missing) before anything else

  // The mutex orders in-process callers (case aliases, overlapping roots). It
  // is NOT what confines paths: the helper's fd-relative walk is.
  return withLock('document-write', async () => {
    const name = segments[segments.length - 1] as string;
    const tmp = `.calame-tmp-${randomBytes(8).toString('hex')}-${name}`.slice(0, 200);
    try {
      if (input.expectedVersion === undefined) {
        await runHelper(
          ['create', input.rootPath, String(data.length), tmp, '--', ...segments],
          data,
        );
      } else {
        const old = await helperRead(input.rootPath, segments, ABSOLUTE_WRITE_MAX_BYTES);
        if (!old) {
          throw new FsWriteError(
            'not_found',
            'File does not exist; omit expectedVersion to create it.',
          );
        }
        if (sha256Hex(old) !== input.expectedVersion) {
          throw new FsWriteError(
            'version_conflict',
            'The file changed since you read it. Re-read it and retry.',
          );
        }
        // The helper re-verifies `old` against the file before creating the
        // temp file and again right before renameat.
        try {
          await runHelper(
            [
              'replace',
              input.rootPath,
              String(data.length),
              String(old.length),
              tmp,
              '--',
              ...segments,
            ],
            Buffer.concat([data, old]),
          );
        } catch (err) {
          if (!(err instanceof DisplacedMissingError)) throw err;
          await confirmPublished(input.rootPath, segments, data);
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
    }
  });
}

/**
 * After `published_displaced_missing`: re-reads the target through the helper
 * (same fd-anchored, no-symlink walk) and returns only if it hashes exactly to
 * the content just written. Anything else, including a failed re-read, stays
 * `published_unverified`.
 */
async function confirmPublished(rootPath: string, segments: string[], data: Buffer): Promise<void> {
  let now: Buffer | null = null;
  try {
    now = await helperRead(rootPath, segments, ABSOLUTE_WRITE_MAX_BYTES);
  } catch {
    /* unverifiable */
  }
  if (!now || sha256Hex(now) !== sha256Hex(data)) {
    throw new FsWriteError('published_unverified', PUBLISHED_UNVERIFIED_MESSAGE);
  }
}

/**
 * Windows path-based write (see the header): same checks and atomic publish
 * as 0.8.3, confinement by lstat walk + canonical check, re-resolved inside
 * the lock and right before publishing.
 */
async function writeTextFilePathMode(
  input: WriteTextFileInput,
  segments: string[],
  data: Buffer,
): Promise<WriteTextFileResult> {
  await resolveParents(input.rootPath, segments);
  return withLock('document-write', async () => {
    const { dir, target, name } = await resolveParents(input.rootPath, segments);
    const tmp = posix.join(
      dir,
      `.calame-tmp-${randomBytes(8).toString('hex')}-${name}`.slice(0, 200),
    );
    let tmpCreated = false;
    try {
      const existing = await readRegular(target, ABSOLUTE_WRITE_MAX_BYTES);
      if (input.expectedVersion === undefined) {
        if (existing) {
          throw new FsWriteError(
            'already_exists',
            'File already exists; pass expectedVersion to replace it.',
          );
        }
      } else {
        if (!existing) {
          throw new FsWriteError(
            'not_found',
            'File does not exist; omit expectedVersion to create it.',
          );
        }
        if (sha256Hex(existing.buf) !== input.expectedVersion) {
          throw new FsWriteError(
            'version_conflict',
            'The file changed since you read it. Re-read it and retry.',
          );
        }
      }

      const fh = await open(
        tmp,
        fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0),
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
        // Re-check the parents right before publishing (best effort).
        await resolveParents(input.rootPath, segments);
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
        // Last re-check right before rename (best effort; see the header).
        await resolveParents(input.rootPath, segments);
        const again = await readRegular(target, ABSOLUTE_WRITE_MAX_BYTES);
        if (
          !again ||
          again.ino !== existing!.ino ||
          again.dev !== existing!.dev ||
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
