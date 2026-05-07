// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';

/**
 * Raised by `safeResolveUnderRoot` when the requested relative path escapes
 * the configured root directory (e.g. via `..` traversal).
 */
export class PathEscapeError extends Error {
  constructor(rootPath: string, relPath: string) {
    super(`Path "${relPath}" escapes the configured root "${rootPath}"`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Compute the SHA-256 hash of a file by streaming its contents — avoids
 * loading the whole file into memory. Returns the hex digest.
 *
 * For very large files (multi-GB) the cost is dominated by I/O; this is
 * acceptable for Phase 1 because the result is cached on `RagDocument.hash`
 * and only recomputed when stat-based heuristics suggest the file changed.
 */
export function streamSha256(absolutePath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/**
 * Decide whether a relative path should be retained given optional
 * `includeGlobs` and `excludeGlobs`. An empty / undefined include list means
 * "include everything"; the exclude list is always evaluated.
 *
 * Globs use the `minimatch` syntax with `dot: true` so dotfiles are matched
 * by patterns like `**`. Path separators are normalized to forward slashes
 * so the same pattern works on Windows and POSIX.
 */
export function matchGlobs(
  relPath: string,
  includes?: string[],
  excludes?: string[],
): boolean {
  const normalized = relPath.split(sep).join('/');
  const opts = { dot: true } as const;

  if (excludes && excludes.length > 0) {
    for (const pattern of excludes) {
      if (minimatch(normalized, pattern, opts)) {
        return false;
      }
    }
  }

  if (!includes || includes.length === 0) {
    return true;
  }

  for (const pattern of includes) {
    if (minimatch(normalized, pattern, opts)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve `relPath` underneath `rootPath` and verify the resulting absolute
 * path is still inside `rootPath`. Guards against `..` traversal and absolute
 * paths sneaking in through `relPath`.
 *
 * @throws PathEscapeError when the resolved path escapes the root.
 */
export function safeResolveUnderRoot(rootPath: string, relPath: string): string {
  const root = resolve(rootPath);
  const candidate = resolve(root, relPath);
  // Append a separator to avoid `/foo` matching `/foobar` as a prefix.
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    throw new PathEscapeError(rootPath, relPath);
  }
  return candidate;
}

/**
 * Stable 16-hex-char id derived from `${sourceId}|${relPath}`. Deterministic
 * across processes so re-listing a source preserves entity identity.
 */
export function deterministicId(sourceId: string, relPath: string): string {
  const normalized = relPath.split(sep).join('/');
  return createHash('sha256')
    .update(`${sourceId}|${normalized}`)
    .digest('hex')
    .slice(0, 16);
}
