# ADR 0004 — Bundle a local embedding model, enabled by default

**Status:** Accepted (implemented 2026-08-19)

## Context

Enabling RAG in Calame required manually configuring a remote embedding
provider (OpenRouter or a custom OpenAI-compatible endpoint): base URL, API
key, model name, dimensions. This caused two problems:

1. **The product promise wasn't kept.** Non-developer paying users don't know
   what an "embeddings provider" is. RAG did not work out of the box.
2. **A privacy contradiction.** With a remote provider, raw document text
   leaves the machine on *every* ingestion (`ee/rag-core/src/pipeline/ingest.ts`)
   **and** on every search query (`ee/rag-core/src/search/hybrid-search.ts`,
   `ee/rag-core/src/routes/rag-search.ts`) — directly at odds with a "your
   data stays on your PC" positioning, for a desktop product that otherwise
   keeps everything local (see [ADR 0001](0001-encrypted-source-config.md)).

## Decision

1. **Bundle EmbeddingGemma-300M (Google), q4 ONNX quantization**, run via
   `@huggingface/transformers` (`ee/rag-core/src/embeddings/local-onnx-client.ts`).
   768 dimensions, 2048-token context, 100+ languages, #1 on the MTEB
   multilingual leaderboard under 500M params at the time of evaluation. The
   model files (~210 MB) are staged into the installer at build time
   (`scripts/fetch-embedding-model.mjs`, pinned to a specific upstream
   revision — never `main`), not downloaded on first use.

2. **Local is the default, remote providers remain fully available.** A
   real `ai_settings` row (provider `local`) is seeded by migration and
   auto-healed at boot (`ensureBuiltInSettings` in `packages/cli/src/ai-config.ts`)
   rather than modeled as a virtual/synthetic setting — this makes every
   existing by-name resolution path (`resolveEmbeddingClient`,
   `pickDefaultEmbeddingClient`, hybrid search, etc.) work unmodified. New
   RAG sources default to it (`ee/rag-core/src/web/SourceForm.tsx`); OpenRouter
   and custom OpenAI-compatible endpoints remain first-class choices for
   users who want a different quality/cost/privacy trade-off.

3. **Query/document asymmetry is a first-class part of the `EmbeddingClient`
   contract.** EmbeddingGemma requires different task prefixes for queries
   vs. documents; forcing this through an optional `embedQuery()` method
   (rather than a `mode` parameter on `embed()`) makes "does this client
   distinguish requests from documents?" verifiable at the type level and at
   runtime, and keeps every existing single-method mock/implementation
   compiling unchanged.

4. **Ingestion resolves its embedding client per source**, not once
   process-wide (`ee/rag-core/src/pipeline/ingest.ts`). This was a latent bug
   predating this change (search already honored `rag_sources.embedding_setting_name`;
   ingestion silently didn't) that the "local by default, remote still
   available" scope made load-bearing: without this fix, a source explicitly
   configured for a remote provider would have been silently ingested with
   the local model instead the moment it existed alongside it.

5. **The `rag_chunks_vec` vector table has one fixed dimension, process-wide.**
   This pre-existing Phase 1 limitation means switching an install's default
   dimension (e.g. an existing 1536-dimension install adopting the 768-dimension
   local model) cannot be a live, in-place operation — see
   `ee/rag-core/src/routes/rag-reindex.ts`. `POST /api/rag/reindex` purges and
   re-ingests every active source under the new setting, then requires a
   restart (routes hold vector-store/pipeline references captured at
   registration time — no hot-swap). A fresh install simply defaults straight
   to 768 (`packages/cli/src/rag/store-init.ts`); only pre-existing installs
   go through the migration flow.

## Consequences

- RAG works immediately after installation for a non-technical user, with no
  configuration and no outbound network traffic for embeddings — the privacy
  claim now matches the local-provider's actual behavior.
- The installer grows by roughly 275 MB (65 MB of pruned JS runtime
  dependencies + ~210 MB of model weights). Deemed acceptable given the
  alternative (RAG not working out of the box, or a false privacy claim).
- CPU-only inference throughput is ~18–26 chunks/s regardless of batch size
  (measured on the reference dev machine) — a large corpus (10k+ chunks)
  takes several minutes to index. Acceptable for a desktop product; the
  ingestion progress UI already surfaces this rather than looking hung.
- EmbeddingGemma ships under the **Gemma Terms of Use** (not OSI-approved),
  not Apache-2.0/MIT like the rest of the JS dependency chain. The required
  notice and terms are bundled (`third_party/gemma/`, `third_party/NOTICES.md`)
  and linked from the UI; the weights are treated as a distributed asset
  under Google's terms, not as code — this does not affect the licensing of
  `ee/` (BUSL) or `packages/` (Apache-2.0).
- The built-in local setting is single-tenant by construction (`ai_settings`
  is keyed by `name` alone, even after the Phase B multi-tenancy migration) —
  acceptable because the desktop product is single-tenant; a future promotion
  of that primary key to `(tenant_id, name)` would lift the restriction.
- The reindex endpoint's 409 multi-tenant precondition (`other-tenants-have-chunks`)
  is a real, currently-unresolved limitation of the shared vector table, not
  something a per-tenant migration can route around on its own.

## Alternatives considered

- **Download the model on first use instead of bundling it:** rejected — the
  whole point is zero-configuration, zero-wait "it just works"; a large
  first-run download reintroduces friction and a network dependency the
  bundled approach exists to remove.
- **A hand-rolled ONNX Runtime + tokenizer integration (bypassing
  `@huggingface/transformers`):** de-risked as a fallback plan in case
  `@huggingface/transformers`'s transitive dependencies (`onnxruntime-web`,
  `sharp`) couldn't be pruned from the installer. Not needed —
  `onnxruntime-web` and the DirectML DLLs proved safely prunable, `sharp`
  stayed small. Kept as a documented fallback, not built.
- **A smaller/larger model:** EmbeddingGemma-300M was chosen after a
  performance/size/quality audit as the best trade-off for a bundled,
  CPU-only, multilingual default; nothing ruled it out during Phase 0
  validation (cosine ≈ 1.00000 against an independent reference runtime).
- **Virtual/synthetic `local` setting instead of a real seeded row:**
  rejected — would require intercepting eight separate `AiSettingsManager`
  methods for the sole benefit of "can't be deleted," a property already
  achieved more simply with route guards plus boot-time auto-heal.
