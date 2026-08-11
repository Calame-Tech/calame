#!/usr/bin/env node
/**
 * Stage the sidecar runtime + server resources that the Tauri desktop app
 * (apps/desktop) bundles into its installer.
 *
 * Output (both gitignored — build artifacts, not source):
 *   apps/desktop/src-tauri/binaries/node-<target-triple>[.exe]
 *     — a portable Node runtime, named per Tauri's sidecar convention
 *       (basename "node" + the Rust target triple of the host).
 *   apps/desktop/src-tauri/resources/server/
 *     — a full copy of dist-bundle/ (server.mjs, node_modules/, web/, README.md),
 *       plus cloudflared[.exe] (the "Expose for Copilot / ChatGPT" tunnel
 *       binary — see packages/cli/src/tunnel/*).
 *   node_modules/.cache/calame-desktop/cloudflared[.exe]
 *     — same cloudflared binary, at the fixed name
 *       `tunnel/cloudflared-resolve.ts` looks for in DEV mode (no Tauri
 *       packaging involved), so `pnpm dev` can exercise the tunnel feature too.
 *
 * Usage: pnpm desktop:prepare   (or: node scripts/prepare-desktop.mjs [--fresh])
 *   --fresh   force a `pnpm bundle` rebuild even if dist-bundle/server.mjs exists.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DIST_BUNDLE_DIR = path.join(REPO_ROOT, 'dist-bundle');
const DIST_BUNDLE_SERVER = path.join(DIST_BUNDLE_DIR, 'server.mjs');

const SRC_TAURI_DIR = path.join(REPO_ROOT, 'apps/desktop/src-tauri');
const BINARIES_DIR = path.join(SRC_TAURI_DIR, 'binaries');
const RESOURCES_SERVER_DIR = path.join(SRC_TAURI_DIR, 'resources/server');

const CACHE_DIR = path.join(REPO_ROOT, 'node_modules/.cache/calame-desktop');

// Node archives below ~10MB are almost certainly a truncated/failed download
// rather than a real runtime — used both to validate a cache hit and to
// sanity-check a freshly downloaded file before trusting it.
const MIN_VALID_ARCHIVE_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pinned Node runtime version
// ---------------------------------------------------------------------------
//
// WHY THIS EXACT VERSION: dist-bundle/node_modules ships prebuilt native
// addons (better-sqlite3's better_sqlite3.node, sqlite-vec's vec0.dll) that
// were compiled for — and can only be loaded by — the Node ABI
// (NODE_MODULE_VERSION) of whatever Node ran `pnpm bundle`. That is the dev
// machine's installed Node, currently v22.18.0 (ABI 127). The sidecar Node
// runtime staged here MUST be that exact same version, or better-sqlite3 /
// sqlite-vec will throw a NODE_MODULE_VERSION mismatch the instant the
// packaged server tries to require() them — i.e. the app fails to boot.
//
// If the dev/CI machine's Node version ever changes, re-run `pnpm bundle` on
// the new version FIRST (so the native addons are rebuilt/refetched against
// the new ABI), then update this constant to match.
const NODE_VERSION = '22.18.0';

/**
 * Per-target-triple archive layout, keyed by the Rust target triple Tauri
 * uses to name sidecar binaries. Only the host's own triple is ever resolved
 * at runtime (see getCurrentTarget()); the other entries are inert data,
 * ready for whenever this script grows macOS/Linux support — they just need
 * an extractArchive() implementation for their archiveType (tar.gz/tar.xz;
 * zip is already implemented).
 */
const NODE_DIST_TARGETS = {
  'x86_64-pc-windows-msvc': {
    nodeDist: 'win-x64',
    archiveType: 'zip',
    archiveExt: '.zip',
    // Path of the node executable inside the extracted archive.
    binaryInArchive: (dist) => `node-v${NODE_VERSION}-${dist}/node.exe`,
    sidecarBinaryName: 'node-x86_64-pc-windows-msvc.exe',
  },
  'x86_64-apple-darwin': {
    nodeDist: 'darwin-x64',
    archiveType: 'tar.gz',
    archiveExt: '.tar.gz',
    binaryInArchive: (dist) => `node-v${NODE_VERSION}-${dist}/bin/node`,
    sidecarBinaryName: 'node-x86_64-apple-darwin',
  },
  'aarch64-apple-darwin': {
    nodeDist: 'darwin-arm64',
    archiveType: 'tar.gz',
    archiveExt: '.tar.gz',
    binaryInArchive: (dist) => `node-v${NODE_VERSION}-${dist}/bin/node`,
    sidecarBinaryName: 'node-aarch64-apple-darwin',
  },
  'x86_64-unknown-linux-gnu': {
    nodeDist: 'linux-x64',
    archiveType: 'tar.xz',
    archiveExt: '.tar.xz',
    binaryInArchive: (dist) => `node-v${NODE_VERSION}-${dist}/bin/node`,
    sidecarBinaryName: 'node-x86_64-unknown-linux-gnu',
  },
};

function archiveUrl(target) {
  return `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${target.nodeDist}${target.archiveExt}`;
}

// ---------------------------------------------------------------------------
// Pinned cloudflared version — powers the "Expose for Copilot / ChatGPT"
// tunnel feature (packages/cli/src/tunnel/*).
// ---------------------------------------------------------------------------
//
// Latest stable tag on https://github.com/cloudflare/cloudflared/releases at
// the time this was pinned (checked via the GitHub releases API). cloudflared
// has no ABI/native-addon coupling to our Node version (unlike NODE_VERSION
// above) — it's a fully standalone Go binary — so bumping this later is just
// a version string change, no rebuild of anything else required.
const CLOUDFLARED_VERSION = '2026.7.3';

const CLOUDFLARED_RELEASES_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

/**
 * Per-target-triple release asset, keyed by the same Rust target triples as
 * NODE_DIST_TARGETS. Only 'x86_64-pc-windows-msvc' is wired up end-to-end
 * today (a direct single-file .exe download, no extraction needed); the
 * darwin/linux entries are inert data for whoever adds them next:
 *   - darwin targets ship a .tgz (tar.gz) archive with `cloudflared` at its
 *     root — needs tar.gz extraction (kind 'tar.gz', not implemented).
 *   - the linux target is a direct executable like Windows (kind 'exe'), but
 *     needs a post-download `chmod +x` this script doesn't do yet.
 */
const CLOUDFLARED_DIST_TARGETS = {
  'x86_64-pc-windows-msvc': {
    assetName: 'cloudflared-windows-amd64.exe',
    kind: 'exe',
  },
  'x86_64-apple-darwin': {
    assetName: 'cloudflared-darwin-amd64.tgz',
    kind: 'tar.gz',
  },
  'aarch64-apple-darwin': {
    assetName: 'cloudflared-darwin-arm64.tgz',
    kind: 'tar.gz',
  },
  'x86_64-unknown-linux-gnu': {
    assetName: 'cloudflared-linux-amd64',
    kind: 'exe',
  },
};

function cloudflaredAssetUrl(assetName) {
  return `${CLOUDFLARED_RELEASES_BASE}/${assetName}`;
}

/** Fixed binary name `tunnel/cloudflared-resolve.ts` looks for — see its module docstring. */
function cloudflaredBinaryName(triple) {
  return triple.includes('windows') ? 'cloudflared.exe' : 'cloudflared';
}

/**
 * Map the running host's platform/arch to a Rust target triple key into
 * NODE_DIST_TARGETS. Only win32/x64 is wired up end-to-end today (zip
 * extraction is implemented); the darwin/linux entries above already carry
 * the right URLs/paths for whoever adds tar.gz/tar.xz support to
 * extractArchive() next.
 */
function getCurrentTarget() {
  let triple;
  if (process.platform === 'win32' && process.arch === 'x64') {
    triple = 'x86_64-pc-windows-msvc';
  } else if (process.platform === 'darwin' && process.arch === 'arm64') {
    triple = 'aarch64-apple-darwin';
  } else if (process.platform === 'darwin' && process.arch === 'x64') {
    triple = 'x86_64-apple-darwin';
  } else if (process.platform === 'linux' && process.arch === 'x64') {
    triple = 'x86_64-unknown-linux-gnu';
  } else {
    throw new Error(
      `Unsupported host platform/arch for desktop packaging: ${process.platform}/${process.arch}. ` +
        `Add an entry to NODE_DIST_TARGETS first.`,
    );
  }

  const target = NODE_DIST_TARGETS[triple];
  if (target.archiveType !== 'zip') {
    // Guard against silently shipping a broken sidecar: the data for this
    // target is declared above, but extractArchive() only knows "zip" so far.
    throw new Error(
      `Target "${triple}" needs archiveType "${target.archiveType}" extraction, which ` +
        `extractArchive() does not implement yet (only "zip" is). Add it there first.`,
    );
  }
  return { triple, ...target };
}

function log(msg) {
  console.log(msg);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function isValidCachedFile(filePath, minBytes) {
  try {
    return fs.statSync(filePath).size > minBytes;
  } catch {
    return false;
  }
}

/**
 * Download `url` to `destPath`, streaming to a `.download` temp file first
 * and renaming on success — so a failed/interrupted run never leaves behind
 * a corrupt file at the path idempotency checks look at.
 */
async function downloadFile(url, destPath) {
  const tmpPath = `${destPath}.download`;
  log(`  Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText} (${url})`);
  }
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpPath));
  fs.renameSync(tmpPath, destPath);
}

/**
 * Extract `archivePath` into `destDir` (wiped first). Only "zip" is
 * implemented, via PowerShell's Expand-Archive — acceptable on win32 per
 * this script's own platform gate, and avoids adding a zip-parsing
 * dependency for a build script that only runs on developer/CI machines.
 */
function extractArchive(archivePath, destDir, archiveType) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  if (archiveType === 'zip') {
    execSync(
      `powershell -NoProfile -NonInteractive -Command ` +
        `"Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force"`,
      { stdio: 'inherit' },
    );
    return;
  }
  throw new Error(
    `extractArchive: archiveType "${archiveType}" is not implemented yet (only "zip" is).`,
  );
}

/**
 * Ensure the pinned Node runtime for `target` is downloaded and extracted
 * into the cache dir, reusing whatever is already there. Returns the
 * absolute path to the extracted node executable.
 */
async function ensureNodeRuntime(target) {
  const archivePath = path.join(
    CACHE_DIR,
    `node-v${NODE_VERSION}-${target.nodeDist}${target.archiveExt}`,
  );
  const extractDir = path.join(CACHE_DIR, `extracted-v${NODE_VERSION}-${target.nodeDist}`);
  const extractedBinary = path.join(extractDir, target.binaryInArchive(target.nodeDist));

  if (isValidCachedFile(extractedBinary, 0)) {
    log(`  Cache hit: already extracted at ${extractedBinary}`);
    return extractedBinary;
  }

  if (isValidCachedFile(archivePath, MIN_VALID_ARCHIVE_BYTES)) {
    log(`  Cache hit: archive already downloaded at ${archivePath}`);
  } else {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    await downloadFile(archiveUrl(target), archivePath);
    if (!isValidCachedFile(archivePath, MIN_VALID_ARCHIVE_BYTES)) {
      throw new Error(
        `Downloaded archive ${archivePath} is suspiciously small — download likely failed.`,
      );
    }
  }

  log(`  Extracting ${path.basename(archivePath)}...`);
  extractArchive(archivePath, extractDir, target.archiveType);

  if (!fs.existsSync(extractedBinary)) {
    throw new Error(`Expected node binary not found after extraction: ${extractedBinary}`);
  }
  return extractedBinary;
}

/**
 * Ensure the pinned cloudflared binary for `target.triple` (a
 * NODE_DIST_TARGETS entry, reused so platform/arch detection isn't
 * duplicated) is downloaded into the cache dir, reusing it if already
 * present. Returns the absolute path to the downloaded binary.
 *
 * Only 'exe' (direct single-file executable, no archive) is implemented —
 * matches the one target this script's platform gate (win32/x64) can ever
 * hit today. See CLOUDFLARED_DIST_TARGETS for the darwin/'tar.gz' TODO.
 */
async function ensureCloudflaredBinary(target) {
  const cloudflaredTarget = CLOUDFLARED_DIST_TARGETS[target.triple];
  if (!cloudflaredTarget) {
    throw new Error(
      `No cloudflared release asset mapped for target triple "${target.triple}". ` +
        `Add an entry to CLOUDFLARED_DIST_TARGETS first.`,
    );
  }
  if (cloudflaredTarget.kind !== 'exe') {
    throw new Error(
      `cloudflared target "${target.triple}" needs kind "${cloudflaredTarget.kind}" handling, ` +
        `which is not implemented yet (only "exe" direct-binary download is). Add it first.`,
    );
  }

  // Versioned cache filename (mirrors the Node archive caching above) so
  // bumping CLOUDFLARED_VERSION later re-downloads automatically instead of
  // silently reusing a stale binary.
  const versionedPath = path.join(
    CACHE_DIR,
    `cloudflared-v${CLOUDFLARED_VERSION}-${cloudflaredTarget.assetName}`,
  );

  if (isValidCachedFile(versionedPath, MIN_VALID_ARCHIVE_BYTES)) {
    log(`  Cache hit: cloudflared already downloaded at ${versionedPath}`);
  } else {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    await downloadFile(cloudflaredAssetUrl(cloudflaredTarget.assetName), versionedPath);
    if (!isValidCachedFile(versionedPath, MIN_VALID_ARCHIVE_BYTES)) {
      throw new Error(
        `Downloaded cloudflared binary ${versionedPath} is suspiciously small — download likely failed.`,
      );
    }
  }
  return versionedPath;
}

async function main() {
  const fresh = process.argv.includes('--fresh');
  log('== Calame desktop asset preparation ==\n');

  // Step 1: make sure dist-bundle/ exists and is current.
  if (fresh || !fs.existsSync(DIST_BUNDLE_SERVER)) {
    log(
      fresh
        ? '--fresh passed — rebuilding dist-bundle via `pnpm bundle`...'
        : 'dist-bundle/server.mjs missing — building it first via `pnpm bundle`...',
    );
    execSync('pnpm bundle', { cwd: REPO_ROOT, stdio: 'inherit' });
  } else {
    log(
      'dist-bundle/server.mjs already present — skipping `pnpm bundle` (pass --fresh to force a rebuild).',
    );
  }
  log('');

  // Step 2: resolve the host's Node sidecar runtime (download + extract, cached).
  const target = getCurrentTarget();
  log(`Target triple: ${target.triple} (Node ${NODE_VERSION}, ${target.nodeDist})`);
  const extractedNodeBinary = await ensureNodeRuntime(target);
  log('');

  // Step 3: stage the sidecar binary under Tauri's expected name.
  fs.mkdirSync(BINARIES_DIR, { recursive: true });
  const sidecarPath = path.join(BINARIES_DIR, target.sidecarBinaryName);
  fs.copyFileSync(extractedNodeBinary, sidecarPath);
  log(`Staged sidecar runtime -> ${sidecarPath}`);

  // Step 4: mirror dist-bundle/ into resources/server/ (clean copy).
  fs.rmSync(RESOURCES_SERVER_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(RESOURCES_SERVER_DIR), { recursive: true });
  fs.cpSync(DIST_BUNDLE_DIR, RESOURCES_SERVER_DIR, { recursive: true, dereference: true });
  log(`Mirrored dist-bundle/ -> ${RESOURCES_SERVER_DIR}`);

  // Step 5: resolve + stage cloudflared for the "Expose for Copilot / ChatGPT"
  // tunnel feature. Must run AFTER step 4 — that step wipes and recreates
  // resources/server/ from scratch, which would otherwise delete this.
  log('');
  log(`Resolving cloudflared v${CLOUDFLARED_VERSION} for ${target.triple}...`);
  const downloadedCloudflaredPath = await ensureCloudflaredBinary(target);
  const cloudflaredBinaryFileName = cloudflaredBinaryName(target.triple);
  // Ship in the installer.
  const cloudflaredResourcePath = path.join(RESOURCES_SERVER_DIR, cloudflaredBinaryFileName);
  fs.copyFileSync(downloadedCloudflaredPath, cloudflaredResourcePath);
  log(`Staged cloudflared (packaged mode) -> ${cloudflaredResourcePath}`);
  // Fixed-name "current version" pointer — this is what
  // packages/cli/src/tunnel/cloudflared-resolve.ts looks for in dev mode
  // (CACHE_DIR is shared with the Node runtime cache above).
  const cloudflaredDevCachePath = path.join(CACHE_DIR, cloudflaredBinaryFileName);
  fs.copyFileSync(downloadedCloudflaredPath, cloudflaredDevCachePath);
  log(`Staged cloudflared (dev mode cache) -> ${cloudflaredDevCachePath}`);

  // Step 6: summary.
  const nodeBinarySize = fs.statSync(sidecarPath).size;
  const resourcesSize = dirSizeBytes(RESOURCES_SERVER_DIR);
  const cloudflaredSize = fs.statSync(cloudflaredResourcePath).size;

  log('\n== Summary ==');
  log(`  Node runtime embedded : v${NODE_VERSION} (${target.triple})`);
  log(`  binaries/${target.sidecarBinaryName} : ${formatBytes(nodeBinarySize)}`);
  log(`  resources/server/                     : ${formatBytes(resourcesSize)}`);
  log(`  cloudflared embedded  : v${CLOUDFLARED_VERSION} (${formatBytes(cloudflaredSize)})`);
  log(`  -> ${sidecarPath}`);
  log(`  -> ${RESOURCES_SERVER_DIR}`);
  log(`  -> ${cloudflaredResourcePath}`);
  log('\nDone.');
}

main().catch((err) => {
  console.error('\nprepare-desktop failed:', err);
  process.exit(1);
});
