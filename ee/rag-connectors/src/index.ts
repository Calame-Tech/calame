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

export { PathEscapeError, deterministicId, matchGlobs, safeResolveUnderRoot, streamSha256 } from './utils.js';
