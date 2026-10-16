// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { RagSourceWithCounts } from './api.js';
import { RAG_STRINGS, translateJobError } from './onboarding-strings.js';
import { KB_MANAGER_STRINGS as T } from './strings/kb-manager.js';
import SyncRetryAlert from './SyncRetryAlert.js';
import type { SourceJobInfo } from './useActiveSyncJobs.js';

interface SourceDetailNoticesProps {
  source: RagSourceWithCounts;
  jobInfo: SourceJobInfo | undefined;
  onRetry: () => void;
  /** True while a sync request for this source is in flight. */
  retrying: boolean;
  /** Guided next step — navigation only, nothing is created here. */
  onCreateProfile?: (source: { id: string; name: string }) => void;
}

/**
 * Notices of the selected source's detail card: the last failed sync (with an
 * explicit retry) and, once documents are indexed, the next guided step —
 * creating a data configuration that contains this source.
 */
export default function SourceDetailNotices({
  source,
  jobInfo,
  onRetry,
  retrying,
  onCreateProfile,
}: SourceDetailNoticesProps) {
  const syncing = Boolean(jobInfo?.activeJob);
  const failedJob = syncing ? null : jobInfo?.lastFailedJob;
  return (
    <>
      {/* The badge only carries the error in its tooltip — spell it out on
          the detail card so a failed sync is never silent. */}
      {failedJob && (
        <SyncRetryAlert
          compact
          message={RAG_STRINGS.lastSyncFailedAria(
            failedJob.error ? translateJobError(failedJob.error) : RAG_STRINGS.unknownError,
          )}
          onRetry={onRetry}
          retrying={retrying}
        />
      )}
      {onCreateProfile && !syncing && source.documentCount > 0 && (
        <div className="card-primary p-3 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-gray-400">{T.nextStepProfile(source.name)}</p>
          <button
            type="button"
            onClick={() => onCreateProfile({ id: source.id, name: source.name })}
            className="px-3 py-1.5 rounded-lg text-sm bg-os-700 hover:bg-os-600 text-white"
          >
            {T.createProfileFromSource}
          </button>
        </div>
      )}
    </>
  );
}
