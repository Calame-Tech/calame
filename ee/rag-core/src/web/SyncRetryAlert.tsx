// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { useCallback, useRef, useState } from 'react';
import type { RagSourcePublic } from './api.js';
import { KB_MANAGER_STRINGS as T } from './strings/kb-manager.js';

/**
 * Queues a sync through the same path as the "Re-sync" button. Resolves with
 * an error message when the request failed, or null when the sync is queued
 * (or already running — the server answers 409 instead of queueing twice).
 */
type TriggerSync = (source: RagSourcePublic, initial: true) => Promise<string | null>;

interface InitialSyncFailure {
  source: RagSourcePublic;
  message: string;
}

export interface InitialSync {
  failure: InitialSyncFailure | null;
  /** True while a (re)trigger is in flight. */
  pending: boolean;
  /** Trigger the first sync of a just-created source — at most once per id. */
  start: (source: RagSourcePublic) => void;
  /** Explicit retry after a failed trigger (never called automatically). */
  retry: () => void;
}

/**
 * Automatic first sync of a just-created source. `start` is a no-op for a
 * source id it has already seen, so a repeated save callback or re-render
 * never queues a second first sync. A failed trigger keeps the source and is
 * only retried on an explicit user action.
 */
export function useInitialSync(trigger: TriggerSync): InitialSync {
  const requestedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef(false);
  const [failure, setFailure] = useState<InitialSyncFailure | null>(null);
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (source: RagSourcePublic) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setPending(true);
      try {
        const message = await trigger(source, true);
        setFailure(message === null ? null : { source, message });
      } finally {
        inFlightRef.current = false;
        setPending(false);
      }
    },
    [trigger],
  );

  const start = useCallback(
    (source: RagSourcePublic) => {
      if (requestedRef.current.has(source.id)) return;
      requestedRef.current.add(source.id);
      void run(source);
    },
    [run],
  );

  const retry = useCallback(() => {
    if (failure) void run(failure.source);
  }, [failure, run]);

  return { failure, pending, start, retry };
}

/** Alert shown when the first sync of a new source could not be queued. */
export function InitialSyncAlert({ initialSync }: { initialSync: InitialSync }) {
  const { failure } = initialSync;
  if (!failure) return null;
  return (
    <SyncRetryAlert
      message={T.initialSyncFailed(failure.source.name, failure.message)}
      onRetry={initialSync.retry}
      retrying={initialSync.pending}
    />
  );
}

interface SyncRetryAlertProps {
  message: string;
  onRetry: () => void;
  /** True while a sync request for this source is in flight (no double trigger). */
  retrying: boolean;
  compact?: boolean;
}

/**
 * Sync error with an explicit "Retry sync" action. Retrying is always a user
 * click — a failed sync is never re-triggered automatically.
 */
export default function SyncRetryAlert({
  message,
  onRetry,
  retrying,
  compact = false,
}: SyncRetryAlertProps) {
  return (
    <div
      role="alert"
      className={`${compact ? 'text-xs rounded px-3 py-2 border-red-900/50' : 'p-2.5 text-sm rounded-lg border-red-800/50'} text-red-400 border bg-red-950/30 flex items-center justify-between gap-3 flex-wrap`}
    >
      <span className="break-words">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className={`${compact ? 'px-2 py-1 rounded text-xs' : 'px-3 py-1.5 rounded-lg text-sm'} bg-os-700 hover:bg-os-600 text-white disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {T.retrySync}
      </button>
    </div>
  );
}
