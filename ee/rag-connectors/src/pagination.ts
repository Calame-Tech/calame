// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Shared cursor-pagination helper for connectors.
 *
 * Every remote API paginates with its own cursor flavor (Drive/Sheets
 * `nextPageToken`, Notion `start_cursor`/`next_cursor`, Graph
 * `@odata.nextLink`, S3 `ContinuationToken`) but the drain loop is always the
 * same: fetch a page, accumulate its items, repeat while a cursor comes back.
 * Connectors keep only a small closure adapting their API's cursor style.
 */

/** One page of results, as returned by a connector's `fetchPage` closure. */
export interface Page<T, C> {
  items: readonly T[];
  /**
   * Cursor for the next page, or `undefined` when this was the last page.
   * Adapters must map their API's "no more pages" signal (missing token,
   * `has_more: false`, empty string, …) to `undefined`.
   */
  nextCursor: C | undefined;
}

/**
 * Drain a cursor-paginated listing into a single array. Pages are fetched
 * serially: the first call receives `undefined`, each subsequent call
 * receives the previous page's `nextCursor`. Stops when `nextCursor` is
 * `undefined`. Errors thrown by `fetchPage` propagate unchanged.
 */
export async function collectAllPages<T, C>(
  fetchPage: (cursor: C | undefined) => Promise<Page<T, C>>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: C | undefined;
  do {
    const page = await fetchPage(cursor);
    for (const item of page.items) {
      all.push(item);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return all;
}
