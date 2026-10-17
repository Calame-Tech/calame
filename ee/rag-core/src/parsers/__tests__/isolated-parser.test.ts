// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { IsolatedParser, readParseTimeoutMs, resolveParseWorkerUrl } from '../isolated-parser.js';
import { DocumentRejectedError } from '../../pipeline/document-errors.js';

const FAKE_WORKER = new URL('./fixtures/fake-parse-worker.mjs', import.meta.url);
// Compiled real worker (present after `pnpm build`, which CI runs first).
const DIST_WORKER = new URL('../../../dist/parsers/parse-worker.js', import.meta.url);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('IsolatedParser', () => {
  let parser: IsolatedParser | null = null;
  afterEach(async () => {
    await parser?.close();
    parser = null;
  });

  it('returns the parsed document and reuses one worker across calls', async () => {
    parser = new IsolatedParser({ workerUrl: FAKE_WORKER, timeoutMs: 5_000 });
    const a = await parser.parse('text/plain', Buffer.from('hello'), 'a.txt');
    const firstThread = parser.workerThreadId;
    const b = await parser.parse('text/plain', Buffer.from('world'), 'b.txt');
    expect(a.text).toBe('hello');
    expect(b.text).toBe('world');
    expect(firstThread).not.toBeNull();
    expect(parser.workerThreadId).toBe(firstThread);
  });

  it('turns a throwing parser into a parse_failed rejection and keeps the worker', async () => {
    parser = new IsolatedParser({ workerUrl: FAKE_WORKER, timeoutMs: 5_000 });
    await parser.parse('text/plain', Buffer.from('ok'), 'ok.txt');
    const thread = parser.workerThreadId;
    const err = await parser.parse('text/plain', Buffer.from('x'), 'throw.docx').catch((e) => e);
    expect(err).toBeInstanceOf(DocumentRejectedError);
    expect((err as DocumentRejectedError).kind).toBe('parse_failed');
    expect((err as Error).message).toContain('boom from parser');
    expect(parser.workerThreadId).toBe(thread);
  });

  it('hard-stops a parser stuck in a synchronous loop and recovers', async () => {
    const exits: Array<{ threadId: number; exitCode: number }> = [];
    parser = new IsolatedParser({
      workerUrl: FAKE_WORKER,
      timeoutMs: 300,
      onWorkerExit: (info) => exits.push(info),
    });
    await parser.parse('text/plain', Buffer.from('warm-up'), 'warm.txt');
    const stuckThread = parser.workerThreadId;

    const started = Date.now();
    const err = await parser.parse('text/plain', Buffer.from('x'), 'loop.docx').catch((e) => e);
    expect(err).toBeInstanceOf(DocumentRejectedError);
    expect((err as DocumentRejectedError).kind).toBe('parse_timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
    // The stuck thread has really exited (not merely been abandoned)...
    expect(exits.map((e) => e.threadId)).toContain(stuckThread);
    expect(parser.workerThreadId).toBeNull();

    // ...and the next document is parsed by a fresh worker.
    const next = await parser.parse('text/plain', Buffer.from('after'), 'after.txt');
    expect(next.text).toBe('after');
    expect(parser.workerThreadId).not.toBe(stuckThread);
  });

  it('reports a worker crash as parse_failed and recovers', async () => {
    parser = new IsolatedParser({ workerUrl: FAKE_WORKER, timeoutMs: 5_000 });
    const err = await parser.parse('text/plain', Buffer.from('x'), 'crash.docx').catch((e) => e);
    expect(err).toBeInstanceOf(DocumentRejectedError);
    expect((err as DocumentRejectedError).kind).toBe('parse_failed');
    const next = await parser.parse('text/plain', Buffer.from('fine'), 'fine.txt');
    expect(next.text).toBe('fine');
  });

  it('close() terminates the worker', async () => {
    const exits: number[] = [];
    parser = new IsolatedParser({
      workerUrl: FAKE_WORKER,
      onWorkerExit: (info) => exits.push(info.threadId),
    });
    await parser.parse('text/plain', Buffer.from('x'), 'x.txt');
    const thread = parser.workerThreadId;
    await parser.close();
    expect(exits).toContain(thread);
    await expect(parser.parse('text/plain', Buffer.from('x'), 'x.txt')).rejects.toThrow(/closed/);
  });

  it.skipIf(!existsSync(fileURLToPath(DIST_WORKER)))(
    'real parser worker: a corrupt DOCX is rejected, a valid text file still parses',
    async () => {
      parser = new IsolatedParser({ workerUrl: DIST_WORKER, timeoutMs: 30_000 });
      const corrupt = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64, 7)]);
      const err = await parser.parse(DOCX_MIME, corrupt, 'Rapport.docx').catch((e) => e);
      expect(err).toBeInstanceOf(DocumentRejectedError);
      expect((err as DocumentRejectedError).kind).toBe('parse_failed');
      const ok = await parser.parse('text/plain', Buffer.from('plain text'), 'notes.txt');
      expect(ok.text).toBe('plain text');
    },
  );
});

describe('parser worker configuration', () => {
  it('reads CALAME_RAG_PARSE_TIMEOUT_MS with a 120 s default', () => {
    expect(readParseTimeoutMs({})).toBe(120_000);
    expect(readParseTimeoutMs({ CALAME_RAG_PARSE_TIMEOUT_MS: '5000' })).toBe(5_000);
    expect(readParseTimeoutMs({ CALAME_RAG_PARSE_TIMEOUT_MS: 'abc' })).toBe(120_000);
  });

  it('honours CALAME_RAG_PARSE_WORKER when the file exists', () => {
    const path = fileURLToPath(FAKE_WORKER);
    expect(resolveParseWorkerUrl({ CALAME_RAG_PARSE_WORKER: path })?.href).toBe(FAKE_WORKER.href);
  });
});
