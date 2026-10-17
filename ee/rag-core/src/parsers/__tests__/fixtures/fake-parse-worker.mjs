// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

// Test double for parsers/parse-worker.ts: same message protocol, but the
// behaviour is picked from the filename so tests can drive every failure
// mode without a build step (vitest cannot start a worker from .ts sources).
//   *throw*  -> parser throws
//   *loop*   -> parser spins in a synchronous infinite loop
//   *crash*  -> worker thread exits mid-parse
//   other    -> returns the buffer as plain text
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (msg) => {
  const name = msg.filename;
  if (name.includes('loop')) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      /* blocks the worker's event loop forever */
    }
  }
  if (name.includes('crash')) process.exit(3);
  if (name.includes('throw')) {
    parentPort.postMessage({ id: msg.id, ok: false, errorName: 'Error', error: 'boom from parser' });
    return;
  }
  const text = Buffer.from(msg.buffer).toString('utf8');
  parentPort.postMessage({ id: msg.id, ok: true, result: { text, format: 'plain' } });
});
