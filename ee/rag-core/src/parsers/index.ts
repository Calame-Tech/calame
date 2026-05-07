// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import * as pdfParser from './pdf.js';
import * as docxParser from './docx.js';
import * as markdownParser from './markdown.js';
import * as csvParser from './csv.js';
import * as htmlParser from './html.js';
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
	return { text: buffer.toString('utf8') };
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

/**
 * Resolve a parser for a MIME type. The lookup is case-insensitive and ignores
 * any `; charset=...` suffix.
 *
 * @throws {UnsupportedMimeTypeError} for unknown / unsupported MIME types.
 */
export function getParserForMimeType(mime: string): DocumentParser {
	const normalized = mime.split(';')[0]?.trim().toLowerCase() ?? '';
	const parser = MIME_MAP[normalized];
	if (!parser) throw new UnsupportedMimeTypeError(mime);
	return parser;
}

/** Returns the list of MIME types this build supports. Useful for UI hints. */
export function listSupportedMimeTypes(): string[] {
	return Object.keys(MIME_MAP);
}

export type { DocumentParser, ParsedDocument } from './types.js';
export { pdfParser, docxParser, markdownParser, csvParser, htmlParser };
