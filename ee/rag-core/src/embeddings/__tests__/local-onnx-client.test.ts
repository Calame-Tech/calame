// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mocked BEFORE importing the module under test — hoisted by vitest, so this
// must stay at module scope, not inside a beforeEach.
const tokenizerMock = vi.fn();
const modelMock = vi.fn();
const fromPretrainedTokenizer = vi.fn(async () => tokenizerMock);
const fromPretrainedModel = vi.fn(async () => modelMock);

vi.mock('@huggingface/transformers', () => ({
  env: { allowRemoteModels: true, allowLocalModels: false, localModelPath: '' },
  AutoTokenizer: { from_pretrained: fromPretrainedTokenizer },
  AutoModel: { from_pretrained: fromPretrainedModel },
}));

// vi.mock() calls above are hoisted above this import by vitest, so the
// mocked module is what local-onnx-client.ts's dynamic `import(...)` resolves to.
const { LocalOnnxEmbeddingClient, LocalEmbeddingUnavailableError, EMBEDDING_GEMMA_PREFIXES } =
  await import('../local-onnx-client.js');

const DIMS = 4; // small, arbitrary — irrelevant to what's being tested here

/** A fake tokenizer call: returns dims reflecting [batchLen, seqLen]. Records every call. */
function makeTokenizerImpl(seqLen: number) {
  return vi.fn(async (texts: string[]) => ({
    input_ids: { dims: [texts.length, seqLen] },
    texts, // stashed for assertions
  }));
}

/** A fake model call: returns a `sentence_embedding` tensor of shape [n, DIMS]. */
function makeModelImpl(dims = DIMS) {
  return vi.fn(async (inputs: { texts: string[] }) => {
    const n = inputs.texts.length;
    const data = new Float32Array(n * dims);
    for (let i = 0; i < n * dims; i++) data[i] = 1; // unit-length after normalize below is not guaranteed; fine, client normalizes
    return { sentence_embedding: { dims: [n, dims], data } };
  });
}

let tmpModelsRoot: string;
const MODEL_FOLDER = 'embeddinggemma-300m';

function stageValidModelDir(): void {
  const dir = path.join(tmpModelsRoot, MODEL_FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
}

function makeClient() {
  return new LocalOnnxEmbeddingClient({
    modelsRootDir: tmpModelsRoot,
    modelFolderName: MODEL_FOLDER,
    dtype: 'q4',
    dimensions: DIMS,
    maxTokens: 2048,
    modelName: 'embeddinggemma-300m-q4',
    batchSize: 2,
  });
}

beforeEach(() => {
  tmpModelsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-local-embed-test-'));
  fromPretrainedTokenizer.mockClear();
  fromPretrainedModel.mockClear();
  tokenizerMock.mockReset();
  modelMock.mockReset();
  tokenizerMock.mockImplementation(makeTokenizerImpl(10));
  modelMock.mockImplementation(makeModelImpl());
});

afterEach(() => {
  fs.rmSync(tmpModelsRoot, { recursive: true, force: true });
});

describe('LocalOnnxEmbeddingClient', () => {
  it('is never billable', () => {
    stageValidModelDir();
    const client = makeClient();
    expect(client.billable).toBe(false);
  });

  it('throws LocalEmbeddingUnavailableError when the model directory is missing', async () => {
    // deliberately do NOT stage the model dir
    const client = makeClient();
    await expect(client.embed(['hello'])).rejects.toBeInstanceOf(LocalEmbeddingUnavailableError);
  });

  it('applies the document prefix on embed() and the query prefix on embedQuery()', async () => {
    stageValidModelDir();
    const client = makeClient();

    await client.embed(['hello world']);
    const docCallTexts = tokenizerMock.mock.calls[0]?.[0] as string[];
    expect(docCallTexts).toEqual([`${EMBEDDING_GEMMA_PREFIXES.document}hello world`]);

    await client.embedQuery(['find me']);
    const queryCallTexts = tokenizerMock.mock.calls[1]?.[0] as string[];
    expect(queryCallTexts).toEqual([`${EMBEDDING_GEMMA_PREFIXES.query}find me`]);
  });

  it('splits input into batches of the configured batchSize', async () => {
    stageValidModelDir();
    const client = makeClient(); // batchSize: 2
    await client.embed(['a', 'b', 'c', 'd', 'e']);
    // 5 texts / batchSize 2 -> 3 calls: [a,b], [c,d], [e]
    expect(tokenizerMock).toHaveBeenCalledTimes(3);
    expect((tokenizerMock.mock.calls[0]?.[0] as string[]).length).toBe(2);
    expect((tokenizerMock.mock.calls[1]?.[0] as string[]).length).toBe(2);
    expect((tokenizerMock.mock.calls[2]?.[0] as string[]).length).toBe(1);
  });

  it('loads the model exactly once across many embed()/embedQuery() calls', async () => {
    stageValidModelDir();
    const client = makeClient();
    await client.embed(['a']);
    await client.embedQuery(['b']);
    await client.embed(['c', 'd']);
    expect(fromPretrainedTokenizer).toHaveBeenCalledTimes(1);
    expect(fromPretrainedModel).toHaveBeenCalledTimes(1);
  });

  it('never overlaps two model() calls in flight (serialized inference)', async () => {
    stageValidModelDir();
    let inFlight = 0;
    let maxInFlight = 0;
    modelMock.mockImplementation(async (inputs: { texts: string[] }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      const n = inputs.texts.length;
      return { sentence_embedding: { dims: [n, DIMS], data: new Float32Array(n * DIMS).fill(1) } };
    });

    const client = makeClient(); // batchSize: 2
    await Promise.all([
      client.embed(['a', 'b', 'c', 'd']), // 2 internal batches
      client.embedQuery(['e', 'f']), // 1 internal batch
    ]);
    expect(maxInFlight).toBe(1);
  });

  it('throws a clear error when the actual output dimension does not match the configured one', async () => {
    stageValidModelDir();
    modelMock.mockImplementation(async () => ({
      sentence_embedding: { dims: [1, DIMS + 1], data: new Float32Array(DIMS + 1).fill(1) },
    }));
    const client = makeClient();
    await expect(client.embed(['hello'])).rejects.toThrow(/expected \d+ dimensions/);
  });

  it('throws a clear error when the model output has no sentence_embedding tensor', async () => {
    stageValidModelDir();
    modelMock.mockImplementation(async () => ({ last_hidden_state: {} }));
    const client = makeClient();
    await expect(client.embed(['hello'])).rejects.toThrow(/sentence_embedding/);
  });

  it('L2-normalizes the returned vectors', async () => {
    stageValidModelDir();
    modelMock.mockImplementation(async () => ({
      sentence_embedding: { dims: [1, DIMS], data: new Float32Array([3, 4, 0, 0]) }, // norm=5
    }));
    const client = makeClient();
    const [vec] = await client.embed(['hello']);
    expect(vec).toBeDefined();
    const norm = Math.sqrt(vec!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(vec).toEqual([0.6, 0.8, 0, 0]);
  });

  it('constructor rejects fp16 and q4f16 dtypes', () => {
    stageValidModelDir();
    expect(
      () =>
        new LocalOnnxEmbeddingClient({
          modelsRootDir: tmpModelsRoot,
          modelFolderName: MODEL_FOLDER,
          // @ts-expect-error -- deliberately passing a forbidden dtype to verify the runtime guard
          dtype: 'fp16',
          dimensions: DIMS,
          maxTokens: 2048,
          modelName: 'x',
        }),
    ).toThrow(/fp16/);
  });

  it('recovers from a transient load failure on the next call (does not cache a permanent rejection)', async () => {
    // First attempt: model dir missing -> rejects.
    const client = makeClient();
    await expect(client.embed(['a'])).rejects.toBeInstanceOf(LocalEmbeddingUnavailableError);

    // Stage the dir, retry -> should succeed now instead of replaying the cached failure.
    stageValidModelDir();
    const [vec] = await client.embed(['a']);
    expect(vec).toHaveLength(DIMS);
  });
});
