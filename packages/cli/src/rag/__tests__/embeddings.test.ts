import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EmbeddingClient } from '@calame-ee/rag-core';
import { CalameDatabase } from '../../database.js';
import { AiSettingsManager } from '../../ai-config.js';
import { buildEmbeddingResolvers } from '../embeddings.js';

// ---------------------------------------------------------------------------
// buildEmbeddingResolvers memoizes resolveEmbeddingClient per setting name —
// see the doc comment on `clientCache` in embeddings.ts for why this matters
// (avoids reloading a local ONNX session per document during ingestion).
// Uses a REAL AiSettingsManager backed by a temp-dir CalameDatabase (real
// migrations, real schema) rather than hand-mocked statements, and a minimal
// fake `ragCore` exposing only `createEmbeddingClient` as a spy — the actual
// client construction logic lives in ee/rag-core and is tested there.
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: CalameDatabase;
let manager: AiSettingsManager;
let createEmbeddingClient: ReturnType<typeof vi.fn>;
let fakeRagCore: { createEmbeddingClient: typeof createEmbeddingClient };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-embeddings-test-'));
  db = new CalameDatabase(tmpDir);
  manager = new AiSettingsManager(db);
  let counter = 0;
  createEmbeddingClient = vi.fn((setting: { embeddingModel?: string }) => {
    counter++;
    const client: EmbeddingClient = {
      dimensions: 1536,
      modelName: `${setting.embeddingModel ?? 'unknown'}-instance-${counter}`,
      embed: vi.fn(),
    };
    return client;
  });
  fakeRagCore = { createEmbeddingClient };
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createEmbeddingSetting(name: string, embeddingModel = 'text-embedding-3-small'): void {
  manager.createSetting({
    name,
    label: name,
    provider: 'openrouter',
    apiKey: 'sk-test',
    capabilities: ['embeddings'],
    embeddingModel,
    embeddingDimensions: 1536,
  });
}

describe('buildEmbeddingResolvers — resolveEmbeddingClient memoization', () => {
  it('returns the same client instance on repeated calls for an unchanged setting', () => {
    createEmbeddingSetting('my-setting');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fakeRagCore only implements the one method this test exercises
    const { resolveEmbeddingClient } = buildEmbeddingResolvers(fakeRagCore as any, manager);

    const first = resolveEmbeddingClient('my-setting');
    const second = resolveEmbeddingClient('my-setting');

    expect(second).toBe(first);
    expect(createEmbeddingClient).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the client after the setting is edited', () => {
    createEmbeddingSetting('my-setting', 'text-embedding-3-small');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { resolveEmbeddingClient } = buildEmbeddingResolvers(fakeRagCore as any, manager);

    const first = resolveEmbeddingClient('my-setting');
    expect(createEmbeddingClient).toHaveBeenCalledTimes(1);

    manager.updateSetting('my-setting', { embeddingModel: 'text-embedding-3-large' });

    const second = resolveEmbeddingClient('my-setting');
    expect(second).not.toBe(first);
    expect(createEmbeddingClient).toHaveBeenCalledTimes(2);
  });

  it('maintains independent cache entries per setting name', () => {
    createEmbeddingSetting('setting-a', 'model-a');
    createEmbeddingSetting('setting-b', 'model-b');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { resolveEmbeddingClient } = buildEmbeddingResolvers(fakeRagCore as any, manager);

    const a1 = resolveEmbeddingClient('setting-a');
    const b1 = resolveEmbeddingClient('setting-b');
    const a2 = resolveEmbeddingClient('setting-a');
    const b2 = resolveEmbeddingClient('setting-b');

    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
    expect(a1).not.toBe(b1);
    expect(createEmbeddingClient).toHaveBeenCalledTimes(2);
  });

  it('does not memoize across an unrelated setting update (only the edited one is invalidated)', () => {
    createEmbeddingSetting('setting-a', 'model-a');
    createEmbeddingSetting('setting-b', 'model-b');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { resolveEmbeddingClient } = buildEmbeddingResolvers(fakeRagCore as any, manager);

    const a1 = resolveEmbeddingClient('setting-a');
    resolveEmbeddingClient('setting-b');
    manager.updateSetting('setting-b', { embeddingModel: 'model-b-v2' });

    const a2 = resolveEmbeddingClient('setting-a');
    expect(a2).toBe(a1); // untouched setting keeps its cached client
    expect(createEmbeddingClient).toHaveBeenCalledTimes(2); // only a + original b, not the re-fetched a
  });
});
