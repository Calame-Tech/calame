// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Sync phases instrumented separately so a benchmark (scripts/rag-sync-bench)
 * can tell where the time goes on a large corpus:
 *  - `walk`  — connector listing (readdir + stat per file → etag);
 *  - `read`  — fetching / buffering one document's bytes;
 *  - `hash`  — content SHA-256 + existing-row lookup (incremental check);
 *  - `parse` — parser (in the isolated worker in production);
 *  - `chunk` — chunker;
 *  - `embed` — embedding client (local ONNX by default);
 *  - `write` — the SQLite transaction (rows, chunks + FTS triggers, vectors).
 */
export type SyncPhase = 'walk' | 'read' | 'hash' | 'parse' | 'chunk' | 'embed' | 'write';

/** Receives the wall-clock duration of one phase occurrence, in ms. */
export type PhaseTimingSink = (phase: SyncPhase, ms: number) => void;

/**
 * Time `fn` and report it to `sink` — whether it resolves or throws (a
 * failing parse still costs time). A no-op wrapper when `sink` is absent.
 */
export async function timePhase<T>(
  sink: PhaseTimingSink | undefined,
  phase: SyncPhase,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!sink) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    sink(phase, performance.now() - start);
  }
}

/** Synchronous variant of {@link timePhase}. */
export function timePhaseSync<T>(
  sink: PhaseTimingSink | undefined,
  phase: SyncPhase,
  fn: () => T,
): T {
  if (!sink) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    sink(phase, performance.now() - start);
  }
}
