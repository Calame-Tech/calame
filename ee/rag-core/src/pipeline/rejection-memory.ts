// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Rejection kinds that depend only on the file's CONTENT: retrying the same
 * bytes gives the same outcome. `locked` / `unreadable` are transient (Word
 * closes the file, permissions get fixed) and are always retried.
 */
const CONTENT_STABLE_REJECTIONS: ReadonlySet<string> = new Set([
  'parse_failed',
  'parse_timeout',
  'too_large',
]);

/** Bound on {@link rejectedByEtag} — oldest entries are evicted first. */
const MAX_REMEMBERED_REJECTIONS = 10_000;

/**
 * Files rejected for a content-stable reason, keyed by `sourceId\0path`,
 * with the connector etag they had. While the etag is unchanged the next
 * syncs report the same rejection WITHOUT re-reading and re-parsing the file
 * — otherwise a DOCX that runs the parser into its 120 s timeout would cost
 * 120 s on every watcher-triggered sync. In memory only (no schema change):
 * the first sync after a restart retries each such file once. A rejected
 * update of an indexed document keeps its last valid version either way.
 */
const rejectedByEtag = new Map<string, { etag: string; kind: string; reason: string }>();

/** Record (or clear, for a transient kind / no etag) the last rejection of a file. */
export function rememberRejection(
  sourceId: string,
  path: string,
  etag: string | null,
  kind: string,
  reason: string,
): void {
  const key = `${sourceId}\0${path}`;
  rejectedByEtag.delete(key);
  if (etag === null || etag === '' || !CONTENT_STABLE_REJECTIONS.has(kind)) return;
  if (rejectedByEtag.size >= MAX_REMEMBERED_REJECTIONS) {
    const oldest = rejectedByEtag.keys().next().value;
    if (oldest !== undefined) rejectedByEtag.delete(oldest);
  }
  rejectedByEtag.set(key, { etag, kind, reason });
}

/** Test-only: forget every remembered rejection (module state). */
export function resetRememberedRejectionsForTests(): void {
  rejectedByEtag.clear();
}

/** The remembered rejection of this file, if its etag has not changed since. */
export function recallRejection(
  sourceId: string,
  path: string,
  etag: string | null,
): { kind: string; reason: string } | null {
  const hit = rejectedByEtag.get(`${sourceId}\0${path}`);
  return hit !== undefined && etag !== null && hit.etag === etag ? hit : null;
}

/** Drop the remembered rejection of a file (it was indexed successfully). */
export function forgetRejection(sourceId: string, path: string): void {
  rejectedByEtag.delete(`${sourceId}\0${path}`);
}
