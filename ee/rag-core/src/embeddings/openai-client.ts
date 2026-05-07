// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { EmbeddingClient } from '../types.js';

/** Maximum input array size per embeddings request. OpenAI's hard cap is 2048;
 * we use 96 as a conservative default that works across providers (Ollama, LM
 * Studio, OpenRouter). Inputs above this are split and concatenated. */
const BATCH_SIZE = 96;

/** Thrown when the AI setting's provider is incompatible with embeddings. */
export class EmbeddingNotSupportedError extends Error {
	constructor(provider: string) {
		super(
			`Provider "${provider}" does not support embeddings. Use a setting whose ` +
				`capabilities include "embeddings" (provider: openrouter or custom).`,
		);
		this.name = 'EmbeddingNotSupportedError';
	}
}

/** Thrown when the AI setting is missing the embeddingModel field. */
export class EmbeddingModelMissingError extends Error {
	constructor() {
		super(
			`AI setting is missing "embeddingModel". Set it on the setting before using ` +
				`it as an embedding source.`,
		);
		this.name = 'EmbeddingModelMissingError';
	}
}

/** Thrown when a custom provider has no baseUrl configured. */
export class EmbeddingBaseUrlMissingError extends Error {
	constructor() {
		super(`Custom embedding provider requires a baseUrl. Set it on the AI setting.`);
		this.name = 'EmbeddingBaseUrlMissingError';
	}
}

export interface OpenAiCompatibleEmbeddingClientOptions {
	/** Base URL up to (but not including) `/embeddings`. e.g. `https://api.openai.com/v1`. */
	baseUrl: string;
	/** API key sent as `Authorization: Bearer <apiKey>`. Optional for keyless local servers. */
	apiKey?: string;
	/** Model identifier (e.g. `text-embedding-3-small`, `nomic-embed-text`). */
	model: string;
	/**
	 * Number of dimensions the model produces. Caller must supply this — we do
	 * NOT introspect from the API because some providers omit it. Common values:
	 *  - `text-embedding-3-small` → 1536
	 *  - `text-embedding-3-large` → 3072
	 *  - `nomic-embed-text` → 768
	 *  - `bge-m3` → 1024
	 */
	dimensions: number;
}

/**
 * OpenAI-compatible embeddings client. Talks to `${baseUrl}/embeddings` with the
 * standard payload `{ input, model }` and parses `data[].embedding`.
 *
 * Works with: OpenAI, OpenRouter, Ollama (`/v1`), LM Studio, vLLM, llama.cpp.
 */
export class OpenAiCompatibleEmbeddingClient implements EmbeddingClient {
	readonly dimensions: number;
	readonly modelName: string;
	private readonly baseUrl: string;
	private readonly apiKey: string | undefined;

	constructor(opts: OpenAiCompatibleEmbeddingClientOptions) {
		if (!opts.baseUrl) throw new Error('OpenAiCompatibleEmbeddingClient: baseUrl is required');
		if (!opts.model) throw new Error('OpenAiCompatibleEmbeddingClient: model is required');
		if (!Number.isInteger(opts.dimensions) || opts.dimensions <= 0) {
			throw new Error(
				`OpenAiCompatibleEmbeddingClient: dimensions must be a positive integer, got ${opts.dimensions}`,
			);
		}
		this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
		this.apiKey = opts.apiKey;
		this.modelName = opts.model;
		this.dimensions = opts.dimensions;
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];

		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			const batch = texts.slice(i, i + BATCH_SIZE);
			const batchEmbeddings = await this.embedBatch(batch);
			out.push(...batchEmbeddings);
		}
		return out;
	}

	private async embedBatch(batch: string[]): Promise<number[][]> {
		const url = `${this.baseUrl}/embeddings`;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
		if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

		const body = JSON.stringify({ input: batch, model: this.modelName });

		const response = await fetch(url, { method: 'POST', headers, body });
		if (!response.ok) {
			const errText = await response.text().catch(() => '<no body>');
			throw new Error(
				`Embeddings request failed (${response.status} ${response.statusText}): ${errText}`,
			);
		}

		const json = (await response.json()) as unknown;
		if (typeof json !== 'object' || json === null || !('data' in json)) {
			throw new Error('Embeddings response: missing "data" field');
		}
		const data = (json as { data: unknown }).data;
		if (!Array.isArray(data)) {
			throw new Error('Embeddings response: "data" is not an array');
		}

		// Ensure embeddings are returned in input order.
		const ordered: number[][] = new Array(batch.length);
		for (let idx = 0; idx < data.length; idx++) {
			const entry = data[idx];
			if (typeof entry !== 'object' || entry === null) {
				throw new Error(`Embeddings response: data[${idx}] is not an object`);
			}
			const embedding = (entry as { embedding?: unknown }).embedding;
			if (!Array.isArray(embedding) || !embedding.every((n) => typeof n === 'number')) {
				throw new Error(`Embeddings response: data[${idx}].embedding is not number[]`);
			}
			const indexField = (entry as { index?: unknown }).index;
			const target = typeof indexField === 'number' ? indexField : idx;
			ordered[target] = embedding as number[];
		}

		// Validate every slot was filled.
		for (let i = 0; i < ordered.length; i++) {
			if (!ordered[i]) {
				throw new Error(`Embeddings response: missing embedding for input ${i}`);
			}
		}
		return ordered;
	}
}

/**
 * Plain-object shape of an AI setting, duck-typed against
 * `packages/cli/src/ai-config.ts#AiSetting`. We deliberately do NOT import from
 * packages/cli to keep ee/rag-core decoupled.
 */
export interface EmbeddingSettingShape {
	provider: string;
	apiKey: string;
	baseUrl?: string;
	embeddingModel?: string;
}

/**
 * Build an EmbeddingClient from an `AiSetting`-shaped object plus a known
 * dimension. The dimension MUST be provided by the caller — we cannot derive
 * it reliably from the model name across providers.
 *
 * Provider routing:
 *  - `anthropic` → throws {@link EmbeddingNotSupportedError}
 *  - `openrouter` → uses `https://openrouter.ai/api/v1`
 *  - `custom` → uses `setting.baseUrl` (required, throws otherwise)
 */
export function createEmbeddingClient(
	setting: EmbeddingSettingShape,
	dimensions: number,
): EmbeddingClient {
	if (!setting.embeddingModel) {
		throw new EmbeddingModelMissingError();
	}

	let baseUrl: string;
	switch (setting.provider) {
		case 'anthropic':
			throw new EmbeddingNotSupportedError(setting.provider);
		case 'openrouter':
			baseUrl = 'https://openrouter.ai/api/v1';
			break;
		case 'custom':
			if (!setting.baseUrl) throw new EmbeddingBaseUrlMissingError();
			baseUrl = setting.baseUrl;
			break;
		default:
			throw new EmbeddingNotSupportedError(setting.provider);
	}

	return new OpenAiCompatibleEmbeddingClient({
		baseUrl,
		apiKey: setting.apiKey || undefined,
		model: setting.embeddingModel,
		dimensions,
	});
}
