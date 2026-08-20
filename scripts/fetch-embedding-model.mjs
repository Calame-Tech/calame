#!/usr/bin/env node
/**
 * Fetch and cache the bundled local embedding model (EmbeddingGemma-300M,
 * q4 ONNX quantization) that powers Calame's default, zero-config RAG
 * embedding provider — see docs/adr/0004-bundled-local-embeddings.md.
 *
 * Mirrors the cloudflared staging pattern in prepare-desktop.mjs
 * (ensureCloudflaredBinary): pin an exact version (here, a commit SHA rather
 * than a release tag), verify size + sha256 after download, cache under
 * node_modules/.cache/calame-desktop/, and make the fetch idempotent so
 * `pnpm bundle` doesn't re-download on every run.
 *
 * Output:
 *   node_modules/.cache/calame-desktop/models/<revision>/embeddinggemma-300m/
 *     config.json, tokenizer.json, tokenizer_config.json,
 *     special_tokens_map.json, added_tokens.json,
 *     onnx/model_q4.onnx, onnx/model_q4.onnx_data,
 *     LICENSE-gemma.txt, NOTICE.txt   (copied from third_party/gemma/)
 *
 * Usage: pnpm model:fetch   (or: node scripts/fetch-embedding-model.mjs)
 *   Also imported by bundle-server.mjs, which calls ensureEmbeddingModel()
 *   directly so `pnpm bundle` alone fetches the model on a clean checkout.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(REPO_ROOT, 'node_modules/.cache/calame-desktop');
const GEMMA_LICENSE_DIR = path.join(REPO_ROOT, 'third_party/gemma');

// ---------------------------------------------------------------------------
// Pinned model artifact
// ---------------------------------------------------------------------------
//
// WHY A COMMIT SHA, NOT "main": the q4 ONNX weights are what every shipped
// index is embedded against (see rag_sources.embedding_model_version). If the
// upstream repo were ever re-quantized or re-exported, pulling from a moving
// "main" ref would silently change the embedding space underneath already-
// indexed installs. Bump HF_REVISION deliberately, as a model-version change
// (see EMBEDDING_GEMMA_PREFIXES versioning note in local-onnx-client.ts),
// never implicitly.
const HF_REPO = 'onnx-community/embeddinggemma-300m-ONNX';
const HF_REVISION = '5090578d9565bb06545b4552f76e6bc2c93e4a66';
export const EMBEDDING_MODEL_FOLDER = 'embeddinggemma-300m';

/**
 * Files to fetch, relative to the HF repo root, with expected size + sha256
 * for post-download verification (same defensive pattern as the Node/
 * cloudflared archives below — a corrupt or truncated 197MB download must
 * never be silently accepted as a cache hit).
 *
 * Deliberately excluded: tokenizer.model (raw SentencePiece proto —
 * transformers.js reads tokenizer.json instead, confirmed in the Phase 0
 * prototype), generation_config.json, README.md, and every ONNX variant
 * other than q4 (fp32/fp16/q8/q4f16/no_gather_q4) — q4 is the only one we
 * ship; see the plan's Phase 0 sizing note.
 */
const FILES = [
  { relPath: 'config.json', size: 1765, sha256: '6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b' },
  { relPath: 'tokenizer.json', size: 20323312, sha256: '4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47' },
  { relPath: 'tokenizer_config.json', size: 1156830, sha256: '3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a' },
  { relPath: 'special_tokens_map.json', size: 662, sha256: '2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397' },
  { relPath: 'added_tokens.json', size: 35, sha256: '50b2f405ba56a26d4913fd772089992252d7f942123cc0a034d96424221ba946' },
  { relPath: 'onnx/model_q4.onnx', size: 519322, sha256: 'ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043' },
  { relPath: 'onnx/model_q4.onnx_data', size: 196725760, sha256: '599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02' },
];

function fileUrl(relPath) {
  return `https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/${relPath}`;
}

function log(msg) {
  console.log(msg);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/** True when `filePath` exists and matches both the expected size and sha256. */
function isValidCachedFile(filePath, expectedSize, expectedSha256) {
  try {
    const actualSize = fs.statSync(filePath).size;
    if (actualSize !== expectedSize) return false;
    return sha256File(filePath) === expectedSha256;
  } catch {
    return false;
  }
}

/**
 * Download `url` to `destPath`, streaming to a `.download` temp file first
 * and renaming on success — mirrors downloadFile() in prepare-desktop.mjs, so
 * a failed/interrupted run never leaves a corrupt file at the path the
 * idempotency check looks at.
 */
async function downloadFile(url, destPath) {
  const tmpPath = `${destPath}.download`;
  log(`  Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText} (${url})`);
  }
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpPath));
  fs.renameSync(tmpPath, destPath);
}

/**
 * Ensure every file in FILES is downloaded, verified, and cached under
 * node_modules/.cache/calame-desktop/models/<revision>/embeddinggemma-300m/,
 * plus the Gemma license files copied alongside (required for redistribution
 * — see third_party/gemma/LICENSE-gemma.txt). Idempotent: re-running with
 * everything already cached and valid does no network I/O.
 *
 * Returns the absolute path to the model folder
 * (.../models/<revision>/embeddinggemma-300m/).
 */
export async function ensureEmbeddingModel() {
  const modelDir = path.join(CACHE_DIR, 'models', HF_REVISION, EMBEDDING_MODEL_FOLDER);

  for (const file of FILES) {
    const destPath = path.join(modelDir, file.relPath);
    if (isValidCachedFile(destPath, file.size, file.sha256)) {
      log(`  Cache hit: ${file.relPath} (${formatBytes(file.size)})`);
      continue;
    }
    await downloadFile(fileUrl(file.relPath), destPath);
    if (!isValidCachedFile(destPath, file.size, file.sha256)) {
      throw new Error(
        `Downloaded ${file.relPath} does not match expected size/sha256 — download corrupted ` +
          `or upstream file changed at pinned revision ${HF_REVISION} (should never happen for a ` +
          `pinned commit; re-check HF_REVISION in scripts/fetch-embedding-model.mjs).`,
      );
    }
    log(`  Verified: ${file.relPath} (${formatBytes(file.size)})`);
  }

  // Gemma redistribution requires the Terms of Use to travel with the
  // weights (Gemma Terms of Use, Section 3.1). Copy them into the same
  // folder that ships in the installer.
  for (const licenseFile of ['LICENSE-gemma.txt', 'NOTICE.txt']) {
    fs.copyFileSync(
      path.join(GEMMA_LICENSE_DIR, licenseFile),
      path.join(modelDir, licenseFile),
    );
  }

  return modelDir;
}

async function main() {
  log('== Calame embedding model fetch ==\n');
  log(`Repo: ${HF_REPO}@${HF_REVISION}\n`);
  const modelDir = await ensureEmbeddingModel();
  const totalBytes = FILES.reduce((sum, f) => sum + f.size, 0);
  log(`\nDone. ${formatBytes(totalBytes)} staged at:\n  ${modelDir}`);
}

// Only run main() when invoked directly (`pnpm model:fetch`), not when
// imported by bundle-server.mjs for its ensureEmbeddingModel() call.
if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error('\nfetch-embedding-model failed:', err);
    process.exit(1);
  });
}
