/**
 * Resolve the absolute directory containing the bundled local embedding
 * model (EmbeddingGemma-300M — see `local-embedding-meta.ts`), mirroring
 * `../tunnel/cloudflared-resolve.ts`'s packaged-vs-dev split. Two differences
 * from that module: this resolves a DIRECTORY (validated by the presence of
 * `<modelFolderName>/config.json` inside it, matching the check
 * `LocalOnnxEmbeddingClient.load()` itself does) rather than a single binary
 * file, and dev-mode caching is per-revision (see
 * `scripts/fetch-embedding-model.mjs`'s `HF_REVISION` pin) so that branch
 * globs for whichever revision happens to be cached rather than assuming a
 * fixed path.
 *
 * Resolution order:
 *   1. `overridePath` (wired from `AppConfig.localEmbeddingModelDir` /
 *      `CALAME_LOCAL_EMBEDDING_MODEL_DIR`) — wins unconditionally when set
 *      AND valid (contains the expected model folder).
 *   2. Packaged mode (Tauri sidecar): `models/` next to the bundled
 *      `server.mjs` (staged by `scripts/bundle-server.mjs` step 5b into
 *      `dist-bundle/models/`, mirrored by `prepare-desktop.mjs` into
 *      `resources/server/models/`). Packaged mode ships exactly one
 *      revision, so no globbing is needed here.
 *   3. Dev mode (monorepo, `pnpm dev` / tests): `node_modules/.cache/
 *      calame-desktop/models/<revision>/`, staged there by
 *      `scripts/fetch-embedding-model.mjs`. Globs for a subdirectory
 *      containing a valid model folder rather than hardcoding the pinned
 *      revision, so this module doesn't need to import that build script.
 *
 * Deliberately does NOT auto-download at runtime — a missing model in dev
 * mode is reported via `unavailableReason` instead, pointing at
 * `pnpm model:fetch`.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LOCAL_EMBEDDING_MODEL_FOLDER } from './local-embedding-meta.js';

export interface ResolveLocalModelDirOptions {
  /**
   * Override wired from `AppConfig.localEmbeddingModelDir`
   * (`CALAME_LOCAL_EMBEDDING_MODEL_DIR`). Wins over every other strategy
   * below, but is validated to actually contain the model — an env var
   * pointing at a stale/wrong path must not silently report "available".
   */
  overridePath?: string | null;
  /** Whether the server is running in packaged desktop mode. */
  packaged: boolean;
  /**
   * Override for the packaged-mode base directory (the directory `models/`
   * is expected to sit in, alongside the bundled `server.mjs`). Defaults to
   * this module's own directory at runtime — override only in tests.
   */
  packagedBaseDir?: string;
  /**
   * Override for the dev-mode cache directory. Defaults to
   * `node_modules/.cache/calame-desktop` at the repo root — override only in
   * tests, so they don't depend on a real cached download existing.
   */
  devCacheDir?: string;
  /** Model folder name to look for. Defaults to LOCAL_EMBEDDING_MODEL_FOLDER — override only in tests. */
  modelFolderName?: string;
  /** Defaults to `process.platform`. Override for tests — affects path-separator joining only (no OS-specific filenames here). */
  platform?: NodeJS.Platform;
  /** Defaults to `fs.existsSync`. Override for tests. */
  existsFn?: (candidate: string) => boolean;
  /** Defaults to `fs.readdirSync`. Override for tests — used only for the dev-mode revision glob. */
  readdirFn?: (dir: string) => string[];
}

export interface LocalModelDirResolution {
  /** Absolute path to the MODELS ROOT directory (i.e. `<path>/<modelFolderName>/config.json` exists), or `null`. */
  path: string | null;
  /** True iff `path` is non-null. */
  available: boolean;
  /** Human-readable reason `path` is null. Always `null` when `available` is true. */
  unavailableReason: string | null;
}

// packages/cli/src/rag/local-model-resolve.ts -> repo root is 4 levels up
// (rag -> src -> cli -> packages -> <root>). Only used in dev mode.
const DEFAULT_DEV_CACHE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'node_modules/.cache/calame-desktop',
);

function found(candidate: string): LocalModelDirResolution {
  return { path: candidate, available: true, unavailableReason: null };
}

function notFound(reason: string): LocalModelDirResolution {
  return { path: null, available: false, unavailableReason: reason };
}

function hasModel(
  modelsRoot: string,
  modelFolderName: string,
  existsFn: (candidate: string) => boolean,
  joiner: path.PlatformPath,
): boolean {
  return existsFn(joiner.join(modelsRoot, modelFolderName, 'config.json'));
}

export function resolveLocalModelDir(opts: ResolveLocalModelDirOptions): LocalModelDirResolution {
  const platform = opts.platform ?? process.platform;
  const existsFn = opts.existsFn ?? fs.existsSync;
  const readdirFn = opts.readdirFn ?? ((dir: string) => fs.readdirSync(dir));
  const modelFolderName = opts.modelFolderName ?? LOCAL_EMBEDDING_MODEL_FOLDER;
  const joiner = platform === 'win32' ? path.win32 : path.posix;

  if (opts.overridePath) {
    if (hasModel(opts.overridePath, modelFolderName, existsFn, joiner)) return found(opts.overridePath);
    return notFound(
      `CALAME_LOCAL_EMBEDDING_MODEL_DIR is set to "${opts.overridePath}", but ` +
        `"${modelFolderName}/config.json" was not found there.`,
    );
  }

  if (opts.packaged) {
    const baseDir = opts.packagedBaseDir ?? path.dirname(fileURLToPath(import.meta.url));
    const candidate = joiner.join(baseDir, 'models');
    if (hasModel(candidate, modelFolderName, existsFn, joiner)) return found(candidate);
    return notFound(
      `Local embedding model not found next to the bundled server (looked for ` +
        `"${joiner.join(candidate, modelFolderName, 'config.json')}").`,
    );
  }

  const cacheDir = opts.devCacheDir ?? DEFAULT_DEV_CACHE_DIR;
  const modelsParent = joiner.join(cacheDir, 'models');
  let revisions: string[];
  try {
    revisions = readdirFn(modelsParent);
  } catch {
    revisions = [];
  }
  for (const revision of revisions) {
    const candidate = joiner.join(modelsParent, revision);
    if (hasModel(candidate, modelFolderName, existsFn, joiner)) return found(candidate);
  }
  return notFound(
    `Local embedding model not found under "${modelsParent}" (looked for any <revision>/` +
      `${modelFolderName}/config.json). Run "pnpm model:fetch" to download it, or set ` +
      `CALAME_LOCAL_EMBEDDING_MODEL_DIR to an existing model install.`,
  );
}
