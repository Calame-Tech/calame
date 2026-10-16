// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

// Reading one document for the sync worker: byte cap, bounded lock retries
// and timeouts. Split out of rag-index.ts, which runs the sync loop.

import type { ConnectorLike } from './types.js';
import { DocumentRejectedError, classifyReadError } from '../pipeline/document-errors.js';

/**
 * Read all bytes from a Node Readable stream into a single Buffer, refusing
 * to buffer more than `maxBytes` (the stream is destroyed — file handle
 * closed — as soon as the cap is crossed).
 */
async function streamToBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.byteLength;
    if (total > maxBytes) {
      destroyStream(stream);
      throw new DocumentRejectedError(
        'too_large',
        `File is larger than the ${formatBytes(maxBytes)} per-document limit; it was skipped.`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Close a connector stream (and its file handle) — idempotent, null-safe. */
function destroyStream(stream: NodeJS.ReadableStream | null): void {
  const s = stream as (NodeJS.ReadableStream & { destroy?: () => void }) | null;
  if (s && typeof s.destroy === 'function') s.destroy();
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${n} bytes`;
}

/**
 * Default host-side cap on the bytes buffered for ONE document: 50 MB, the
 * same as the browser upload cap and the local connector's listing-time
 * default. It is the safety net for connectors that don't enforce a cap at
 * listing time and for files that grew between listing and fetch.
 */
const DEFAULT_MAX_DOC_BYTES = 50 * 1024 * 1024;

/**
 * Effective byte cap for a source: the source's own `maxFileSizeBytes` when
 * configured (local connector; `<= 0` means "no cap", as there), otherwise
 * `CALAME_RAG_MAX_DOC_BYTES`, otherwise {@link DEFAULT_MAX_DOC_BYTES}.
 */
function readMaxDocBytes(config: Record<string, unknown>): number {
  const perSource = config['maxFileSizeBytes'];
  if (typeof perSource === 'number') {
    return perSource <= 0 ? Number.POSITIVE_INFINITY : perSource;
  }
  const raw = process.env['CALAME_RAG_MAX_DOC_BYTES'];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_MAX_DOC_BYTES : parsed;
}

/**
 * Bounded retries for a file that is locked by another program (Word on
 * Windows holds an exclusive lock while saving). `CALAME_RAG_LOCKED_RETRIES`
 * (default 2 → at most 3 attempts) and `CALAME_RAG_LOCKED_RETRY_DELAY_MS`
 * (default 500 ms, linear backoff: 500 ms then 1 s). After the last attempt
 * the file is rejected as `locked` for this sync and retried on the next one.
 */
function readLockedRetryPolicy(): { retries: number; delayMs: number } {
  const int = (name: string, fallback: number): number => {
    const raw = process.env[name];
    const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
    return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
  };
  return {
    retries: Math.min(int('CALAME_RAG_LOCKED_RETRIES', 2), 10),
    delayMs: int('CALAME_RAG_LOCKED_RETRY_DELAY_MS', 500),
  };
}

/**
 * Fetch one document and buffer it, with the per-document timeout, the byte
 * cap and the bounded lock retries. The connector stream is always destroyed
 * on failure so no file handle outlives the attempt (on Windows a leaked
 * handle would itself keep the file locked).
 */
export async function fetchDocumentBytes(
  connector: ConnectorLike,
  config: Record<string, unknown>,
  sourceId: string,
  doc: { id: string; path: string },
  timeoutMs: number,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const maxBytes = readMaxDocBytes(config);
  const { retries, delayMs } = readLockedRetryPolicy();
  for (let attempt = 0; ; attempt++) {
    let stream: NodeJS.ReadableStream | null = null;
    try {
      const fetched = await withTimeout(
        connector.fetchDocument(config, sourceId, doc.id),
        timeoutMs,
        `fetchDocument(${doc.path})`,
      );
      stream = fetched.stream;
      const buffer = await withTimeout(
        streamToBuffer(fetched.stream, maxBytes),
        timeoutMs,
        `streamToBuffer(${doc.path})`,
      );
      return { buffer, mimeType: fetched.mimeType };
    } catch (err: unknown) {
      destroyStream(stream);
      const rejected = classifyReadError(err);
      if (rejected?.kind === 'locked' && attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw rejected ?? err;
    }
  }
}

/**
 * Per-document hard timeout in milliseconds. Reads `CALAME_RAG_DOC_TIMEOUT_MS`
 * (default 300_000 = 5 min). Set to 0 or negative to disable (NOT recommended
 * — a hung parser will freeze the worker indefinitely). NaN falls back to the
 * default.
 *
 * This is a *soft* timeout for fetch / read / embed: Promise.race only lets
 * the sync continue past them (a timed-out fetch's stream is destroyed).
 * PARSING has its own *hard* timeout (`CALAME_RAG_PARSE_TIMEOUT_MS`, default
 * 120 s) enforced by the IsolatedParser worker, which is terminated — so a
 * parser stuck in a loop really stops instead of leaking a busy thread.
 */
export function readDocTimeoutMs(): number {
  const raw = process.env['CALAME_RAG_DOC_TIMEOUT_MS'];
  if (raw === undefined) return 300_000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 300_000;
  return parsed;
}

/**
 * Race a promise against a timer; reject with a labelled error if the timer
 * fires first. The original promise is left to settle on its own (its result
 * is discarded) — there is no AbortSignal threaded through the ingest
 * pipeline, so this is a best-effort safety net rather than a real cancel.
 *
 * When `registerReset` is given, it receives a function that re-arms the
 * timer: the budget then applies to INACTIVITY rather than to the total
 * duration, so a long document that keeps reporting embedding progress is
 * not cut off while a stalled one still is.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  registerReset?: (reset: () => void) => void,
): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const fire = (): void => reject(new Error(`${label} timed out after ${ms}ms`));
    let timer = setTimeout(fire, ms);
    registerReset?.(() => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(fire, ms);
    });
    promise.then(
      (value) => {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
