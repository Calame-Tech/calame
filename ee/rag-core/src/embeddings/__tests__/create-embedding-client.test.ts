// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Simulates the ONNX runtime failing to load (e.g. wrong platform, missing
// native binary) — every subsequent `import('@huggingface/transformers')`
// rejects with this error. This is the isolation test: a local-provider
// failure at this layer must NOT prevent cloud providers from working.
vi.mock('@huggingface/transformers', () => {
  throw new Error('simulated onnxruntime load failure');
});

const {
  createEmbeddingClient,
  EmbeddingNotSupportedError,
  EmbeddingModelMissingError,
  OpenAiCompatibleEmbeddingClient,
} = await import('../openai-client.js');
const { LocalEmbeddingUnavailableError, LocalOnnxEmbeddingClient } =
  await import('../local-onnx-client.js');

describe('createEmbeddingClient — local provider', () => {
  it('throws LocalEmbeddingUnavailableError when no localModelsRootDir is provided', () => {
    expect(() =>
      createEmbeddingClient(
        { provider: 'local', apiKey: '', embeddingModel: 'embeddinggemma-300m-q4' },
        768,
      ),
    ).toThrow(LocalEmbeddingUnavailableError);
  });

  it('builds a LocalOnnxEmbeddingClient when localModelsRootDir is provided (no apiKey needed)', () => {
    const client = createEmbeddingClient(
      { provider: 'local', apiKey: '', embeddingModel: 'embeddinggemma-300m-q4' },
      768,
      { localModelsRootDir: '/some/models/root' },
    );
    expect(client).toBeInstanceOf(LocalOnnxEmbeddingClient);
    expect(client.dimensions).toBe(768);
    expect(client.billable).toBe(false);
  });

  it('does not require embeddingModel on the setting (unlike cloud providers)', () => {
    expect(() =>
      createEmbeddingClient({ provider: 'local', apiKey: '' }, 768, {
        localModelsRootDir: '/some/models/root',
      }),
    ).not.toThrow();
  });

  it('is isolated from an ONNX runtime load failure: cloud providers still build and work', async () => {
    // openrouter never touches the mocked module at construction time.
    const openrouterClient = createEmbeddingClient(
      { provider: 'openrouter', apiKey: 'sk-test', embeddingModel: 'text-embedding-3-small' },
      1536,
    );
    expect(openrouterClient).toBeInstanceOf(OpenAiCompatibleEmbeddingClient);

    // And it actually still embeds — proves the isolation holds at runtime,
    // not just at construction.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as typeof fetch;
    try {
      const vectors = await openrouterClient.embed(['hello']);
      expect(vectors).toEqual([[0.1, 0.2]]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Meanwhile, the local client built in the same process DOES fail when
    // used — wrapped as LocalEmbeddingUnavailableError by ensureLoaded()'s
    // own try/catch around the dynamic import (see local-onnx-client.ts).
    // (Asserting on the exact simulated message isn't reliable here: vitest
    // reports a factory that throws synchronously via its own diagnostic
    // wrapper rather than surfacing the thrown message verbatim — the load
    // failure itself, and its isolation from cloud providers, is what matters.)
    const localClient = createEmbeddingClient(
      { provider: 'local', apiKey: '', embeddingModel: 'embeddinggemma-300m-q4' },
      768,
      { localModelsRootDir: stageModelDir() },
    );
    await expect(localClient.embed(['hello'])).rejects.toThrow(/failed to load the ONNX runtime/);
    await expect(localClient.embed(['hello'])).rejects.toBeInstanceOf(
      LocalEmbeddingUnavailableError,
    );
  });
});

describe('createEmbeddingClient — existing providers unaffected', () => {
  it('anthropic still throws EmbeddingNotSupportedError', () => {
    expect(() =>
      createEmbeddingClient(
        { provider: 'anthropic', apiKey: 'x', embeddingModel: 'claude-embed' },
        1536,
      ),
    ).toThrow(EmbeddingNotSupportedError);
  });

  it('openrouter without embeddingModel still throws EmbeddingModelMissingError', () => {
    expect(() => createEmbeddingClient({ provider: 'openrouter', apiKey: 'x' }, 1536)).toThrow(
      EmbeddingModelMissingError,
    );
  });

  it('unknown provider still throws EmbeddingNotSupportedError, message lists local/openrouter/custom', () => {
    expect(() =>
      createEmbeddingClient({ provider: 'bogus', apiKey: 'x', embeddingModel: 'whatever' }, 1536),
    ).toThrow(/local, openrouter, or custom/);
  });
});

/** Stages a throwaway model directory with a valid config.json marker. */
function stageModelDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-create-client-test-'));
  const modelDir = path.join(dir, 'embeddinggemma-300m');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'config.json'), '{}');
  return dir;
}
