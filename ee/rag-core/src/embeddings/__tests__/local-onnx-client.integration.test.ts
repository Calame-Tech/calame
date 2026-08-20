// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.
//
// Opt-in integration test: loads the REAL bundled model (not mocked) and
// checks it against the cross-runtime reference fixture captured during the
// Phase 0 prototype (Python onnxruntime + transformers.AutoTokenizer running
// the identical q4 ONNX graph — see fixtures/embeddinggemma-reference-vectors.json
// for provenance). Skipped by default (real ~200MB model load) — this is the
// only test that would catch a silent quality regression from an upstream
// re-export, a dtype change, or a transformers.js version bump that alters
// tokenization/pooling behavior.
//
// Run with: CALAME_TEST_LOCAL_EMBEDDINGS=1 pnpm --filter @calame-ee/rag-core test
// Requires the model staged via `pnpm model:fetch` at the repo root first.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalOnnxEmbeddingClient } from '../local-onnx-client.js';

const RUN = process.env.CALAME_TEST_LOCAL_EMBEDDINGS === '1';

/** Walk up from this file until a `pnpm-workspace.yaml` marks the repo root. */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find repo root (pnpm-workspace.yaml) walking up from ${startDir}`);
}

/** Locates node_modules/.cache/calame-desktop/models/<revision>/embeddinggemma-300m under the repo root. */
function findCachedModelsRoot(): string | null {
  const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const modelsDir = path.join(repoRoot, 'node_modules/.cache/calame-desktop/models');
  if (!fs.existsSync(modelsDir)) return null;
  for (const revision of fs.readdirSync(modelsDir)) {
    const candidate = path.join(modelsDir, revision, 'embeddinggemma-300m', 'config.json');
    if (fs.existsSync(candidate)) return path.join(modelsDir, revision);
  }
  return null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // both sides are unit-norm
}

describe.skipIf(!RUN)('LocalOnnxEmbeddingClient (real model integration)', () => {
  const modelsRoot = RUN ? findCachedModelsRoot() : null;

  it('produces vectors matching the cross-runtime reference (cosine >= 0.99) and ranks correctly', async () => {
    if (!modelsRoot) {
      throw new Error(
        'CALAME_TEST_LOCAL_EMBEDDINGS=1 but no cached model found. Run `pnpm model:fetch` at the repo root first.',
      );
    }

    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures/embeddinggemma-reference-vectors.json',
    );
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
      dimensions: number;
      docs: string[];
      doc_embeddings: number[][];
      queries: string[];
      query_embeddings: number[][];
    };

    const client = new LocalOnnxEmbeddingClient({
      modelsRootDir: modelsRoot,
      modelFolderName: 'embeddinggemma-300m',
      dtype: 'q4',
      dimensions: fixture.dimensions,
      maxTokens: 2048,
      modelName: 'embeddinggemma-300m-q4',
    });

    const docVectors = await client.embed(fixture.docs);
    const queryVectors = await client.embedQuery(fixture.queries);

    expect(docVectors).toHaveLength(fixture.docs.length);
    expect(docVectors[0]).toHaveLength(fixture.dimensions);

    let minCosineDocs = Infinity;
    docVectors.forEach((vec, i) => {
      minCosineDocs = Math.min(minCosineDocs, cosine(vec, fixture.doc_embeddings[i]!));
    });
    let minCosineQueries = Infinity;
    queryVectors.forEach((vec, i) => {
      minCosineQueries = Math.min(minCosineQueries, cosine(vec, fixture.query_embeddings[i]!));
    });

    expect(minCosineDocs).toBeGreaterThanOrEqual(0.99);
    expect(minCosineQueries).toBeGreaterThanOrEqual(0.99);

    // Independent sanity check, not derived from the fixture: every query's
    // nearest document (by cosine, computed fresh here) must be its known
    // correct match — catches a regression that shifts all vectors uniformly
    // (which could still pass a raw cosine-to-fixture check in principle).
    const expectedTopMatch: Record<string, string> = {
      'cats sleeping': 'Cats are independent animals that enjoy sleeping most of the day.',
      'car maintenance oil change':
        'Cars require regular oil changes to keep the engine running smoothly.',
      'version control for developers':
        'Software engineers rely on version control systems like Git.',
    };
    for (const [query, expectedDoc] of Object.entries(expectedTopMatch)) {
      const qi = fixture.queries.indexOf(query);
      expect(qi).toBeGreaterThanOrEqual(0);
      let bestIdx = -1;
      let bestScore = -Infinity;
      docVectors.forEach((vec, di) => {
        const score = cosine(queryVectors[qi]!, vec);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = di;
        }
      });
      expect(fixture.docs[bestIdx]).toBe(expectedDoc);
    }
  }, 60_000);
});
