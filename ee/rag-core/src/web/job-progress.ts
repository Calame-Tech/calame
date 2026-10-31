// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { RagJob } from '../types.js';

/**
 * Readable state of a sync job, derived from its real counters only.
 * `totalDocuments === 0` while the job is active means discovery has not
 * finished (total unknown) — never an empty source nor a "0/0" progress.
 */
export type JobProgressState = 'preparing' | 'progress' | 'empty' | 'completed' | 'failed';

export function jobProgressState(job: Pick<RagJob, 'status' | 'totalDocuments'>): JobProgressState {
  switch (job.status) {
    case 'failed':
      return 'failed';
    case 'completed':
      return job.totalDocuments > 0 ? 'completed' : 'empty';
    default:
      return job.totalDocuments > 0 ? 'progress' : 'preparing';
  }
}
