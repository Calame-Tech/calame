// Static metadata for the bundled local embedding model (EmbeddingGemma-300M,
// q4 ONNX). Deliberately dependency-free — no `@huggingface/transformers`
// import here — so both the host (ai-config validation, dimension probing)
// and rag-core (the actual inference client) can read these constants without
// either side pulling in the ONNX runtime just to know the model's shape.
//
// Changing these values changes the embedding space of every local index —
// treat it like the model-version bump described next to
// EMBEDDING_GEMMA_PREFIXES in ee/rag-core/src/embeddings/local-onnx-client.ts.

/** Folder name under the models root — see scripts/fetch-embedding-model.mjs. */
export const LOCAL_EMBEDDING_MODEL_FOLDER = 'embeddinggemma-300m';

/** Persisted as `rag_sources.embedding_model_version` / `ai_settings.embedding_model`. */
export const LOCAL_EMBEDDING_MODEL_ID = 'embeddinggemma-300m-q4';

export const LOCAL_EMBEDDING_DIMENSIONS = 768;

export const LOCAL_EMBEDDING_MAX_TOKENS = 2048;

/** Never 'fp16' or 'q4f16' — EmbeddingGemma's activations don't support fp16. */
export const LOCAL_EMBEDDING_DTYPE = 'q4';

export const LOCAL_EMBEDDING_DEFAULT_LABEL = 'Embeddings locaux (inclus)';
