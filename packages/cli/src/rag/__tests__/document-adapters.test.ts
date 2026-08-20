import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ragCore from '@calame-ee/rag-core';
import { CalameDatabase } from '../../database.js';
import { buildDocumentAdapterDeps } from '../document-adapters.js';
import type { AiSettingsManager } from '../../ai-config.js';

// ---------------------------------------------------------------------------
// listSources() — documentCount vs indexedDocumentCount
//
// A document row is created by sync as soon as a file is DISCOVERED —
// independent of whether the pipeline could actually chunk it (e.g. an
// image with no OCR/captioning support is discovered, counted, and left
// with zero rag_chunks rows). Without a separate indexed count, an agent
// sees "6 documents", finds content for only 3 via rag_search, and has no
// way to tell "3 of these were never indexable" from "I'm missing access".
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: CalameDatabase;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-document-adapters-test-'));
  db = new CalameDatabase(tmpDir);
  // The host's own migrations (run by the CalameDatabase constructor) don't
  // cover rag_sources/rag_documents/rag_chunks — those are versioned
  // separately (see rag-runtime.ts) and must be applied explicitly.
  ragCore.runRagMigrations({ raw: db.raw });
  // Rerank composition eagerly resolves a Cohere setting at construction
  // time (see document-adapters.ts) — turn it off so a stub AiSettingsManager
  // never needs to behave like a real one for these storage-only tests.
  process.env['CALAME_RAG_RERANK'] = 'off';
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['CALAME_RAG_RERANK'];
});

function buildDeps() {
  return buildDocumentAdapterDeps({
    db,
    ragCore,
    vectorStore: {
      upsert: () => {},
      search: () => [],
      delete: () => {},
      deleteByDocument: () => {},
    },
    resolveEmbeddingClient: () => {
      throw new Error('not exercised by these tests');
    },
    resolveConnector: () => null,
    aiSettingsManager: {} as AiSettingsManager,
    rateLimiter: new ragCore.RateLimiter(),
    log: { info: () => {}, warn: () => {} },
  });
}

function insertSource(id: string, name: string): void {
  db.raw
    .prepare(
      `INSERT INTO rag_sources
       (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
        embedding_dimensions, created_at, updated_at)
       VALUES (?, ?, 'local', '{}', 'mock-setting', 'mock-1', 3, datetime('now'), datetime('now'))`,
    )
    .run(id, name);
}

function insertDocument(id: string, sourceId: string, name: string): void {
  db.raw
    .prepare(
      `INSERT INTO rag_documents
       (id, source_id, folder_id, path, name, mime_type, size, hash, etag, last_indexed_at, deleted_at)
       VALUES (?, ?, NULL, ?, ?, 'image/png', 10, ?, NULL, datetime('now'), NULL)`,
    )
    .run(id, sourceId, name, name, 'hash-' + id);
}

function insertChunk(id: string, documentId: string): void {
  db.raw
    .prepare(
      `INSERT INTO rag_chunks (id, document_id, position, text, token_count, embedding_dimensions, created_at)
       VALUES (?, ?, 0, 'some chunk text', 3, 3, datetime('now'))`,
    )
    .run(id, documentId);
}

describe('buildDocumentAdapterDeps — storage.listSources()', () => {
  it('documentCount and indexedDocumentCount are equal when every document has chunks', async () => {
    insertSource('src-1', 'KB');
    insertDocument('doc-1', 'src-1', 'a.txt');
    insertDocument('doc-2', 'src-1', 'b.txt');
    insertChunk('chunk-1', 'doc-1');
    insertChunk('chunk-2', 'doc-2');

    const deps = buildDeps();
    const sources = await deps.storage.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.documentCount).toBe(2);
    expect(sources[0]!.indexedDocumentCount).toBe(2);
  });

  it('reproduces the reported case: 6 documents discovered, only 3 actually indexed (e.g. unsupported image type)', async () => {
    insertSource('src-1', 'TestCalamePost');
    // 3 real documents that got chunked.
    insertDocument('doc-txt', 'src-1', 'post.txt');
    insertDocument('doc-html', 'src-1', 'carrousel.html');
    insertDocument('doc-pdf', 'src-1', 'Carrousel LinkedIn Calame 0.5.pdf');
    insertChunk('chunk-txt', 'doc-txt');
    insertChunk('chunk-html', 'doc-html');
    insertChunk('chunk-pdf', 'doc-pdf');
    // 3 PNGs — discovered by sync but never chunked (no OCR/captioning).
    insertDocument('doc-png-1', 'src-1', 'dashboard.png');
    insertDocument('doc-png-2', 'src-1', 'graph.png');
    insertDocument('doc-png-3', 'src-1', 'matrix.png');

    const deps = buildDeps();
    const sources = await deps.storage.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.documentCount).toBe(6);
    expect(sources[0]!.indexedDocumentCount).toBe(3);
  });

  it('a document with more than one chunk is still counted once in indexedDocumentCount', async () => {
    insertSource('src-1', 'KB');
    insertDocument('doc-1', 'src-1', 'big.txt');
    insertChunk('chunk-1', 'doc-1');
    insertChunk('chunk-2', 'doc-1');
    insertChunk('chunk-3', 'doc-1');

    const deps = buildDeps();
    const sources = await deps.storage.listSources();
    expect(sources[0]!.documentCount).toBe(1);
    expect(sources[0]!.indexedDocumentCount).toBe(1);
  });

  it('a soft-deleted document is excluded from both counts', async () => {
    insertSource('src-1', 'KB');
    insertDocument('doc-1', 'src-1', 'a.txt');
    insertChunk('chunk-1', 'doc-1');
    db.raw
      .prepare(`UPDATE rag_documents SET deleted_at = datetime('now') WHERE id = ?`)
      .run('doc-1');

    const deps = buildDeps();
    const sources = await deps.storage.listSources();
    expect(sources[0]!.documentCount).toBe(0);
    expect(sources[0]!.indexedDocumentCount).toBe(0);
  });
});
