// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DocumentRejectedError } from '../pipeline/document-errors.js';
import { UnsupportedMimeTypeError } from './index.js';
import type { ParsedDocument } from './types.js';

/**
 * Default per-file parse budget: 120 s. Generous enough for a 50 MB PDF on a
 * slow laptop, short enough that a pathological file cannot stall a sync for
 * long. Kept below the sync's overall per-document timeout
 * (`CALAME_RAG_DOC_TIMEOUT_MS`, 300 s) so the HARD stop below always fires
 * first. Override with `CALAME_RAG_PARSE_TIMEOUT_MS` (`0` disables it — not
 * recommended).
 */
export const DEFAULT_PARSE_TIMEOUT_MS = 120_000;

/**
 * Old-generation heap cap of the parser worker. A document that makes a
 * parser balloon past it kills only the worker (ERR_WORKER_OUT_OF_MEMORY),
 * which is reported as a per-file rejection, instead of the whole server.
 */
export const DEFAULT_PARSE_WORKER_MAX_HEAP_MB = 1024;

/**
 * The `Worker` typings resolved in this workspace don't surface its
 * EventEmitter methods; at runtime `Worker` IS an EventEmitter.
 */
function events(worker: Worker): Pick<EventEmitter, 'on' | 'once' | 'off'> {
  return worker as unknown as EventEmitter;
}

/** Message sent to the parser worker. */
export interface ParseWorkerRequest {
  id: number;
  mimeType: string;
  filename: string;
  buffer: Uint8Array;
}

/** Message sent back by the parser worker. */
export type ParseWorkerResponse =
  | { id: number; ok: true; result: ParsedDocument }
  | { id: number; ok: false; errorName: string; error: string };

export interface IsolatedParserOptions {
  /** Worker script implementing the {@link ParseWorkerRequest} protocol. */
  workerUrl: URL;
  /** Per-file budget in ms. `<= 0` disables the timeout. */
  timeoutMs?: number;
  /** See {@link DEFAULT_PARSE_WORKER_MAX_HEAP_MB}. */
  maxHeapMb?: number;
  /** Observability hook, fired whenever a worker thread goes away. */
  onWorkerExit?: (info: { threadId: number; exitCode: number }) => void;
}

/** Read `CALAME_RAG_PARSE_TIMEOUT_MS`, falling back to the default on NaN. */
export function readParseTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['CALAME_RAG_PARSE_TIMEOUT_MS'];
  if (raw === undefined) return DEFAULT_PARSE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? DEFAULT_PARSE_TIMEOUT_MS : parsed;
}

/**
 * Locate the compiled parser worker. Candidates, in order:
 *  - `CALAME_RAG_PARSE_WORKER` (absolute path) when set;
 *  - `parse-worker.js` next to this module (tsc output: dist/parsers/);
 *  - `parse-worker.mjs` next to this module (the single-file server bundle
 *    inlines this module into server.mjs and ships the worker beside it —
 *    see scripts/bundle-server.mjs).
 * Returns `null` when none exists (e.g. running the TypeScript sources under
 * vitest); callers then fall back to in-process parsing.
 */
export function resolveParseWorkerUrl(env: NodeJS.ProcessEnv = process.env): URL | null {
  const override = env['CALAME_RAG_PARSE_WORKER'];
  const candidates: URL[] = [
    ...(override ? [pathToFileURL(override)] : []),
    new URL('./parse-worker.js', import.meta.url),
    new URL('./parse-worker.mjs', import.meta.url),
  ];
  for (const url of candidates) {
    if (url.protocol === 'file:' && existsSync(fileURLToPath(url))) return url;
  }
  return null;
}

/**
 * Runs document parsers in a dedicated worker thread so a single bad file
 * cannot take the sync down:
 *
 *  - **Hard timeout.** When a parse exceeds its budget the worker is
 *    `terminate()`d — V8 stops it even in the middle of a synchronous
 *    `while (true)` — and the call rejects with a `parse_timeout`
 *    {@link DocumentRejectedError} only once the thread has actually exited.
 *    A `Promise.race` alone would leave the parser burning a CPU core.
 *  - **Crash / OOM containment.** A worker crash rejects the current call
 *    with `parse_failed`; the next call transparently starts a fresh worker.
 *  - **Bounded.** One worker, one document in flight; calls are serialized.
 *    The idle worker is `unref()`d so it never keeps the process alive.
 *
 * worker_threads behave the same on Windows, macOS and Linux (no fork, no
 * signals), which is why they were chosen over a child process.
 */
export class IsolatedParser {
  readonly #workerUrl: URL;
  readonly #timeoutMs: number;
  readonly #maxHeapMb: number;
  readonly #onWorkerExit: IsolatedParserOptions['onWorkerExit'];
  #worker: Worker | null = null;
  #seq = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: IsolatedParserOptions) {
    this.#workerUrl = options.workerUrl;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
    this.#maxHeapMb = options.maxHeapMb ?? DEFAULT_PARSE_WORKER_MAX_HEAP_MB;
    this.#onWorkerExit = options.onWorkerExit;
  }

  /** Thread id of the live worker, or `null` when none is running. */
  get workerThreadId(): number | null {
    return this.#worker?.threadId ?? null;
  }

  /** Parse one document in the worker. Calls are queued, one at a time. */
  parse(mimeType: string, buffer: Buffer, filename: string): Promise<ParsedDocument> {
    const run = this.#tail.then(() => this.#run(mimeType, buffer, filename));
    // Keep the chain alive whatever the outcome of this call.
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** Stop the worker. Further `parse` calls reject. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    const worker = this.#worker;
    this.#worker = null;
    if (worker) await worker.terminate();
  }

  #spawn(): Worker {
    const worker = new Worker(this.#workerUrl, {
      resourceLimits: { maxOldGenerationSizeMb: this.#maxHeapMb },
    });
    const threadId = worker.threadId;
    events(worker).once('exit', (exitCode: number) => {
      if (this.#worker === worker) this.#worker = null;
      this.#onWorkerExit?.({ threadId, exitCode });
    });
    // Unhandled 'error' events would crash the host; per-call listeners
    // below turn them into rejections, this one just keeps the host safe.
    events(worker).on('error', () => undefined);
    worker.unref();
    return worker;
  }

  #run(mimeType: string, buffer: Buffer, filename: string): Promise<ParsedDocument> {
    if (this.#closed) return Promise.reject(new Error('IsolatedParser is closed'));
    const worker = this.#worker ?? (this.#worker = this.#spawn());
    const id = ++this.#seq;

    return new Promise<ParsedDocument>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        events(worker).off('message', onMessage);
        events(worker).off('error', onError);
        events(worker).off('exit', onExit);
        worker.unref();
        action();
      };
      // Drop the worker and wait until its thread is really gone before
      // settling, so callers never race a still-running parser.
      const discard = (err: Error): void => {
        finish(() => {
          if (this.#worker === worker) this.#worker = null;
          worker.terminate().then(
            () => reject(err),
            () => reject(err),
          );
        });
      };

      const onMessage = (msg: ParseWorkerResponse): void => {
        if (msg.id !== id) return;
        finish(() => {
          if (msg.ok) {
            resolve(msg.result);
          } else if (msg.errorName === 'UnsupportedMimeTypeError') {
            reject(new UnsupportedMimeTypeError(mimeType));
          } else {
            reject(
              new DocumentRejectedError(
                'parse_failed',
                `The file could not be parsed: ${msg.error}`,
              ),
            );
          }
        });
      };
      const onError = (err: Error): void => {
        discard(
          new DocumentRejectedError(
            'parse_failed',
            `The parser crashed on this file: ${err.message}`,
            { cause: err },
          ),
        );
      };
      const onExit = (exitCode: number): void => {
        discard(
          new DocumentRejectedError(
            'parse_failed',
            `The parser stopped unexpectedly on this file (exit code ${exitCode}).`,
          ),
        );
      };
      const timer =
        this.#timeoutMs > 0
          ? setTimeout(() => {
              discard(
                new DocumentRejectedError(
                  'parse_timeout',
                  `Parsing did not finish within ${Math.round(this.#timeoutMs / 1000)} s; the parser was stopped and the file skipped.`,
                ),
              );
            }, this.#timeoutMs)
          : undefined;

      events(worker).on('message', onMessage);
      events(worker).on('error', onError);
      events(worker).on('exit', onExit);
      worker.ref();
      const request: ParseWorkerRequest = {
        id,
        mimeType,
        filename,
        buffer: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      };
      worker.postMessage(request);
    });
  }
}
