// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/**
 * Worker-thread entry point for {@link IsolatedParser}. Runs the regular
 * parser registry in a separate V8 isolate so the host can hard-stop it
 * (`worker.terminate()`) on timeout — including a parser stuck in a
 * synchronous loop — and so a parser crash or OOM only kills this thread.
 *
 * Protocol (one request in flight at a time):
 *   in : { id, mimeType, filename, buffer: Uint8Array }
 *   out: { id, ok: true, result: ParsedDocument }
 *      | { id, ok: false, errorName, error }
 */

import { parentPort } from 'node:worker_threads';
import { getParserForMimeType } from './index.js';
import type { ParseWorkerRequest, ParseWorkerResponse } from './isolated-parser.js';

const port = parentPort;
if (port) {
  port.on('message', (msg: ParseWorkerRequest) => {
    void (async () => {
      let response: ParseWorkerResponse;
      try {
        const parser = getParserForMimeType(msg.mimeType, msg.filename);
        const buffer = Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
        const result = await parser(buffer, msg.filename);
        response = { id: msg.id, ok: true, result };
      } catch (err: unknown) {
        response = {
          id: msg.id,
          ok: false,
          errorName: err instanceof Error ? err.name : 'Error',
          error: err instanceof Error ? err.message : String(err),
        };
      }
      try {
        port.postMessage(response);
      } catch (err: unknown) {
        // e.g. DataCloneError on a non-cloneable metadata value.
        port.postMessage({
          id: msg.id,
          ok: false,
          errorName: 'Error',
          error: `Parser result could not be returned: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies ParseWorkerResponse);
      }
    })();
  });
}
