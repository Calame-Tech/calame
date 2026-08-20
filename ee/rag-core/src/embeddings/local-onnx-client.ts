// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import fs from 'node:fs';
import path from 'node:path';
import type { EmbeddingClient } from '../types.js';

/**
 * EmbeddingGemma's task-specific prompt prefixes. The model was trained with
 * these EXACT strings prepended to the input — omitting them (or swapping
 * which one goes where) badly degrades retrieval quality. This is the most
 * common real-world misuse of this model (see the public "bad quality"
 * reports investigated before writing this client).
 *
 * Versioning: any change to these strings changes the embedding space of
 * every already-indexed local chunk. Treat it like a model swap — bump
 * LOCAL_EMBEDDING_MODEL_ID in packages/cli/src/rag/local-embedding-meta.ts
 * (e.g. to `embeddinggemma-300m-q4-v2`) so the dimension/version bookkeeping
 * forces a re-index rather than silently mixing old and new vectors.
 */
export const EMBEDDING_GEMMA_PREFIXES = {
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
} as const;

/** Thrown when the local model directory is missing, incomplete, or fails to load. */
export class LocalEmbeddingUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `Local embedding model unavailable: ${reason} ` +
        `Run "pnpm model:fetch" to download it, or set CALAME_LOCAL_EMBEDDING_MODEL_DIR ` +
        `to a directory containing it.`,
    );
    this.name = 'LocalEmbeddingUnavailableError';
  }
}

export interface LocalOnnxEmbeddingClientOptions {
  /** Root directory containing `<modelFolderName>/config.json` etc. — becomes `env.localModelPath`. */
  modelsRootDir: string;
  /** Model folder name under `modelsRootDir` (e.g. `embeddinggemma-300m`). */
  modelFolderName: string;
  /** ONNX quantization variant to load. NEVER 'fp16' or 'q4f16' — EmbeddingGemma's activations don't support fp16. */
  dtype: 'q4' | 'q8' | 'fp32';
  dimensions: number;
  maxTokens: number;
  modelName: string;
  /**
   * Number of texts embedded per `model()` call. Memory-bound, not network-
   * bound (unlike OpenAiCompatibleEmbeddingClient's 96) — throughput measured
   * flat at ~18-26 chunks/s across batch sizes 1-32 in testing, so this
   * mainly bounds padding waste, peak RSS, and progress-reporting
   * granularity rather than buying real speed. Defaults to 8.
   */
  batchSize?: number;
  /**
   * Called at most once per process when a batch is truncated to `maxTokens`.
   * No default logging inside rag-core (see the rest of this package — no
   * client code calls console.*); wire this to the host's logger if desired.
   */
  onTruncation?: () => void;
}

interface LoadedModel {
  tokenizer: TokenizerLike;
  model: ModelLike;
}

/**
 * Minimal shape of `@huggingface/transformers`'s PreTrainedTokenizer/
 * PreTrainedModel that this client relies on. Kept narrow (rather than
 * importing the library's own types at the top level) so nothing outside
 * `ensureLoaded()` forces the ONNX runtime to load — see the isolation note
 * there.
 */
interface TokenizerCallResult {
  input_ids: { dims: number[] };
  [key: string]: unknown;
}
type TokenizerLike = (
  texts: string[],
  options: { padding: boolean; truncation: boolean; max_length: number },
) => Promise<TokenizerCallResult>;
interface ModelOutput {
  sentence_embedding?: { dims: number[]; data: ArrayLike<number> };
  [key: string]: unknown;
}
type ModelLike = (inputs: TokenizerCallResult) => Promise<ModelOutput>;

function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0 || !Number.isFinite(norm)) return vec;
  return vec.map((x) => x / norm);
}

/**
 * Embedding client backed by a bundled local ONNX model (EmbeddingGemma-300M
 * by default), run via `@huggingface/transformers`. No network calls, no API
 * key — this is Calame's default embedding provider precisely so RAG works
 * without either.
 *
 * Two things every future change to this file must preserve, both verified
 * empirically before this client was written (cosine=1.00000 against an
 * independent Python/onnxruntime run of the same ONNX graph):
 *  1. Read the `sentence_embedding` output tensor directly. Do NOT mean-pool
 *     `last_hidden_state` — the SentenceTransformer Dense head (768→3072→768)
 *     and normalization are baked into the graph; mean-pooling skips the
 *     Dense head and silently produces degraded vectors.
 *  2. Apply {@link EMBEDDING_GEMMA_PREFIXES} — `embed()` uses the document
 *     prefix, `embedQuery()` the query prefix. Never swap them.
 */
export class LocalOnnxEmbeddingClient implements EmbeddingClient {
  readonly dimensions: number;
  readonly modelName: string;
  readonly billable = false;

  private readonly modelsRootDir: string;
  private readonly modelFolderName: string;
  private readonly dtype: 'q4' | 'q8' | 'fp32';
  private readonly maxTokens: number;
  private readonly batchSize: number;
  private readonly onTruncation: (() => void) | undefined;
  private warnedTruncation = false;

  private loadPromise: Promise<LoadedModel> | null = null;
  /** Serializes inference: one `model()` call in flight per process at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: LocalOnnxEmbeddingClientOptions) {
    if (opts.dtype === ('fp16' as string) || opts.dtype === ('q4f16' as string)) {
      throw new Error(
        `LocalOnnxEmbeddingClient: dtype "${opts.dtype}" is not supported — ` +
          `EmbeddingGemma's activations do not support fp16. Use 'q4', 'q8', or 'fp32'.`,
      );
    }
    this.modelsRootDir = opts.modelsRootDir;
    this.modelFolderName = opts.modelFolderName;
    this.dtype = opts.dtype;
    this.dimensions = opts.dimensions;
    this.maxTokens = opts.maxTokens;
    this.modelName = opts.modelName;
    this.batchSize = opts.batchSize ?? 8;
    this.onTruncation = opts.onTruncation;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.embedWithPrefix(texts, EMBEDDING_GEMMA_PREFIXES.document);
  }

  async embedQuery(texts: string[]): Promise<number[][]> {
    return this.embedWithPrefix(texts, EMBEDDING_GEMMA_PREFIXES.query);
  }

  /** Loads the tokenizer + model on first use and re-runs the forward pass once as a warmup. */
  async warmup(): Promise<void> {
    await this.ensureLoaded();
    await this.embed(['warmup']);
  }

  private async embedWithPrefix(texts: string[], prefix: string): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.enqueue(() => this.embedBatch(batch, prefix));
      out.push(...vectors);
    }
    return out;
  }

  /** Runs `task` after every previously-enqueued task settles, one at a time. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    // Keep the chain alive regardless of outcome so one failed batch doesn't
    // wedge every subsequent embed() call behind a permanently-rejected queue.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async embedBatch(batch: string[], prefix: string): Promise<number[][]> {
    const { tokenizer, model } = await this.ensureLoaded();
    const prefixed = batch.map((t) => prefix + t);
    const inputs = await tokenizer(prefixed, {
      padding: true,
      truncation: true,
      max_length: this.maxTokens,
    });

    if (!this.warnedTruncation) {
      const seqLen = inputs.input_ids.dims[1] ?? 0;
      if (seqLen >= this.maxTokens) {
        this.warnedTruncation = true;
        this.onTruncation?.();
      }
    }

    const output = await model(inputs);
    const tensor = output.sentence_embedding;
    if (!tensor) {
      throw new Error(
        `LocalOnnxEmbeddingClient: model output has no "sentence_embedding" tensor ` +
          `(keys: ${Object.keys(output).join(', ')}). This ONNX export does not match the ` +
          `expected EmbeddingGemma graph — do not fall back to mean-pooling last_hidden_state, ` +
          `fix the model export instead (see the class doc comment for why).`,
      );
    }
    const [n, dims] = tensor.dims;
    if (n === undefined || dims === undefined) {
      throw new Error(
        `LocalOnnxEmbeddingClient: unexpected sentence_embedding dims ${tensor.dims}`,
      );
    }
    if (dims !== this.dimensions) {
      throw new Error(
        `LocalOnnxEmbeddingClient: expected ${this.dimensions} dimensions, got ${dims}. ` +
          `Model files under ${this.modelFolderName} may not match the configured dimension.`,
      );
    }
    const data = tensor.data;
    const vectors: number[][] = [];
    for (let row = 0; row < n; row++) {
      const vec: number[] = [];
      for (let col = 0; col < dims; col++) vec.push(data[row * dims + col] as number);
      // Defensive: the graph already outputs unit-norm vectors (verified
      // empirically), but normalizing here makes that a guaranteed contract
      // of this client rather than an incidental property of one export.
      vectors.push(l2Normalize(vec));
    }
    return vectors;
  }

  private async ensureLoaded(): Promise<LoadedModel> {
    if (!this.loadPromise) {
      this.loadPromise = this.load().catch((err: unknown) => {
        // Don't cache a permanent failure — a transient issue (e.g. the
        // model dir mounted mid-boot) shouldn't wedge the client forever.
        this.loadPromise = null;
        throw err;
      });
    }
    return this.loadPromise;
  }

  private async load(): Promise<LoadedModel> {
    const configPath = path.join(this.modelsRootDir, this.modelFolderName, 'config.json');
    if (!fs.existsSync(configPath)) {
      throw new LocalEmbeddingUnavailableError(`expected ${configPath} to exist but it does not.`);
    }

    // Isolated on purpose: packages/cli/src/rag/bootstrap.ts wraps the whole
    // rag-core import in a try/catch that disables ALL of RAG on failure. A
    // top-level `import '@huggingface/transformers'` here would mean an ONNX
    // runtime load failure (missing native binary, wrong platform, ...) takes
    // cloud-provider RAG down with it. Importing lazily, inside this
    // class-local try, means a failure here only makes THIS client
    // unavailable — createEmbeddingClient's other branches are unaffected.
    let transformers: typeof import('@huggingface/transformers');
    try {
      transformers = await import('@huggingface/transformers');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LocalEmbeddingUnavailableError(`failed to load the ONNX runtime: ${msg}`);
    }

    const { env, AutoTokenizer, AutoModel } = transformers;
    // Global settings on the shared `env` singleton — @huggingface/transformers
    // is only ever consumed from this file, so there's no other code path
    // that could race these against different values.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = this.modelsRootDir;

    const tokenizer = await AutoTokenizer.from_pretrained(this.modelFolderName);
    const model = await AutoModel.from_pretrained(this.modelFolderName, {
      dtype: this.dtype,
      device: 'cpu',
    });

    return {
      tokenizer: tokenizer as unknown as TokenizerLike,
      model: model as unknown as ModelLike,
    };
  }
}
