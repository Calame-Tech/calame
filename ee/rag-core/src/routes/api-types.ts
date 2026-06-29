// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { RagSourceType } from '../types.js';

/**
 * Public projection of a RAG source as returned by the API.
 *
 * Crucially: the storage row's `config_encrypted` blob is decrypted server-side
 * and exposed as a structured `config` object. The client never sees ciphertext.
 *
 * If decryption fails (key drift, corrupted row), `config` is `null` and a
 * `configError` string carries the human-readable reason — the rest of the
 * source can still be rendered in the UI.
 */
export interface RagSourcePublic {
  id: string;
  name: string;
  type: RagSourceType;
  /** Decrypted configuration object. `null` when decryption fails. */
  config: Record<string, unknown> | null;
  /** Present iff `config` is `null` — explains why the blob could not be read. */
  configError?: string;
  embeddingSettingName: string;
  embeddingModelVersion: string;
  embeddingDimensions: number;
  /**
   * Optional auto-sync interval in seconds (60–86400). `null` = manual sync only.
   * Always present in API responses for clarity, even when `null`.
   */
  pollingIntervalSeconds: number | null;
  /**
   * Multi-tenancy id — Phase A always `'default'`. Surfaced on the public
   * API today purely as informational metadata; future UI can decide to hide
   * it while only the default tenant exists.
   */
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  /**
   * Soft-delete marker — ISO timestamp when the source was soft-deleted, or
   * `null` when active. The default `GET /api/rag/sources` endpoint filters
   * soft-deleted rows out of the response; `?includeDeleted=true` (or the
   * stricter `?filter=deleted`) is required to surface them in the UI's
   * "Recently deleted" view.
   */
  deletedAt: string | null;
}
