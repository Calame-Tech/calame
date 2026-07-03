// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

export type {
  DocumentSourceConfig,
  DocumentSourceConnector,
  RateLimiterLike,
  Unsubscribe,
  WatchEvent,
  WebhookHandle,
} from './types.js';

export {
  ConnectorError,
  ConnectorAuthError,
  ConnectorPermissionError,
  ConnectorRateLimitError,
  ConnectorConfigError,
  // The shared base is exported under an alias because the local-folder
  // connector historically exports its own error class named
  // `DocumentNotFoundError` (kept below for backwards compatibility).
  DocumentNotFoundError as ConnectorDocumentNotFoundError,
} from './errors.js';

export { makeDocIdCodec, stripDocIdPrefix } from './doc-id.js';
export type { DocIdCodec } from './doc-id.js';

export { collectAllPages } from './pagination.js';
export type { Page } from './pagination.js';

export { LocalFolderConnector, DocumentNotFoundError } from './local-folder.js';
export type { LocalFolderConfig } from './local-folder.js';

export { S3Connector, S3DocumentNotFoundError } from './s3.js';
export type { S3Config } from './s3.js';

export {
  HttpConnector,
  HttpFetchError,
  HttpStatusError,
  HttpDocumentNotFoundError,
} from './http.js';
export type { HttpConfig } from './http.js';

export {
  PathEscapeError,
  deterministicId,
  matchGlobs,
  safeResolveUnderRoot,
  streamSha256,
} from './utils.js';
