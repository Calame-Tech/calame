// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

// Per-phase instrumentation used by the sync benchmark (scripts/rag-sync-bench).

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import { runRagMigrations } from '../../storage/schema.js';
import { IngestionPipeline } from '../ingest.js';
import { timePhase, timePhaseSync, type SyncPhase } from '../phase-timings.js';
import type { EmbeddingClient, RagSource, VectorStore } from '../../types.js';

const SOURCE: RagSource = {
  id: 'src-timing',
  name: 'Timing source',
  type: 'local',
  configEncrypted: '{}',
  embeddingSettingName: 'stub',
  embeddingModelVersion: 'stub',
  tenantId: 'default',
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const client: EmbeddingClient = {
  dimensions: 4,
  modelName: 'stub',
  embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
};

const vectorStore: VectorStore = {
  upsert: vi.fn(),
  search: vi.fn(() => []),
  delete: vi.fn(),
  deleteByDocument: vi.fn(),
};

function makePipeline(phases: SyncPhase[]): IngestionPipeline {
  const db = new Database(':memory:');
  runRagMigrations({ raw: db });
  db.prepare(
    `INSERT INTO rag_sources
		 (id, name, type, config_encrypted, embedding_setting_name, embedding_model_version,
		  embedding_dimensions, created_at, updated_at)
		 VALUES (?, ?, 'local', '{}', 'stub', 'stub', 4, ?, ?)`,
  ).run(SOURCE.id, SOURCE.name, SOURCE.createdAt, SOURCE.updatedAt);
  return new IngestionPipeline({
    db,
    vectorStore,
    embeddingClient: client,
    onPhaseTiming: (phase, ms) => {
      expect(ms).toBeGreaterThanOrEqual(0);
      phases.push(phase);
    },
  });
}

describe('phase timings', () => {
  it('reports every pipeline phase for a new document, only `hash` when unchanged', async () => {
    const phases: SyncPhase[] = [];
    const pipeline = makePipeline(phases);
    const input = {
      source: SOURCE,
      folder: null,
      path: 'a.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Title\n\nSome body text that is long enough to be chunked.'),
      etag: 'e1',
    };
    await pipeline.ingestDocument(input);
    expect(phases).toEqual(['hash', 'parse', 'chunk', 'embed', 'write']);

    phases.length = 0;
    await pipeline.ingestDocument({ ...input, etag: 'e2' });
    expect(phases).toEqual(['hash']);
  });

  it('reports the duration of a phase that throws, then rethrows', async () => {
    const sink = vi.fn();
    await expect(timePhase(sink, 'parse', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(() =>
      timePhaseSync(sink, 'write', () => {
        throw new Error('disk');
      }),
    ).toThrow('disk');
    expect(sink.mock.calls.map((c) => c[0])).toEqual(['parse', 'write']);
  });

  it('is a plain pass-through without a sink', async () => {
    await expect(timePhase(undefined, 'embed', () => 42)).resolves.toBe(42);
    expect(timePhaseSync(undefined, 'chunk', () => 'x')).toBe('x');
  });
});
