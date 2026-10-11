// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Builds the calame-fsat helper (native/fsat.c) into dist/native/.
 *
 *   node native/build.mjs          -> dist/native/calame-fsat
 *   node native/build.mjs --hooks  -> dist/native/calame-fsat-hooks (TEST ONLY:
 *                                     pauses at named points so tests can swap
 *                                     the tree; never shipped)
 *
 * POSIX only. On Windows nothing is built and fs-write fails closed
 * (`unsupported_platform`) before touching the disk. On POSIX a missing or
 * failing C compiler is a hard build error: silently shipping without the
 * helper would disable writes.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'dist', 'native');
const hooks = process.argv.includes('--hooks');

if (process.platform === 'win32') {
  console.log('[calame-fsat] Windows: helper not built (fs-write fails closed).');
  process.exit(0);
}

const out = path.join(outDir, hooks ? 'calame-fsat-hooks' : 'calame-fsat');
const tmpOut = `${out}.${process.pid}.tmp`;
mkdirSync(outDir, { recursive: true });
const cc = process.env.CC || 'cc';
const args = ['-O2', '-Wall', '-Wextra', '-Werror', '-D_FILE_OFFSET_BITS=64'];
if (hooks) args.push('-DCALAME_FSAT_TEST_HOOKS');
args.push('-o', tmpOut, path.join(here, 'fsat.c'));
try {
  execFileSync(cc, args, { stdio: 'inherit' });
  renameSync(tmpOut, out); // atomic: never leave a half-written binary
  console.log(`[calame-fsat] built ${path.relative(process.cwd(), out)}`);
} catch (err) {
  rmSync(tmpOut, { force: true });
  console.error(`[calame-fsat] build failed with "${cc}": ${err.message}`);
  process.exit(1);
}
