// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/** Common return shape for every parser. */
export interface ParsedDocument {
	text: string;
	metadata?: Record<string, unknown>;
}

/** A parser converts a binary buffer into a {@link ParsedDocument}. */
export type DocumentParser = (buffer: Buffer) => Promise<ParsedDocument>;
