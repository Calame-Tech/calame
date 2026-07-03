// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Shared error hierarchy for document-source connectors.
 *
 * Every connector-specific error (e.g. `GDriveDocumentNotFoundError`,
 * `NotionAuthError`) extends one of the flavors below, so hosts can catch
 * whole error families without knowing which connector produced them:
 *
 * ```ts
 * try { await connector.fetchDocument(cfg, sourceId, docId); }
 * catch (err) {
 *   if (err instanceof DocumentNotFoundError) { … }   // any connector
 *   if (err instanceof ConnectorError) { err.connectorType; } // 'gdrive', 's3', …
 * }
 * ```
 *
 * The per-connector subclasses keep their historical names, messages and
 * `name` fields — this hierarchy only adds common ancestors, it does not
 * change any observable behavior of the existing classes.
 */

/**
 * Base class for all connector errors. Carries the `connectorType`
 * discriminator (`'local'`, `'s3'`, `'http'`, `'gdrive'`, `'gsheets'`,
 * `'notion'`, `'sharepoint'`, …) so hosts can attribute a failure to its
 * source type without string-matching on messages.
 */
export class ConnectorError extends Error {
  readonly connectorType: string;

  constructor(connectorType: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConnectorError';
    this.connectorType = connectorType;
  }
}

/**
 * A document id could not be resolved to a real document (wrong prefix,
 * malformed payload, or the remote object no longer exists).
 */
export class DocumentNotFoundError extends ConnectorError {
  constructor(connectorType: string, message: string, options?: { cause?: unknown }) {
    super(connectorType, message, options);
    this.name = 'DocumentNotFoundError';
  }
}

/** Authentication failed (HTTP 401 — invalid / expired credentials). */
export class ConnectorAuthError extends ConnectorError {
  constructor(connectorType: string, message: string, options?: { cause?: unknown }) {
    super(connectorType, message, options);
    this.name = 'ConnectorAuthError';
  }
}

/** Authenticated but not authorized (HTTP 403 — missing grant / scope). */
export class ConnectorPermissionError extends ConnectorError {
  constructor(connectorType: string, message: string, options?: { cause?: unknown }) {
    super(connectorType, message, options);
    this.name = 'ConnectorPermissionError';
  }
}

/** The upstream API throttled us (HTTP 429). */
export class ConnectorRateLimitError extends ConnectorError {
  constructor(connectorType: string, message: string, options?: { cause?: unknown }) {
    super(connectorType, message, options);
    this.name = 'ConnectorRateLimitError';
  }
}

/**
 * The supplied `DocumentSourceConfig` does not match the connector's expected
 * shape (missing/mistyped field). Thrown by each connector's `narrowConfig`
 * so hosts can map malformed configuration to a 400 without string-matching.
 */
export class ConnectorConfigError extends ConnectorError {
  constructor(connectorType: string, message: string, options?: { cause?: unknown }) {
    super(connectorType, message, options);
    this.name = 'ConnectorConfigError';
  }
}
