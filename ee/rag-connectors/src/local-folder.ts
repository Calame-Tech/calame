// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { constants as fsConstants, createReadStream } from 'node:fs';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import mime from 'mime-types';

import type { RagDocument, RagFolder, RagSourceType } from '@calame-ee/rag-core';

import type { DocumentSourceConfig, DocumentSourceConnector } from './types.js';
import {
  deterministicId,
  matchGlobs,
  safeResolveUnderRoot,
  streamSha256,
} from './utils.js';

/**
 * Configuration for `LocalFolderConnector`. Stored encrypted by the host.
 */
export interface LocalFolderConfig {
  /** Absolute path on disk. The admin is trusted; any directory is accepted. */
  rootPath: string;
  /** Optional include allowlist. Defaults to "include everything". */
  includeGlobs?: string[];
  /** Optional exclude denylist (e.g. `['**\/node_modules\/**', '**\/.git\/**']`). */
  excludeGlobs?: string[];
  /** Whether to follow symbolic links during traversal. Default `false`. */
  followSymlinks?: boolean;
}

/**
 * Narrow the opaque `DocumentSourceConfig` to the shape this connector
 * understands. Throws a clear error if the config is malformed — the host is
 * expected to have validated the config at its API boundary, but we still
 * defend in depth here.
 */
function narrowConfig(config: DocumentSourceConfig): LocalFolderConfig {
  const rootPath = config.rootPath;
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new Error('LocalFolderConnector requires a non-empty `rootPath` string in config');
  }
  const includeGlobs = config.includeGlobs;
  const excludeGlobs = config.excludeGlobs;
  if (includeGlobs !== undefined && !Array.isArray(includeGlobs)) {
    throw new Error('LocalFolderConnector: `includeGlobs` must be an array of strings');
  }
  if (excludeGlobs !== undefined && !Array.isArray(excludeGlobs)) {
    throw new Error('LocalFolderConnector: `excludeGlobs` must be an array of strings');
  }
  return {
    rootPath,
    includeGlobs: includeGlobs as string[] | undefined,
    excludeGlobs: excludeGlobs as string[] | undefined,
    followSymlinks: config.followSymlinks === true,
  };
}

/**
 * Raised by `fetchDocument` when the supplied `docId` cannot be resolved to a
 * real path. Phase 1 limitation: ids are encoded as `path:<relPath>`, so the
 * caller should always have a valid id straight from `listDocuments`.
 */
export class DocumentNotFoundError extends Error {
  constructor(docId: string) {
    super(`Document "${docId}" not found in local folder source`);
    this.name = 'DocumentNotFoundError';
  }
}

const DOC_ID_PREFIX = 'path:';

/**
 * Encode a relative path into a stable, opaque-looking document id. We keep
 * the path inside the id so `fetchDocument` can be stateless across processes
 * (no in-memory cache required between `listDocuments` and `fetchDocument`).
 *
 * Other connectors (S3, GDrive, …) will use opaque random ids; this scheme is
 * specific to the local connector and documented on the class.
 */
function encodeDocId(relPath: string): string {
  const normalized = relPath.split(sep).join('/');
  return `${DOC_ID_PREFIX}${Buffer.from(normalized, 'utf8').toString('base64url')}`;
}

function decodeDocId(docId: string): string {
  if (!docId.startsWith(DOC_ID_PREFIX)) {
    throw new DocumentNotFoundError(docId);
  }
  const encoded = docId.slice(DOC_ID_PREFIX.length);
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw new DocumentNotFoundError(docId);
  }
}

/**
 * Connector for a local filesystem directory tree.
 *
 * Phase 1 capabilities:
 *  - `testConnection` validates that `rootPath` exists, is a directory, and is
 *    readable.
 *  - `listFolders` / `listDocuments` walk **only the direct children** of the
 *    requested folder; recursion is the caller's job (via repeated calls).
 *  - `fetchDocument` opens a `fs.createReadStream` on the resolved path with
 *    a strict guard against `..` escapes (`safeResolveUnderRoot`).
 *  - Document hashes are computed by streaming the file through SHA-256 — no
 *    full-file buffering. For multi-GB files this is still I/O bound; we
 *    accept this cost in Phase 1 because the host caches `RagDocument.hash`
 *    and only re-hashes when stat-based heuristics indicate a change.
 *
 * Deferred to later phases:
 *  - `watch()` (chokidar-based incremental sync) → Phase 4.
 *  - Symlink semantics beyond "follow or skip" → Phase 4.
 */
export class LocalFolderConnector implements DocumentSourceConnector {
  readonly type: RagSourceType = 'local';

  async testConnection(rawConfig: DocumentSourceConfig): Promise<void> {
    const config = narrowConfig(rawConfig);
    const root = resolve(config.rootPath);
    let stats;
    try {
      stats = await stat(root);
    } catch (err: unknown) {
      // Auto-create when the path is missing AND its parent exists. The
      // parent-must-exist check is a guardrail against typos in the rootPath
      // (e.g. "C:\\Usres\\..." with a typo) — we don't want to silently create
      // unrelated directories. If the parent doesn't exist either, surface a
      // clear error so the admin can fix the typo.
      const isMissing =
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isMissing) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`Root path "${root}" is not accessible: ${cause}`);
      }
      const parent = dirname(root);
      try {
        const parentStat = await stat(parent);
        if (!parentStat.isDirectory()) {
          throw new Error(`Parent "${parent}" of root path is not a directory`);
        }
      } catch {
        throw new Error(
          `Root path "${root}" does not exist and its parent "${parent}" is missing or unreadable. ` +
            `Check the path for typos before retrying.`,
        );
      }
      await mkdir(root, { recursive: false });
      stats = await stat(root);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Root path "${root}" is not a directory`);
    }
    try {
      await access(root, fsConstants.R_OK);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`Root path "${root}" is not readable: ${cause}`);
    }
  }

  async listFolders(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    parent?: RagFolder,
  ): Promise<RagFolder[]> {
    const config = narrowConfig(rawConfig);
    const root = resolve(config.rootPath);
    const targetAbs = parent ? safeResolveUnderRoot(root, parent.path) : root;
    const entries = await readdir(targetAbs, { withFileTypes: true });

    const folders: RagFolder[] = [];
    for (const entry of entries) {
      if (!this.#isDirectoryEntry(entry, config)) continue;

      const childAbs = resolve(targetAbs, entry.name);
      const relPath = relative(root, childAbs);
      // Normalize to forward slashes for storage / glob matching.
      const normalizedRel = relPath.split(sep).join('/');

      if (!matchGlobs(normalizedRel, undefined, config.excludeGlobs)) {
        continue;
      }

      let createdAt = '';
      try {
        const childStats = await stat(childAbs);
        createdAt = childStats.mtime.toISOString();
      } catch {
        // If stat fails (race with deletion / permissions), skip the entry.
        continue;
      }

      folders.push({
        id: deterministicId(sourceId, normalizedRel),
        sourceId,
        parentId: parent?.id ?? null,
        path: normalizedRel,
        name: basename(childAbs),
        createdAt,
      });
    }
    return folders;
  }

  async listDocuments(
    rawConfig: DocumentSourceConfig,
    sourceId: string,
    folder?: RagFolder,
  ): Promise<RagDocument[]> {
    const config = narrowConfig(rawConfig);
    const root = resolve(config.rootPath);
    const targetAbs = folder ? safeResolveUnderRoot(root, folder.path) : root;
    const entries = await readdir(targetAbs, { withFileTypes: true });

    const documents: RagDocument[] = [];
    for (const entry of entries) {
      if (!this.#isFileEntry(entry, config)) continue;

      const fileAbs = resolve(targetAbs, entry.name);
      const relPath = relative(root, fileAbs);
      const normalizedRel = relPath.split(sep).join('/');

      if (!matchGlobs(normalizedRel, config.includeGlobs, config.excludeGlobs)) {
        continue;
      }

      let size = 0;
      try {
        const fileStats = await stat(fileAbs);
        size = fileStats.size;
      } catch {
        continue;
      }

      const hash = await streamSha256(fileAbs);
      const lookup = mime.lookup(entry.name);
      const mimeType = typeof lookup === 'string' ? lookup : 'application/octet-stream';

      documents.push({
        id: encodeDocId(normalizedRel),
        sourceId,
        folderId: folder?.id ?? null,
        path: normalizedRel,
        name: entry.name,
        mimeType,
        size,
        hash,
        etag: null,
        // Caller (host pipeline) overwrites this when the document is indexed.
        lastIndexedAt: '',
        deletedAt: null,
      });
    }
    return documents;
  }

  async fetchDocument(
    rawConfig: DocumentSourceConfig,
    _sourceId: string,
    docId: string,
  ): Promise<{ stream: Readable; mimeType: string }> {
    const config = narrowConfig(rawConfig);
    const relPath = decodeDocId(docId);
    const root = resolve(config.rootPath);
    const fileAbs = safeResolveUnderRoot(root, relPath);

    let stats;
    try {
      stats = await stat(fileAbs);
    } catch {
      throw new DocumentNotFoundError(docId);
    }
    if (!stats.isFile()) {
      throw new DocumentNotFoundError(docId);
    }

    const lookup = mime.lookup(fileAbs);
    const mimeType = typeof lookup === 'string' ? lookup : 'application/octet-stream';
    const stream = createReadStream(fileAbs);
    return { stream, mimeType };
  }

  // -- helpers --------------------------------------------------------------

  #isDirectoryEntry(
    entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
    config: LocalFolderConfig,
  ): boolean {
    if (entry.isDirectory()) return true;
    if (config.followSymlinks && entry.isSymbolicLink()) {
      // Symlink type is resolved later via `stat` when we read children.
      return true;
    }
    return false;
  }

  #isFileEntry(
    entry: { isFile(): boolean; isSymbolicLink(): boolean },
    config: LocalFolderConfig,
  ): boolean {
    if (entry.isFile()) return true;
    if (config.followSymlinks && entry.isSymbolicLink()) {
      return true;
    }
    return false;
  }
}
