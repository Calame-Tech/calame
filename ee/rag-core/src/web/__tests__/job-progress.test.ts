// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect } from 'vitest';
import { jobProgressState } from '../job-progress.js';

describe('jobProgressState', () => {
  it('reads an unknown total on an active job as preparing, not as 0/0 nor empty', () => {
    expect(jobProgressState({ status: 'pending', totalDocuments: 0 })).toBe('preparing');
    expect(jobProgressState({ status: 'running', totalDocuments: 0 })).toBe('preparing');
  });

  it('shows progress once the total is known', () => {
    expect(jobProgressState({ status: 'running', totalDocuments: 4 })).toBe('progress');
  });

  it('distinguishes a finished empty discovery from a completed sync', () => {
    expect(jobProgressState({ status: 'completed', totalDocuments: 0 })).toBe('empty');
    expect(jobProgressState({ status: 'completed', totalDocuments: 4 })).toBe('completed');
  });

  it('reports a failure whatever the counters', () => {
    expect(jobProgressState({ status: 'failed', totalDocuments: 0 })).toBe('failed');
    expect(jobProgressState({ status: 'failed', totalDocuments: 4 })).toBe('failed');
  });
});
