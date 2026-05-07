// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import mammoth from 'mammoth';
import type { ParsedDocument } from './types.js';

/**
 * Parse a DOCX buffer into raw text using `mammoth`. Formatting and styles are
 * dropped — we only keep the textual content for downstream chunking.
 */
export async function parse(buffer: Buffer): Promise<ParsedDocument> {
	const result = await mammoth.extractRawText({ buffer });
	return { text: result.value ?? '' };
}
