#!/usr/bin/env node
/**
 * RAG sync benchmark — see README.md next to this file.
 *
 *   node scripts/rag-sync-bench/run-bench.mjs --label baseline \
 *     [--docs 1000] [--seed 42] [--embedder onnx|fake] [--models-root <dir>] \
 *     [--out <dir>] [--watch-settle-ms 3000]
 *
 * 1. regenerates the deterministic corpus (generate-corpus.mjs) in `--out`;
 * 2. bundles bench-runner.mjs + the parser worker with esbuild (TypeScript
 *    sources, no `pnpm build` needed);
 * 3. runs the three scenarios in a fresh child process and writes
 *    `<results-dir>/<label>.json` (default results dir: the bench out dir).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { generateCorpus, BENCH_MAX_FILE_BYTES } from './generate-corpus.mjs';
import { EMBEDDING_MODEL_FOLDER } from '../fetch-embedding-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
// Inside ee/rag-core so the externals (better-sqlite3, sqlite-vec,
// @huggingface/transformers) resolve through its node_modules (pnpm strict).
const BUILD_DIR = path.join(REPO_ROOT, 'ee/rag-core/node_modules/.cache/calame-rag-bench');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function defaultModelsRoot() {
  const env = process.env['CALAME_LOCAL_EMBEDDING_MODEL_DIR'];
  if (env) return env;
  const base = path.join(REPO_ROOT, 'node_modules/.cache/calame-desktop/models');
  if (!fs.existsSync(base)) return null;
  for (const rev of fs.readdirSync(base)) {
    if (fs.existsSync(path.join(base, rev, EMBEDDING_MODEL_FOLDER, 'config.json'))) {
      return path.join(base, rev);
    }
  }
  return null;
}

const label = arg('label', 'run');
const docs = Number(arg('docs', '1000'));
const seed = Number(arg('seed', '42'));
const embedder = arg('embedder', 'onnx');
const out = path.resolve(arg('out', path.join(os.tmpdir(), 'calame-rag-bench')));
const resultsDir = path.resolve(arg('results-dir', out));
const watchSettleMs = Number(arg('watch-settle-ms', '3000'));
const modelsRoot = embedder === 'onnx' ? (arg('models-root') ?? defaultModelsRoot()) : null;
if (embedder === 'onnx' && !modelsRoot) {
  console.error(
    'Local ONNX model not found. Run "pnpm model:fetch", pass --models-root <dir containing ' +
      `${EMBEDDING_MODEL_FOLDER}/>, or use --embedder fake.`,
  );
  process.exit(2);
}

console.log(`[bench] generating corpus (docs=${docs}, seed=${seed}) in ${out}`);
const manifest = generateCorpus({ out, docs, seed });
console.log(
  `[bench] ${manifest.files} files, ${(manifest.totalBytes / 1048576).toFixed(1)} MB ${JSON.stringify(manifest.byFormat)}`,
);

fs.mkdirSync(BUILD_DIR, { recursive: true });
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['better-sqlite3', 'sqlite-vec', 'onnxruntime-node', '@huggingface/transformers'],
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  logLevel: 'warning',
};
await esbuild.build({
  ...shared,
  entryPoints: [path.join(HERE, 'bench-runner.mjs')],
  outfile: path.join(BUILD_DIR, 'bench-runner.bundle.mjs'),
});
await esbuild.build({
  ...shared,
  entryPoints: [path.join(REPO_ROOT, 'ee/rag-core/src/parsers/parse-worker.ts')],
  outfile: path.join(BUILD_DIR, 'parse-worker.mjs'),
});

const runnerOpts = {
  out,
  seed,
  embedder,
  modelsRoot,
  watchSettleMs,
  parseWorkerUrl: pathToFileURL(path.join(BUILD_DIR, 'parse-worker.mjs')).href,
};
console.log(`[bench] running scenarios (embedder=${embedder})…`);
const child = spawn(
  process.execPath,
  [path.join(BUILD_DIR, 'bench-runner.bundle.mjs'), JSON.stringify(runnerOpts)],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
let stdout = '';
child.stdout.on('data', (d) => {
  stdout += d;
});
const code = await new Promise((r) => child.on('close', r));
const marker = stdout.lastIndexOf('__BENCH_RESULT__');
if (code !== 0 || marker === -1) {
  console.error(stdout);
  console.error(`[bench] runner failed (exit ${code})`);
  process.exit(1);
}
const results = JSON.parse(stdout.slice(marker + '__BENCH_RESULT__'.length).trim());

const git = (cmd) => {
  try {
    return execSync(`git ${cmd}`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const report = {
  label,
  date: new Date().toISOString(),
  git: { commit: git('rev-parse --short HEAD'), dirty: Boolean(git('status --porcelain')) },
  environment: {
    platform: `${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 1073741824),
    node: process.version,
    nativeWindows: process.platform === 'win32',
  },
  config: {
    docs,
    seed,
    files: manifest.files,
    corpusMB: Math.round((manifest.totalBytes / 1048576) * 10) / 10,
    byFormat: manifest.byFormat,
    embedder: embedder === 'onnx' ? 'local ONNX embeddinggemma-300m q4 (batch 8)' : 'fake (sha256)',
    maxFileSizeBytes: BENCH_MAX_FILE_BYTES,
    parseTimeoutMs: process.env['CALAME_RAG_PARSE_TIMEOUT_MS'] ?? 'default (120000)',
    docTimeoutMs: process.env['CALAME_RAG_DOC_TIMEOUT_MS'] ?? 'default (300000)',
    onnxThreads: 'onnxruntime default (not configurable yet)',
  },
  ...results,
};
fs.mkdirSync(resultsDir, { recursive: true });
const file = path.join(resultsDir, `${label}.json`);
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

const f = (n, d = 1) => (typeof n === 'number' ? n.toFixed(d) : String(n));
for (const s of report.scenarios) {
  console.log(
    `\n== ${s.scenario}: ${f(s.wallMs / 1000)} s, status=${s.job.status}, ` +
      `indexed=${s.job.indexed} unchanged=${s.job.unchanged} rejected=${s.job.rejected} gc=${s.job.gcDeleted}`,
  );
  console.log(
    `   CPU ${f(s.cpu.avgCoresBusy, 2)} cores (${f(s.cpu.avgMachinePct)} % machine), ` +
      `peak RSS ${f(s.memory.peakRssMB, 0)} MB, event loop p99 ${f(s.responsiveness.eventLoopDelayMs.p99)} ms ` +
      `max ${f(s.responsiveness.eventLoopDelayMs.max)} ms, poll p95 ${f(s.responsiveness.jobsPollLatencyMs.p95)} ms, ` +
      `longest progress stall ${f(s.responsiveness.longestProgressStallMs / 1000)} s`,
  );
  console.log(
    `   ${f(s.throughput.docsPerSec)} docs/s, ${f(s.throughput.chunksEmbeddedPerSec)} chunks embedded/s — phases: ` +
      Object.entries(s.phases)
        .map(([p, v]) => `${p} ${f(v.totalMs / 1000)} s (${f(v.pctOfWall)} %)`)
        .join(', '),
  );
}
if (report.watcher) {
  console.log(
    `\n== watcher: ${JSON.stringify(report.watcher)} mutation=${JSON.stringify(report.mutation)}`,
  );
}
console.log(`\n[bench] results written to ${file}`);
