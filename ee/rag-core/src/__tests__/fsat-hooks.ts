// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Test-only build of the calame-fsat helper that pauses at named points
 * (CALAME_FSAT_TEST_HOOKS). `pnpm build` does not produce it, so the suites
 * that need it build it in beforeAll: same behaviour in CI and locally. The
 * build writes to a temp name then renames, so parallel test files are safe.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export const HOOKS_BIN = resolve(here, '../../dist/native/calame-fsat-hooks');

/** Builds the hook-enabled helper (POSIX only; a no-op on Windows). */
export function buildHooksHelper(): void {
  if (process.platform === 'win32') return;
  execFileSync(process.execPath, [resolve(here, '../../native/build.mjs'), '--hooks'], {
    stdio: 'ignore',
  });
}
