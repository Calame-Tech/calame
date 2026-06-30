// Embedding-setting resolution and the Cohere reranker factory. Extracted from
// `rag-runtime.ts` so the AI-setting → (model, dim) / EmbeddingClient mapping
// and the rerank-capability lookup live alongside each other.

import type { EmbeddingClient, ResolvedEmbeddingSetting, RateLimiter } from '@calame-ee/rag-core';
import type { AiSettingsManager } from '../ai-config.js';
import { settingSupports } from '../ai-config.js';
import type { RagLogger } from './types.js';

/** The pair of resolvers the runtime exposes for embedding settings. */
export interface EmbeddingResolvers {
  /** Resolves an AI setting name to its concrete (model, dim) pair. */
  resolveEmbeddingSetting: (settingName: string) => ResolvedEmbeddingSetting;
  /** Resolves an AI setting name to a fully-built EmbeddingClient. */
  resolveEmbeddingClient: (settingName: string) => EmbeddingClient;
}

/**
 * Build the `resolveEmbeddingSetting` / `resolveEmbeddingClient` pair over the
 * AI settings manager. Both throw with an actionable message when the named
 * setting is missing, lacks the `embeddings` capability, or was saved before
 * embedding-dimension auto-detection.
 */
export function buildEmbeddingResolvers(
  ragCore: typeof import('@calame-ee/rag-core'),
  aiSettingsManager: AiSettingsManager,
): EmbeddingResolvers {
  // Resolver: AI setting name → (embeddingModel, dimensions).
  const resolveEmbeddingSetting = (settingName: string): ResolvedEmbeddingSetting => {
    const setting = aiSettingsManager.getSetting(settingName);
    if (!setting) {
      throw new Error(`AI setting "${settingName}" not found.`);
    }
    if (!settingSupports(setting, 'embeddings')) {
      throw new Error(
        `AI setting "${settingName}" does not advertise the "embeddings" capability. ` +
          `Edit the setting and enable embeddings (with a model selected) before referencing it from a RAG source.`,
      );
    }
    if (!setting.embeddingModel) {
      throw new Error(
        `AI setting "${settingName}" has the "embeddings" capability but no embeddingModel.`,
      );
    }
    if (setting.embeddingDimensions === undefined) {
      throw new Error(
        `AI setting "${settingName}" was saved before embedding-dimension auto-detection. ` +
          `Re-save the setting in the UI to probe and cache the dimension.`,
      );
    }
    return { embeddingModel: setting.embeddingModel, dimensions: setting.embeddingDimensions };
  };

  const resolveEmbeddingClient = (settingName: string): EmbeddingClient => {
    const setting = aiSettingsManager.getSetting(settingName);
    if (!setting) {
      throw new Error(`AI setting "${settingName}" not found.`);
    }
    if (!settingSupports(setting, 'embeddings')) {
      throw new Error(
        `AI setting "${settingName}" does not advertise the "embeddings" capability.`,
      );
    }
    const { dimensions } = resolveEmbeddingSetting(settingName);
    return ragCore.createEmbeddingClient(
      {
        provider: setting.provider,
        apiKey: setting.apiKey,
        baseUrl: setting.baseUrl,
        embeddingModel: setting.embeddingModel,
      },
      dimensions,
    );
  };

  return { resolveEmbeddingSetting, resolveEmbeddingClient };
}

/**
 * Pick the first AI setting that advertises embeddings and resolves cleanly to
 * a known embedding model. Returns `null` when none is available.
 */
export function pickDefaultEmbeddingClient(
  aiSettingsManager: AiSettingsManager,
  resolveEmbeddingClient: (settingName: string) => EmbeddingClient,
  log: { warn: (msg: string) => void },
): EmbeddingClient | null {
  const settings = aiSettingsManager.listSettings();
  for (const setting of settings) {
    if (!settingSupports(setting, 'embeddings')) continue;
    try {
      return resolveEmbeddingClient(setting.name);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Skipping AI setting "${setting.name}" for default embeddings: ${msg}`);
    }
  }
  return null;
}

/**
 * Stub client used only when no AI setting is configured. Throws on any call so
 * callers see a clear error instead of silently producing zero vectors.
 */
export function makeUnconfiguredEmbeddingClient(dimensions: number): EmbeddingClient {
  return {
    dimensions,
    modelName: 'unconfigured',
    embed: () => {
      throw new Error(
        'No embedding-capable AI setting is configured. ' +
          'Create one via /api/ai-settings (capabilities includes "embeddings").',
      );
    },
  };
}

/**
 * Pick the first AI setting that advertises the `rerank` capability and has the
 * pieces a {@link CohereReranker} needs (apiKey + rerankModel). Returns the
 * built reranker, or null when no usable setting is configured.
 *
 * Note: we only support Cohere here. Voyage AI / local cross-encoder would
 * branch on `setting.provider`, but Phase 5 ships Cohere only.
 */
export function resolveCohereReranker(
  aiSettingsManager: AiSettingsManager,
  ragCore: typeof import('@calame-ee/rag-core'),
  log: RagLogger,
  rateLimiter: RateLimiter | null,
): import('@calame-ee/rag-core').Reranker | null {
  const settings = aiSettingsManager.listSettings();
  for (const setting of settings) {
    if (!settingSupports(setting, 'rerank')) continue;
    if (!setting.apiKey) {
      log.warn(`Skipping rerank AI setting "${setting.name}": missing apiKey.`);
      continue;
    }
    if (!setting.rerankModel) {
      log.warn(`Skipping rerank AI setting "${setting.name}": missing rerankModel.`);
      continue;
    }
    try {
      const reranker = new ragCore.CohereReranker({
        apiKey: setting.apiKey,
        model: setting.rerankModel,
        baseUrl: setting.baseUrl,
      });
      // Share the runtime rate limiter so the `cohere` bucket throttles
      // every rerank call across the process — keeps trial-tier keys
      // (10 req/min) safe and avoids 429s under load.
      if (rateLimiter) {
        reranker.setRateLimiter(rateLimiter);
      }
      return reranker;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to build CohereReranker from "${setting.name}": ${msg}`);
    }
  }
  return null;
}
