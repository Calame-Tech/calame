// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

export {
  SharePointConnector,
  SharePointDocumentNotFoundError,
  SharePointAuthError,
  SharePointPermissionError,
  AzureCredentialAuthProvider,
  encodeDocId,
  decodeDocId,
  narrowConfig,
  normaliseSiteUrl,
  matchMimeTypes,
  clientCacheKey,
  stripQuotes,
  parseGraphPath,
  mapTestConnectionError,
} from './sharepoint.js';
export type { SharePointConfig } from './sharepoint.js';
