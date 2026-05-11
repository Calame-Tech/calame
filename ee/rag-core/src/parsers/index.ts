// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import * as pdfParser from './pdf.js';
import * as docxParser from './docx.js';
import * as markdownParser from './markdown.js';
import * as csvParser from './csv.js';
import * as htmlParser from './html.js';
import * as codeParser from './code.js';
import { CODE_MIME_TYPES, hasCodeExtension } from './code.js';
import type { DocumentParser, ParsedDocument } from './types.js';

/** Thrown when no parser is registered for a given MIME type. */
export class UnsupportedMimeTypeError extends Error {
	constructor(mime: string) {
		super(`No RAG parser is registered for MIME type "${mime}".`);
		this.name = 'UnsupportedMimeTypeError';
	}
}

/** Identity parser used for `text/plain` — buffer is already valid UTF-8 text. */
async function parsePlainText(buffer: Buffer): Promise<ParsedDocument> {
	return { text: buffer.toString('utf8'), format: 'plain' };
}

const MIME_MAP: Record<string, DocumentParser> = {
	'application/pdf': pdfParser.parse,
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': docxParser.parse,
	'text/markdown': markdownParser.parse,
	'text/x-markdown': markdownParser.parse,
	'text/csv': csvParser.parse,
	'text/html': htmlParser.parse,
	'application/xhtml+xml': htmlParser.parse,
	'text/plain': parsePlainText,
};

// Add the code-specific MIME types up-front so they short-circuit the
// `text/plain` fallback.
for (const mime of CODE_MIME_TYPES) {
	MIME_MAP[mime] = codeParser.parse;
}

function normalizeMimeType(mime: string): string {
	return mime.split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Resolve a parser for a MIME type. The lookup is case-insensitive and ignores
 * any `; charset=...` suffix.
 *
 * When the MIME type resolves to the generic `text/plain` (or is omitted /
 * unrecognized but the filename has a known source-code extension), the
 * dispatcher routes to the code parser instead. This lets a `.py` file
 * uploaded with MIME `text/plain` still benefit from the structure-aware
 * code chunker.
 *
 * @throws {UnsupportedMimeTypeError} for unknown / unsupported MIME types
 *   when no filename hint can rescue the lookup.
 */
export function getParserForMimeType(mime: string, filename?: string): DocumentParser {
	const normalized = normalizeMimeType(mime);

	// Direct hit on the MIME map.
	const direct = MIME_MAP[normalized];
	if (direct) {
		// Special case: `text/plain` is the most common upload type, but a file
		// with a recognized code extension should be parsed as code so the
		// structure-aware chunker kicks in.
		if (normalized === 'text/plain' && hasCodeExtension(filename)) {
			return codeParser.parse;
		}
		return direct;
	}

	// Unknown MIME, but the filename has a known code extension → code parser.
	if (hasCodeExtension(filename)) {
		return codeParser.parse;
	}

	throw new UnsupportedMimeTypeError(mime);
}

/** Returns the list of MIME types this build supports. Useful for UI hints. */
export function listSupportedMimeTypes(): string[] {
	return Object.keys(MIME_MAP);
}

export type {
	DocumentParser,
	ParsedDocument,
	ParsedDocumentFormat,
	CodeLanguage,
} from './types.js';
export { pdfParser, docxParser, markdownParser, csvParser, htmlParser, codeParser };
export { detectLanguageFromFilename } from './code.js';
