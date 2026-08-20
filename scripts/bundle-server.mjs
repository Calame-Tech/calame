#!/usr/bin/env node
/**
 * Bundle the Calame server (packages/cli) into a self-contained folder that
 * can run outside the monorepo with nothing but a portable Node runtime.
 *
 * Output: dist-bundle/
 *   server.mjs        — single-file esbuild bundle of packages/cli/src/index.ts
 *   node_modules/      — the handful of packages esbuild could not bundle
 *                        (native prebuilds / dynamic-require offenders), plus
 *                        their own runtime dependency closure
 *   web/                — the built frontend (packages/web/dist)
 *   models/              — the bundled local embedding model (EmbeddingGemma,
 *                        see fetch-embedding-model.mjs), skippable with
 *                        --skip-model for fast UI-only rebuilds
 *   README.md           — how to run the bundle
 *
 * Usage: pnpm bundle   (or: node scripts/bundle-server.mjs [--skip-model])
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureEmbeddingModel, EMBEDDING_MODEL_FOLDER } from './fetch-embedding-model.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIR = path.join(REPO_ROOT, 'packages/cli');
const RAG_CORE_DIR = path.join(REPO_ROOT, 'ee/rag-core');
const WEB_DIR = path.join(REPO_ROOT, 'packages/web');
const WEB_DIST = path.join(WEB_DIR, 'dist');
const OUT_DIR = path.join(REPO_ROOT, 'dist-bundle');
const OUT_FILE = path.join(OUT_DIR, 'server.mjs');
const OUT_NODE_MODULES = path.join(OUT_DIR, 'node_modules');
// mcp-remote's stdio<->HTTP proxy CLI, bundled as a sibling of server.mjs so
// the "Connect to Claude Desktop" integration can launch it with nothing but
// `node <this file> <url> --header ...` — no node_modules tree on the client
// machine. See packages/cli/src/routes/claude-desktop/mcp-remote-resolve.ts.
const MCP_REMOTE_OUT_FILE = path.join(OUT_DIR, 'mcp-remote.mjs');

// Packages esbuild must leave untouched:
//   - better-sqlite3, sqlite-vec: ship prebuilt native addons (.node/.dll) —
//     can't be inlined into a JS bundle.
//   - ssh2: pulls in optional native bindings (cpu-features, nan) via a
//     try/catch require; on this box neither built, so ssh2 already runs in
//     pure-JS mode, but its own dynamic requires still confuse esbuild if
//     bundled, so it stays external.
//   - pg-native: not a real dependency of our code — `pg` lazily
//     `require()`s it behind a getter (`pg.native`) that we never touch, but
//     the getter's target file does a *static* `require('pg-native')` that
//     esbuild resolves at build time even though it never runs. Marking it
//     external avoids a "Could not resolve pg-native" build error. Since
//     pg-native isn't installed (it's optional and we don't use it), there is
//     nothing to copy into the bundle for it.
//   - onnxruntime-node: ships prebuilt native addons per-platform (see
//     pruneOnnxruntimeNodeBinaries below) — same reasoning as better-sqlite3.
//   - @huggingface/transformers: its Node entrypoint has *static* imports of
//     both onnxruntime-node and onnxruntime-web/sharp (confirmed in the
//     Phase 0 prototype — see src/backends/onnx.js's own comment: "dynamic
//     imports don't seem to work with the current webpack version"), so
//     bundling it would require esbuild to resolve those native/binary deps
//     anyway. Kept external and copied whole, like its native siblings.
const ESBUILD_EXTERNAL = [
  'better-sqlite3',
  'sqlite-vec',
  'ssh2',
  'pg-native',
  'onnxruntime-node',
  '@huggingface/transformers',
];

// The subset of ESBUILD_EXTERNAL that actually needs to be physically copied
// into dist-bundle/node_modules, and the workspace package that declares each
// one directly (pnpm's strict node_modules only exposes a package to the
// dependents that actually declare it — sqlite-vec is a dependency of
// ee/rag-core, not of packages/cli, so it must be resolved starting there).
const NATIVE_ROOTS = [
  { pkg: 'better-sqlite3', from: CLI_DIR },
  { pkg: 'ssh2', from: CLI_DIR },
  { pkg: 'sqlite-vec', from: RAG_CORE_DIR },
  { pkg: '@huggingface/transformers', from: RAG_CORE_DIR },
];

// Declared as a runtime "dependency" by better-sqlite3's package.json, but
// only ever require()'d from its install script (to fetch the prebuilt
// .node binary) — never from lib/*.js. Skipping it avoids dragging in its own
// large dependency tree (tar-fs, node-abi, simple-get, ...) for nothing.
//
// onnxruntime-web (~130MB of WASM, pulled in by @huggingface/transformers)
// is excluded too: Phase 0 confirmed empirically (delete the package, re-run
// inference end-to-end) that transformers.js's Node entrypoint never touches
// it when running CPU-only inference — the "import both, pick one at
// runtime" pattern in its onnx.js backend only *requires* onnxruntime-node
// under Node. `sharp` was tested the same way and, unlike onnxruntime-web, IS
// a hard runtime dependency of transformers.node.mjs (import fails without
// it) — so it stays in the closure despite Calame never calling its vision
// code paths.
const EXCLUDE_TRANSITIVE = new Set(['prebuild-install', 'onnxruntime-web']);

const NATIVE_BINARY_EXTENSIONS = new Set(['.node', '.dll', '.so', '.dylib']);

// onnxruntime-node ships prebuilt binaries for every platform it supports
// (win32/linux/darwin × x64/arm64) inside one package — unlike sqlite-vec's
// per-platform-subpackage layout, there's no npm-level way to install only
// one. Prune everything except the Windows x64 CPU binaries after copying:
// Calame's desktop build targets Windows x64 only (see prepare-desktop.mjs's
// NODE_DIST_TARGETS — only x86_64-pc-windows-msvc is wired end-to-end today),
// and within win32/x64, DirectML.dll/dxcompiler.dll/dxil.dll are the
// DirectML GPU execution provider, which LocalOnnxEmbeddingClient never
// requests (CPU-only) — confirmed safe to remove in the Phase 0 prototype.
const ONNXRUNTIME_NODE_KEEP_PLATFORM = 'win32';
const ONNXRUNTIME_NODE_KEEP_ARCH = 'x64';
const ONNXRUNTIME_NODE_PRUNE_FILES = new Set(['DirectML.dll', 'dxcompiler.dll', 'dxil.dll']);

/**
 * Strip onnxruntime-node's bin/napi-v6/<platform>/<arch>/ tree down to just
 * the Windows x64 CPU binaries. `destDir` is the copied package root inside
 * dist-bundle/node_modules (see copyPackageClosure). No-op (with a warning)
 * if the expected bin/ layout isn't found — better to ship oversized than to
 * silently break on a future onnxruntime-node major that restructures it.
 */
function pruneOnnxruntimeNodeBinaries(destDir) {
  const napiDir = path.join(destDir, 'bin', 'napi-v6');
  if (!fs.existsSync(napiDir)) {
    log(`    (!) onnxruntime-node: expected ${napiDir} not found — skipping binary pruning.`);
    return;
  }
  for (const platform of fs.readdirSync(napiDir)) {
    const platformDir = path.join(napiDir, platform);
    if (platform !== ONNXRUNTIME_NODE_KEEP_PLATFORM) {
      fs.rmSync(platformDir, { recursive: true, force: true });
      continue;
    }
    for (const arch of fs.readdirSync(platformDir)) {
      const archDir = path.join(platformDir, arch);
      if (arch !== ONNXRUNTIME_NODE_KEEP_ARCH) {
        fs.rmSync(archDir, { recursive: true, force: true });
        continue;
      }
      for (const file of fs.readdirSync(archDir)) {
        if (ONNXRUNTIME_NODE_PRUNE_FILES.has(file)) {
          fs.rmSync(path.join(archDir, file), { force: true });
        }
      }
    }
  }
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

function findNativeBinaries(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findNativeBinaries(full));
    } else if (NATIVE_BINARY_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Resolve the on-disk directory of an installed package, starting the module
 * resolution search from `fromDir` (so pnpm's per-package isolation is
 * respected — a package is only resolvable from a directory that actually
 * depends on it).
 *
 * Uses `resolve.paths()` (the list of node_modules directories Node would
 * search) plus a plain fs check, rather than `require.resolve()` itself —
 * some of the packages we need to locate (e.g. sqlite-vec-windows-x64) ship
 * an "exports" map with no "." entry, since they are never `require()`d
 * directly (only resolved as a path to a .dll/.so). `require.resolve` would
 * throw on those; a directory-existence check does not care.
 */
function resolvePackageDir(pkgName, fromDir) {
  const req = createRequire(path.join(fromDir, 'package.json'));
  const searchPaths = req.resolve.paths(pkgName) ?? [];
  for (const candidate of searchPaths) {
    const dir = path.join(candidate, pkgName);
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      // pnpm exposes packages as symlinks into its content-addressed store
      // (node_modules/.pnpm/...). Resolve to the real path before returning —
      // callers use this as the search base for that package's own
      // dependencies, and pnpm only places those alongside the *real*
      // location, not the symlink's apparent one.
      return fs.realpathSync(dir);
    }
  }
  throw new Error(
    `"${pkgName}" not found (searched ${searchPaths.length} node_modules dirs from ${fromDir})`,
  );
}

/**
 * Recursively copy a package and its production dependency closure
 * (dependencies + optionalDependencies) into dist-bundle/node_modules, using
 * a single flat directory so Node's normal upward node_modules resolution
 * finds everything as siblings.
 */
function copyPackageClosure(pkgName, fromDir, visited, copied) {
  if (visited.has(pkgName)) return;
  visited.add(pkgName);

  let pkgDir;
  try {
    pkgDir = resolvePackageDir(pkgName, fromDir);
  } catch (err) {
    log(`    (skip) ${pkgName}: ${err.message}`);
    return;
  }

  const destDir = path.join(OUT_NODE_MODULES, pkgName);
  fs.cpSync(pkgDir, destDir, {
    recursive: true,
    dereference: true,
    // pnpm keeps a package's own deps as siblings in the store, not nested
    // inside the package folder, so any node_modules found here would be
    // stray — skip it rather than duplicating what we copy explicitly below.
    filter: (src) => path.basename(src) !== 'node_modules',
  });
  copied.push({ name: pkgName, from: pkgDir, to: destDir });

  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
  const deps = { ...pkgJson.dependencies, ...pkgJson.optionalDependencies };
  for (const dep of Object.keys(deps)) {
    if (EXCLUDE_TRANSITIVE.has(dep)) continue;
    copyPackageClosure(dep, pkgDir, visited, copied);
  }
}

async function main() {
  log('== Calame server bundler ==\n');

  // 1. Build the web UI if it hasn't been built yet.
  if (!fs.existsSync(WEB_DIST)) {
    log('packages/web/dist not found — building the frontend first...');
    execSync('pnpm --filter @calame/web build', { cwd: REPO_ROOT, stdio: 'inherit' });
  } else {
    log('packages/web/dist already present — skipping frontend build.');
  }

  // 2. Reset the output directory.
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_NODE_MODULES, { recursive: true });

  // 3. Bundle the server entry point with esbuild.
  log('\nBundling packages/cli/src/index.ts with esbuild...');
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.join(CLI_DIR, 'src/index.ts')],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    external: ESBUILD_EXTERNAL,
    // The ESM output has no global `require`. Bundled CJS dependencies that
    // esbuild couldn't statically resolve into plain imports (or that use
    // require() for dynamic/optional lookups) still call require() at
    // runtime, so we shim one in via createRequire.
    banner: {
      js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
    },
    logLevel: 'info',
  });

  // 3b. Bundle mcp-remote's CLI proxy entry (`mcp-remote/dist/proxy.js`) —
  // the process Claude Desktop actually launches to bridge its stdio MCP
  // transport to Calame's HTTP endpoint. Pure JS (express/open/undici/
  // strict-url-sanitise — no native addons), so unlike ESBUILD_EXTERNAL
  // above this bundles cleanly standalone with no external/copy step.
  log("\nBundling mcp-remote's proxy entry with esbuild...");
  const mcpRemoteDir = resolvePackageDir('mcp-remote', CLI_DIR);
  const mcpRemoteEntry = path.join(mcpRemoteDir, 'dist/proxy.js');
  await esbuild.build({
    entryPoints: [mcpRemoteEntry],
    outfile: MCP_REMOTE_OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    // mcp-remote pulls in express (for its local OAuth callback listener),
    // whose CJS dependency tree (body-parser, depd, ...) calls require() at
    // runtime for lookups esbuild can't statically resolve into the ESM
    // output. Same shim as the server.mjs bundle above.
    banner: {
      js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
    },
    logLevel: 'info',
  });

  // 4. Copy the packages esbuild left external, plus their dependency
  // closure, so the bundle's require()/import() of them resolves.
  log('\nCopying native/external packages into dist-bundle/node_modules...');
  const visited = new Set();
  const copied = [];
  for (const { pkg, from } of NATIVE_ROOTS) {
    copyPackageClosure(pkg, from, visited, copied);
  }
  const onnxruntimeNodeCopy = copied.find((c) => c.name === 'onnxruntime-node');
  if (onnxruntimeNodeCopy) {
    const beforeSize = dirSizeBytes(onnxruntimeNodeCopy.to);
    pruneOnnxruntimeNodeBinaries(onnxruntimeNodeCopy.to);
    const afterSize = dirSizeBytes(onnxruntimeNodeCopy.to);
    log(
      `    onnxruntime-node: pruned to ${ONNXRUNTIME_NODE_KEEP_PLATFORM}/${ONNXRUNTIME_NODE_KEEP_ARCH} CPU-only ` +
        `(${formatBytes(beforeSize)} -> ${formatBytes(afterSize)})`,
    );
  }
  try {
    resolvePackageDir('pg-native', CLI_DIR);
    log(
      '    (!) pg-native is installed but was NOT copied — verify write-executor pg usage does not touch pg.native.',
    );
  } catch {
    log(
      '    pg-native: not installed (optional native addon for `pg`; pg falls back to its pure-JS driver). ' +
        'Kept external only so esbuild does not error resolving it at build time — nothing to copy.',
    );
  }

  // 5. Copy the built frontend.
  log('\nCopying packages/web/dist -> dist-bundle/web...');
  fs.cpSync(WEB_DIST, path.join(OUT_DIR, 'web'), { recursive: true, dereference: true });

  // 5b. Stage the bundled local embedding model (fetched/cached by
  // fetch-embedding-model.mjs — see that file for the pinned revision and
  // per-file integrity checks). Skippable via --skip-model for fast UI-only
  // rebuilds; prepare-desktop.mjs's `cpSync(DIST_BUNDLE_DIR, RESOURCES_SERVER_DIR)`
  // mirrors dist-bundle/ wholesale, so staging it here (rather than in
  // prepare-desktop.mjs) means it's already in place with no extra ordering
  // hazard — unlike cloudflared, which must be copied AFTER that script's own
  // directory wipe.
  const skipModel = process.argv.includes('--skip-model');
  let modelDirSize = 0;
  if (skipModel) {
    log('\n--skip-model passed — skipping embedding model staging.');
  } else {
    log('\nStaging bundled embedding model...');
    const cachedModelDir = await ensureEmbeddingModel();
    const modelDestDir = path.join(OUT_DIR, 'models', EMBEDDING_MODEL_FOLDER);
    fs.cpSync(cachedModelDir, modelDestDir, { recursive: true, dereference: true });
    modelDirSize = dirSizeBytes(modelDestDir);
    log(`  Staged -> ${modelDestDir} (${formatBytes(modelDirSize)})`);
  }

  // 6. Write the README.
  fs.writeFileSync(
    path.join(OUT_DIR, 'README.md'),
    `# Calame server bundle

Self-contained build of the Calame server. Requires nothing but a Node.js
20+ runtime (portable or system-installed) — no pnpm, no monorepo checkout.

## Run

\`\`\`
CALAME_PACKAGED=1 CALAME_WEB_DIST=<this-dir>/web node server.mjs
\`\`\`

On Windows (cmd.exe):

\`\`\`
set CALAME_PACKAGED=1
set CALAME_WEB_DIST=<this-dir>\\web
node server.mjs
\`\`\`

The server listens on port 4567 by default (override with \`--port <n>\` or
\`CALAME_PORT\`). Other configuration is via the same \`CALAME_*\` environment
variables documented in packages/cli — e.g. \`CALAME_DATA_DIR\` for where the
SQLite database and secret file are stored.
`,
  );

  // 7. Summary.
  const bundleSize = fs.statSync(OUT_FILE).size;
  const mcpRemoteSize = fs.statSync(MCP_REMOTE_OUT_FILE).size;
  const nodeModulesSize = dirSizeBytes(OUT_NODE_MODULES);
  const webSize = dirSizeBytes(path.join(OUT_DIR, 'web'));

  log('\n== Summary ==');
  log(`  server.mjs        : ${formatBytes(bundleSize)}`);
  log(`  mcp-remote.mjs     : ${formatBytes(mcpRemoteSize)}`);
  log(`  node_modules/      : ${formatBytes(nodeModulesSize)} (${copied.length} packages)`);
  log(`  web/                : ${formatBytes(webSize)}`);
  log(`  models/             : ${formatBytes(modelDirSize)}${skipModel ? ' (skipped)' : ''}`);
  log(
    `  total dist-bundle/  : ${formatBytes(bundleSize + mcpRemoteSize + nodeModulesSize + webSize + modelDirSize)}`,
  );
  log('\n  Native/external packages copied:');
  for (const { name, to } of copied) {
    const binaries = findNativeBinaries(to);
    const evidence =
      binaries.length > 0
        ? binaries.map((b) => path.relative(OUT_DIR, b)).join(', ')
        : '(pure JS, no native binary)';
    log(`    - ${name}: ${evidence}`);
  }
  log('\nDone. See dist-bundle/README.md for run instructions.');
}

main().catch((err) => {
  console.error('\nBundle failed:', err);
  process.exit(1);
});
