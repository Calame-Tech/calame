// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Readable } from 'node:stream';
import type { RagDocument, RagFolder, RagSourceType } from '@calame-ee/rag-core';

/**
 * Generic configuration object passed to a connector. Each connector
 * implementation narrows this to its own concrete shape (e.g. `LocalConfig`,
 * `S3Config`, …). The host stores this opaquely as `RagSource.configEncrypted`.
 */
export type DocumentSourceConfig = Record<string, unknown>;

/**
 * A change event emitted by `watch()` when a connector supports incremental
 * change notifications (e.g. `chokidar` for local FS, S3 Event Notifications).
 */
export interface WatchEvent {
  type: 'created' | 'updated' | 'deleted';
  /** Connector-defined document identifier (e.g. absolute path, S3 key). */
  documentId: string;
}

/**
 * Disposer returned by `watch()`. Callers invoke it to stop receiving events.
 */
export type Unsubscribe = () => void;

/**
 * Handle returned by `registerWebhook()` so the host can later unregister.
 */
export interface WebhookHandle {
  id: string;
  unregister(): Promise<void>;
}

/**
 * Connector contract for a document source. Mirrors the shape of
 * `DatabaseConnector` (`packages/connectors/src/types.ts`) so the same mental
 * model applies. See `docs/rag-integration-plan.md` §4.1.
 *
 * NOTE: every method that produces or resolves an entity id receives the
 * caller-provided `sourceId`. Ids must be deterministic per `(sourceId, path)`
 * so that re-listing a source does not reshuffle ids on each call.
 */
export interface DocumentSourceConnector {
  /** Discriminator — one of the `RagSourceType` values. */
  type: RagSourceType;

  /** Validate that the supplied configuration can reach the source. */
  testConnection(config: DocumentSourceConfig): Promise<void>;

  /**
   * List folders under `parent` (or root folders when `parent` is omitted).
   * The returned `RagFolder` objects may be partial — the host fills in
   * DB-managed fields when persisting.
   *
   * @param sourceId Stable id of the parent `RagSource`. Used to scope folder ids.
   * @param parent   Direct parent folder (already returned by a previous call),
   *                 or omitted for the source root.
   */
  listFolders(
    config: DocumentSourceConfig,
    sourceId: string,
    parent?: RagFolder,
  ): Promise<RagFolder[]>;

  /**
   * List documents inside `folder` (or the source root when omitted). Returned
   * `RagDocument` objects may be partial — the host fills in DB-managed fields.
   *
   * @param sourceId Stable id of the parent `RagSource`. Used to scope doc ids.
   * @param folder   Folder to list, or omitted for files at the source root.
   */
  listDocuments(
    config: DocumentSourceConfig,
    sourceId: string,
    folder?: RagFolder,
  ): Promise<RagDocument[]>;

  /**
   * Open a stream over the binary contents of a document, plus its mimeType.
   * Caller is responsible for closing / consuming the stream.
   *
   * @param sourceId Stable id of the parent `RagSource`.
   * @param docId    Connector-defined document id (must round-trip with
   *                 `RagDocument.id` returned by `listDocuments`).
   */
  fetchDocument(
    config: DocumentSourceConfig,
    sourceId: string,
    docId: string,
  ): Promise<{ stream: Readable; mimeType: string }>;

  /**
   * Optional: subscribe to change notifications. Returns an unsubscribe fn.
   * Supported today by `LocalFolderConnector` (chokidar). Phase 4+ for remote.
   */
  watch?(
    config: DocumentSourceConfig,
    sourceId: string,
    onChange: (event: WatchEvent) => void,
  ): Unsubscribe;

  /**
   * Optional: register a push-mode webhook (e.g. S3 Event Notifications,
   * Google Drive Push Notifications). Returns a handle the host can store.
   */
  registerWebhook?(
    config: DocumentSourceConfig,
    sourceId: string,
    callbackUrl: string,
  ): Promise<WebhookHandle>;
}
