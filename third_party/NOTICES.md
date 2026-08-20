# Third-party notices

Calame's local (default) embedding provider bundles the following third-party
components, none of which are covered by `LICENSE` (Apache-2.0, the Calame
codebase) or `ee/LICENSE.BUSL` (the Calame EE codebase). These are bundled
assets and runtime dependencies, not Calame code.

## EmbeddingGemma (model weights)

- **Source:** [onnx-community/embeddinggemma-300m-ONNX](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX), commit `5090578d9565bb06545b4552f76e6bc2c93e4a66` (pinned for reproducibility — see `scripts/fetch-embedding-model.mjs`).
- **Upstream:** [google/embeddinggemma-300m](https://huggingface.co/google/embeddinggemma-300m)
- **License:** [Gemma Terms of Use](https://ai.google.dev/gemma/terms) — see [`gemma/LICENSE-gemma.txt`](gemma/LICENSE-gemma.txt) and [`gemma/NOTICE.txt`](gemma/NOTICE.txt) in this directory. Use is additionally subject to the [Gemma Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy) (incorporated by reference — not reproduced here since Google may update it independently).
- **What ships:** `onnx/model_q4.onnx` + `onnx/model_q4.onnx_data` (4-bit quantized weights), `tokenizer.json`, `config.json`, and related tokenizer config files. No other quantization variant is shipped.

## @huggingface/transformers (transformers.js)

- **License:** Apache-2.0
- **Source:** https://github.com/huggingface/transformers.js
- Used to load and run EmbeddingGemma locally (tokenization, ONNX Runtime session, pooling/prefix handling).

## onnxruntime-node / onnxruntime-common

- **License:** MIT
- **Source:** https://github.com/microsoft/onnxruntime
- The native ONNX inference engine `@huggingface/transformers` runs on. Only the Windows x64 CPU binaries are shipped (see the pruning step in `scripts/bundle-server.mjs`) — DirectML and non-Windows platform binaries are stripped, since Calame's desktop build targets Windows x64 CPU inference only.

## @huggingface/jinja

- **License:** MIT
- **Source:** https://github.com/huggingface/huggingface.js
- Template engine used internally by `@huggingface/transformers` for chat/prompt templating.

## sharp

- **License:** Apache-2.0
- **Source:** https://github.com/lovell/sharp
- A hard runtime dependency of `@huggingface/transformers`'s Node entrypoint (image preprocessing for vision models). Calame never calls the vision code paths — only text embedding — but the package cannot be pruned without patching `@huggingface/transformers` itself, so it ships unused.
