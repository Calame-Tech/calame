/**
 * Benchmark body — bundled by run-bench.mjs with esbuild (it imports the
 * rag-core / rag-connectors TypeScript sources directly) and executed in a
 * dedicated child process so its CPU / memory figures are not polluted by
 * the bundler. Do not run directly; use run-bench.mjs.
 *
 * It drives the REAL production path — LocalFolderConnector → runSyncJob →
 * IngestionPipeline (IsolatedParser worker, chunkers, local ONNX embeddings,
 * SqliteVecStore + FTS5 triggers in a file-backed SQLite DB) — over three
 * scenarios on the same corpus: initial indexing, unchanged resync, partial
 * update (detected by the WatchManager, then synced).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import Database from 'better-sqlite3';

import { runRagMigrations } from '../../ee/rag-core/src/storage/schema.ts';
import { SqliteVecStore } from '../../ee/rag-core/src/storage/sqlite-vec-store.ts';
import { IngestionPipeline } from '../../ee/rag-core/src/pipeline/ingest.ts';
import {
  IsolatedParser,
  readParseTimeoutMs,
} from '../../ee/rag-core/src/parsers/isolated-parser.ts';
import { LocalOnnxEmbeddingClient } from '../../ee/rag-core/src/embeddings/local-onnx-client.ts';
import { runSyncJob } from '../../ee/rag-core/src/routes/rag-index.ts';
import { WatchManager } from '../../ee/rag-core/src/jobs/watch-manager.ts';
import { LocalFolderConnector } from '../../ee/rag-connectors/src/local-folder.ts';
import { BENCH_MAX_FILE_BYTES, mutateCorpus } from './generate-corpus.mjs';

const opts = JSON.parse(process.argv[2]);
const DIM = 768;
const PHASES = ['walk', 'read', 'hash', 'parse', 'chunk', 'embed', 'write'];

// ---------------------------------------------------------------------------
// Wiring (mirrors packages/cli/src/rag-runtime.ts)
// ---------------------------------------------------------------------------

let phaseStats = {};
const resetPhases = () => {
  phaseStats = Object.fromEntries(PHASES.map((p) => [p, { count: 0, totalMs: 0, maxMs: 0 }]));
};
resetPhases();
const sink = (phase, ms) => {
  const s = phaseStats[phase];
  s.count++;
  s.totalMs += ms;
  if (ms > s.maxMs) s.maxMs = ms;
};

const dbPath = path.join(opts.out, 'bench.sqlite');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
runRagMigrations({ raw: db });
const vectorStore = new SqliteVecStore(db, DIM);

/** Deterministic, ~free embedder for `--embedder fake` (isolates non-ONNX phases). */
const fakeEmbedder = {
  dimensions: DIM,
  modelName: 'fake-sha256',
  billable: false,
  embed: async (texts) =>
    texts.map((t) => {
      const h = createHash('sha256').update(t).digest();
      const v = Array.from({ length: DIM }, (_, i) => h[i % 32] / 255 - 0.5);
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    }),
};
const baseEmbedder =
  opts.embedder === 'onnx'
    ? new LocalOnnxEmbeddingClient({
        modelsRootDir: opts.modelsRoot,
        modelFolderName: 'embeddinggemma-300m',
        dtype: 'q4',
        dimensions: DIM,
        maxTokens: 2048,
        modelName: 'embeddinggemma-300m-q4',
      })
    : fakeEmbedder;

/**
 * Counts the texts actually handed to embed() — the real embedding workload.
 * A net delta of rag_chunks would hide replacements and deletions (≤ 0 on a
 * partial update even when documents were re-embedded).
 */
let embeddedTexts = 0;
const embedder = {
  dimensions: baseEmbedder.dimensions,
  modelName: baseEmbedder.modelName,
  billable: baseEmbedder.billable,
  embed: (texts, ...rest) => {
    embeddedTexts += texts.length;
    return baseEmbedder.embed(texts, ...rest);
  },
};

const parser = new IsolatedParser({
  workerUrl: new URL(opts.parseWorkerUrl),
  timeoutMs: readParseTimeoutMs(),
});
const pipeline = new IngestionPipeline({
  db,
  vectorStore,
  embeddingClient: embedder,
  parseDocument: (mimeType, buffer, filename) => parser.parse(mimeType, buffer, filename),
  onPhaseTiming: sink,
});

const connector = new LocalFolderConnector();
const corpusRoot = path.join(opts.out, 'corpus');
const sourceConfig = { rootPath: corpusRoot, maxFileSizeBytes: BENCH_MAX_FILE_BYTES };
const SOURCE_ID = 'bench-source';
const now = new Date().toISOString();
db.prepare(
  `INSERT INTO rag_sources
	 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
	  embedding_dimensions, created_at, updated_at)
	 VALUES (?, 'Bench', 'local', ?, 'bench', ?, ?, ?, ?)`,
).run(SOURCE_ID, JSON.stringify(sourceConfig), embedder.modelName, DIM, now, now);

const deps = {
  db,
  pipeline,
  vectorStore,
  decryptConfig: (s) => s,
  resolveConnector: () => connector,
  onSyncPhaseTiming: sink,
};

// ---------------------------------------------------------------------------
// Probes: CPU, memory, event-loop / "UI" responsiveness, progress regularity
// ---------------------------------------------------------------------------

const percentile = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/** The query GET /api/rag/jobs runs — what the history panel polls. */
const jobsPollStmt = db.prepare(
  `SELECT j.* FROM rag_jobs j LEFT JOIN rag_sources s ON s.id = j.source_id
	 WHERE (s.id IS NULL OR s.deleted_at IS NULL) AND j.tenant_id = ?
	 ORDER BY j.started_at DESC LIMIT 50`,
);

function startProbes(jobId) {
  const PROBE_MS = 250;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let peakRss = process.memoryUsage().rss;
  let peakHeap = process.memoryUsage().heapUsed;
  let peakLoad = os.loadavg()[0];
  const pollLatencies = [];
  let lastProcessed = -1;
  let lastProgressAt = t0;
  let maxStallMs = 0;
  let expected = performance.now() + PROBE_MS;
  const memTimer = setInterval(() => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  }, 50);
  const pollTimer = setInterval(() => {
    // Latency = timer lateness + the poll query itself: what a UI request
    // to this process would wait before being answered.
    const start = performance.now();
    const rows = jobsPollStmt.all('default');
    const end = performance.now();
    pollLatencies.push(Math.max(0, start - expected) + (end - start));
    expected = end + PROBE_MS;
    const job = rows.find((r) => r.id === jobId);
    if (job && job.processed_documents !== lastProcessed) {
      lastProcessed = job.processed_documents;
      lastProgressAt = end;
    } else if (job && job.status === 'running') {
      maxStallMs = Math.max(maxStallMs, end - lastProgressAt);
    }
    const l = os.loadavg()[0];
    if (l > peakLoad) peakLoad = l;
  }, PROBE_MS);

  return () => {
    clearInterval(memTimer);
    clearInterval(pollTimer);
    loop.disable();
    const wallMs = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const sorted = [...pollLatencies].sort((a, b) => a - b);
    return {
      wallMs,
      cpu: {
        userMs: cpu.user / 1000,
        systemMs: cpu.system / 1000,
        avgCoresBusy: cpuMs / wallMs,
        avgMachinePct: (100 * cpuMs) / wallMs / os.cpus().length,
        peakLoadAvg1m: peakLoad,
      },
      memory: { peakRssMB: peakRss / 1048576, peakHeapUsedMB: peakHeap / 1048576 },
      responsiveness: {
        eventLoopDelayMs: {
          p50: loop.percentile(50) / 1e6,
          p99: loop.percentile(99) / 1e6,
          max: loop.max / 1e6,
        },
        jobsPollLatencyMs: {
          samples: sorted.length,
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
          max: sorted.at(-1) ?? 0,
        },
        longestProgressStallMs: maxStallMs,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

let jobSeq = 0;
async function runScenario(name) {
  resetPhases();
  const jobId = `bench-${++jobSeq}-${name}`;
  db.prepare(
    `INSERT INTO rag_jobs (id, source_id, status, progress, total_documents, processed_documents, tenant_id, started_at)
	   VALUES (?, ?, 'pending', 0, 0, 0, 'default', ?)`,
  ).run(jobId, SOURCE_ID, new Date().toISOString());
  embeddedTexts = 0;
  const stop = startProbes(jobId);
  await runSyncJob(deps, SOURCE_ID, jobId);
  const probes = stop();
  const job = db.prepare(`SELECT * FROM rag_jobs WHERE id = ?`).get(jobId);
  const counts = {
    chunks: db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks`).get().n,
    vectors: db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks_vec`).get().n,
    fts: db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks_fts`).get().n,
    liveDocuments: db
      .prepare(`SELECT COUNT(*) AS n FROM rag_documents WHERE deleted_at IS NULL`)
      .get().n,
  };
  const sumPhasesMs = PHASES.reduce((n, p) => n + phaseStats[p].totalMs, 0);
  const seconds = probes.wallMs / 1000;
  const result = {
    scenario: name,
    job: {
      status: job.status,
      failureKind: job.failure_kind,
      total: job.total_documents,
      processed: job.processed_documents,
      indexed: job.indexed_documents,
      unchanged: job.unchanged_documents,
      skippedByEtag: job.skipped_by_etag,
      rejected: job.rejected_documents,
      gcDeleted: job.gc_deleted,
      tokensEmbedded: job.tokens_embedded,
      rejectedFiles: JSON.parse(job.rejected_files ?? '[]').map((f) => `${f.kind}: ${f.path}`),
    },
    db: counts,
    phases: Object.fromEntries(
      PHASES.map((p) => [
        p,
        {
          count: phaseStats[p].count,
          totalMs: round(phaseStats[p].totalMs),
          maxMs: round(phaseStats[p].maxMs),
          pctOfWall: round((100 * phaseStats[p].totalMs) / probes.wallMs),
        },
      ]),
    ),
    otherMs: round(probes.wallMs - sumPhasesMs),
    throughput: {
      docsPerSec: round(job.processed_documents / seconds),
      indexedDocsPerSec: round(job.indexed_documents / seconds),
      chunksEmbedded: embeddedTexts,
      chunksEmbeddedPerSec: round(embeddedTexts / seconds),
    },
    ...probes,
  };
  return result;
}

/** Partial update: watcher on, mutate the corpus, count events + triggered syncs. */
async function observeWatcher() {
  const triggers = [];
  const events = [];
  const watchConnector = {
    type: 'local',
    watch: (cfg, sid, onChange) =>
      connector.watch(cfg, sid, (e) => {
        events.push(performance.now());
        onChange(e);
      }),
  };
  const manager = new WatchManager({
    db,
    resolveConnector: () => watchConnector,
    decryptConfig: (s) => s,
    triggerSync: (sourceId) => {
      triggers.push(performance.now());
      return `watch-${sourceId}-${triggers.length}`;
    },
  });
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  manager.start();
  // chokidar exposes no "ready" through the connector: give it a fixed
  // settle time on this corpus before mutating.
  await new Promise((r) => setTimeout(r, opts.watchSettleMs));
  const setupCpu = process.cpuUsage(cpu0);
  const tMutate = performance.now();
  const mutation = mutateCorpus({ out: opts.out, seed: opts.seed });
  // Wait for the burst to drain and the 5 s debounce to fire (or 60 s max).
  const deadline = tMutate + 60_000;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const lastEvent = events.at(-1) ?? tMutate;
    if (triggers.length > 0 && performance.now() - lastEvent > 7_000) break;
  }
  manager.stop();
  const totalCpu = process.cpuUsage(cpu0);
  return {
    mutation,
    watcher: {
      settleMs: opts.watchSettleMs,
      setupCpuMs: round((setupCpu.user + setupCpu.system) / 1000),
      totalCpuMs: round((totalCpu.user + totalCpu.system) / 1000),
      wallMs: round(performance.now() - t0),
      events: events.length,
      firstEventAfterMs: events.length ? round(events[0] - tMutate) : null,
      lastEventAfterMs: events.length ? round(events.at(-1) - tMutate) : null,
      syncTriggers: triggers.length,
      firstTriggerAfterMs: triggers.length ? round(triggers[0] - tMutate) : null,
    },
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

const results = { scenarios: [] };
if (opts.embedder === 'onnx') {
  const t = performance.now();
  await baseEmbedder.warmup();
  results.onnxWarmupMs = round(performance.now() - t);
}
results.scenarios.push(await runScenario('initial'));
results.scenarios.push(await runScenario('unchanged'));
const watch = await observeWatcher();
results.mutation = watch.mutation;
results.watcher = watch.watcher;
results.scenarios.push(await runScenario('partial'));
await parser.close();
db.close();
process.stdout.write(`\n__BENCH_RESULT__${JSON.stringify(results)}\n`);
