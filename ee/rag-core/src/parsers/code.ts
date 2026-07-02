// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { CodeLanguage, ParsedDocument } from './types.js';

/**
 * Mapping of well-known file extensions to the source-code language ids
 * understood by the code chunker. Lower-case, leading dot included.
 */
const EXTENSION_TO_LANGUAGE: Record<string, CodeLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
};

/**
 * Resolve a {@link CodeLanguage} from a filename's extension. Returns
 * `'unknown'` when the filename has no extension or the extension isn't
 * recognized — the code chunker then falls back to the plain chunker.
 *
 * The lookup is case-insensitive and tolerates filenames that include path
 * separators (only the trailing segment is considered).
 */
export function detectLanguageFromFilename(filename?: string): CodeLanguage {
  if (!filename) return 'unknown';

  // Strip directory prefix (POSIX or Windows separators).
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return 'unknown'; // no extension OR dotfile without ext
  const ext = base.slice(dotIdx).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? 'unknown';
}

/**
 * Parse a source-code buffer. The buffer is assumed to be UTF-8 encoded text;
 * we do NOT try to detect the encoding because the upstream pipeline (HTTP
 * upload / filesystem watcher) already normalizes to UTF-8.
 *
 * Language detection runs on the filename extension only — content sniffing
 * would be unreliable for a regex-based chunker and we'd rather fall back to
 * the plain chunker than mis-classify.
 */
export async function parse(buffer: Buffer, filename?: string): Promise<ParsedDocument> {
  const text = buffer.toString('utf8');
  const language = detectLanguageFromFilename(filename);
  const base = filename ? (filename.split(/[\\/]/).pop() ?? filename) : undefined;
  return {
    text,
    format: 'code',
    language,
    ...(base !== undefined ? { filename: base } : {}),
  };
}

/** List of MIME types that should be routed to the code parser directly. */
export const CODE_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/typescript',
  'application/typescript',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/x-python',
  'application/x-python',
  'text/x-python-script',
  'text/x-go',
  'text/x-golang',
  'text/rust',
  'text/x-rust',
  'text/x-java',
  'text/x-java-source',
]);

/**
 * Extension-based MIME hint used when the upstream MIME type is the generic
 * `text/plain` (or omitted). Helps the parser dispatcher route a `.py` file
 * to the code parser even when the HTTP layer didn't supply a precise type.
 */
export function hasCodeExtension(filename?: string): boolean {
  return detectLanguageFromFilename(filename) !== 'unknown';
}
