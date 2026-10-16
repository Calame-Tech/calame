// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, ApiError, type RagSourceListResponse, type RagSourceWithCounts } from './api.js';
import { RAG_STRINGS } from './onboarding-strings.js';
import { KB_MANAGER_STRINGS as T } from './strings/kb-manager.js';

/**
 * Last known source list, owned by the host page so it survives remounts of
 * the KnowledgeBaseManager (navigation, tab switch, lazy reload). The host
 * scopes it to the signed-in account/workspace and wipes it when the session
 * ends.
 */
export interface KnownSourcesCache {
  get(): RagSourceWithCounts[] | undefined;
  set(sources: RagSourceWithCounts[]): void;
}

/**
 * Upper bound for the list request. `fetch` has no timeout of its own, so a
 * server that never answers would otherwise leave the view on "Chargement des
 * sources…" forever with no way out.
 */
export const LOAD_TIMEOUT_MS = 20_000;

/**
 * Source list of the KnowledgeBaseManager (tester feedback #02).
 *
 * - Seeded from the host cache: a known list stays on screen while it is
 *   refreshed (`refreshing`) instead of flashing an empty "loading" view.
 * - Several refreshes can overlap (job finished, upload, edit…) and answer
 *   out of order. Each request gets a sequence number and a response is
 *   applied only if no newer one has been applied already, so a stale answer
 *   never overwrites a fresher list. Responses landing after unmount
 *   (navigation, account switch) are dropped.
 * - The authoritative answer replaces the list, even when it is empty; a
 *   failure never clears it and is reported through `reportError`.
 */
export function useSourceList(
  cache: KnownSourcesCache | undefined,
  onSourcesChange: ((count: number) => void) | undefined,
  reportError: (message: string | null) => void,
) {
  const [sources, setSources] = useState<RagSourceWithCounts[]>(() => cache?.get() ?? []);
  // False until a list is known — an empty `sources` array must not be
  // presented as "no source" when the fetch failed.
  const [sourcesLoaded, setSourcesLoaded] = useState(() => cache?.get() !== undefined);
  const [pendingRequests, setPendingRequests] = useState(0);

  // Refs so new callback identities do not re-create refreshSources (which
  // would re-run the initial load effect).
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const onSourcesChangeRef = useRef(onSourcesChange);
  onSourcesChangeRef.current = onSourcesChange;
  const reportErrorRef = useRef(reportError);
  reportErrorRef.current = reportError;
  const sourcesLoadedRef = useRef(sourcesLoaded);
  sourcesLoadedRef.current = sourcesLoaded;

  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshSources = useCallback(async (): Promise<void> => {
    const seq = ++requestSeqRef.current;
    setPendingRequests((n) => n + 1);
    try {
      const data = await apiGet<RagSourceListResponse>('/api/rag/sources', {
        timeoutMs: LOAD_TIMEOUT_MS,
      });
      if (!mountedRef.current || seq < appliedSeqRef.current) return;
      appliedSeqRef.current = seq;
      const next = data.sources ?? [];
      setSources(next);
      setSourcesLoaded(true);
      cacheRef.current?.set(next);
      onSourcesChangeRef.current?.(next.length);
      reportErrorRef.current(null);
    } catch (err) {
      // Only reported when no newer request is pending or already answered.
      if (!mountedRef.current || seq < requestSeqRef.current) return;
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : T.loadError;
      reportErrorRef.current(
        sourcesLoadedRef.current ? RAG_STRINGS.sourcesRefreshError(message) : message,
      );
    } finally {
      if (mountedRef.current) setPendingRequests((n) => n - 1);
    }
  }, []);

  return { sources, sourcesLoaded, refreshing: pendingRequests > 0, refreshSources };
}
