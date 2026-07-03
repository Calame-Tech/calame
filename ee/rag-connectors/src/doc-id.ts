// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Shared document-id codec for connectors.
 *
 * Every connector namespaces its document ids with a `<type>:` prefix
 * (`gdrive:`, `s3:`, `path:` …) so ids from different source types can never
 * collide. This module factors the encode/decode boilerplate; each connector
 * supplies only its prefix and the error to throw on a malformed id.
 */

/** Encode/decode pair produced by {@link makeDocIdCodec}. */
export interface DocIdCodec {
  /** Wrap a connector-native id into a namespaced document id. */
  encode(id: string): string;
  /** Reverse {@link encode}. Throws the connector's error on malformed input. */
  decode(docId: string): string;
}

/**
 * Validate that `docId` starts with `prefix` and return the remainder.
 * Throws `makeError(docId)` when the prefix does not match. Used internally
 * by {@link makeDocIdCodec} and directly by connectors with composite id
 * payloads (e.g. gsheets' `gsheets:tab:<spreadsheetId>:<sheetId>`).
 */
export function stripDocIdPrefix(
  docId: string,
  prefix: string,
  makeError: (docId: string) => Error,
): string {
  if (!docId.startsWith(prefix)) {
    throw makeError(docId);
  }
  return docId.slice(prefix.length);
}

/**
 * Build a {@link DocIdCodec} for the given prefix.
 *
 * Two payload encodings are supported:
 *  - `'raw'` (default): the native id is already opaque and URL-safe (Drive
 *    file ids, Notion page ids, Graph driveItem ids). `decode` additionally
 *    rejects an empty payload — a bare prefix is never a valid id.
 *  - `'base64url'`: the native id is free-form (filesystem paths, S3 keys,
 *    URLs) and is base64url-wrapped so the result is opaque. Mirrors the
 *    historical per-connector implementations exactly, including their lack
 *    of an empty-payload check (an empty payload round-trips to `''` and the
 *    caller's downstream resolution fails naturally).
 *
 * @param prefix    Namespace prefix including the trailing colon (e.g. `'s3:'`).
 * @param makeError Factory for the connector's document-not-found error.
 */
export function makeDocIdCodec(
  prefix: string,
  makeError: (docId: string) => Error,
  options: { encoding?: 'raw' | 'base64url' } = {},
): DocIdCodec {
  const encoding = options.encoding ?? 'raw';

  if (encoding === 'base64url') {
    return {
      encode: (id: string): string => `${prefix}${Buffer.from(id, 'utf8').toString('base64url')}`,
      decode: (docId: string): string => {
        const encoded = stripDocIdPrefix(docId, prefix, makeError);
        try {
          return Buffer.from(encoded, 'base64url').toString('utf8');
        } catch {
          throw makeError(docId);
        }
      },
    };
  }

  return {
    encode: (id: string): string => `${prefix}${id}`,
    decode: (docId: string): string => {
      const id = stripDocIdPrefix(docId, prefix, makeError);
      if (id.length === 0) {
        throw makeError(docId);
      }
      return id;
    },
  };
}
