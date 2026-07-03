// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import {
  ConnectorError,
  ConnectorConfigError,
  ConnectorAuthError,
  ConnectorDocumentNotFoundError,
} from '../index.js';
import { LocalFolderConnector } from '../local-folder.js';
import { S3Connector } from '../s3.js';
import { HttpConnector } from '../http.js';

describe('shared connector error hierarchy', () => {
  it('every flavor is a ConnectorError carrying its connectorType', () => {
    for (const err of [
      new ConnectorConfigError('s3', 'bad config'),
      new ConnectorAuthError('notion', 'bad token'),
      new ConnectorDocumentNotFoundError('gdrive', 'gone'),
    ]) {
      expect(err).toBeInstanceOf(ConnectorError);
      expect(err.connectorType).toBeTruthy();
    }
  });

  it('flavors are distinguishable from each other', () => {
    const config = new ConnectorConfigError('s3', 'bad config');
    expect(config).not.toBeInstanceOf(ConnectorAuthError);
    expect(config.name).toBe('ConnectorConfigError');
  });
});

describe('narrowConfig throws ConnectorConfigError (catchable as a family)', () => {
  it('LocalFolderConnector rejects a config without rootPath', async () => {
    const err = await new LocalFolderConnector()
      .listDocuments({}, 'src-1')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorConfigError);
    expect((err as ConnectorConfigError).connectorType).toBe('local');
  });

  it('S3Connector rejects a config without bucket', async () => {
    const err = await new S3Connector()
      .listDocuments({}, 'src-1')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorConfigError);
    expect((err as ConnectorConfigError).connectorType).toBe('s3');
  });

  it('HttpConnector rejects a config without urls', async () => {
    const err = await new HttpConnector()
      .listDocuments({}, 'src-1')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorConfigError);
    expect((err as ConnectorConfigError).connectorType).toBe('http');
  });
});
