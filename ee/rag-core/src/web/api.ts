// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type {
	RagFolder,
	RagDocument,
	RagJob,
	RagSearchResult,
} from '../types.js';
import type { RagSourcePublic } from '../routes/api-types.js';

/**
 * Thrown when an API call returns a non-2xx response. Carries the HTTP status
 * so callers can render specific UX (e.g. 401 → re-auth) and a human message
 * extracted from the JSON body when available.
 */
export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

/**
 * Best-effort error extraction. Backends in this project return either
 * `{ message: '...' }` or `{ error: '...' }` — accept both, fall back to the
 * raw text or the HTTP status line.
 */
async function readError(res: Response): Promise<string> {
	try {
		const data = (await res.clone().json()) as { message?: unknown; error?: unknown };
		if (typeof data.message === 'string' && data.message.length > 0) return data.message;
		if (typeof data.error === 'string' && data.error.length > 0) return data.error;
	} catch {
		// Fall through to text.
	}
	try {
		const text = await res.text();
		if (text.length > 0) return text;
	} catch {
		// Ignore.
	}
	return `HTTP ${res.status}`;
}

async function parseJson<T>(res: Response): Promise<T> {
	if (!res.ok) {
		const message = await readError(res);
		throw new ApiError(res.status, message);
	}
	// Tolerate empty bodies (e.g. 204) — return undefined-cast-as-T.
	const text = await res.text();
	if (text.length === 0) return undefined as unknown as T;
	return JSON.parse(text) as T;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export async function apiGet<T>(url: string): Promise<T> {
	const res = await fetch(url, { method: 'GET' });
	return parseJson<T>(res);
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method: 'POST',
		headers: body === undefined ? undefined : JSON_HEADERS,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return parseJson<T>(res);
}

export async function apiPatch<T>(url: string, body: unknown): Promise<T> {
	const res = await fetch(url, {
		method: 'PATCH',
		headers: JSON_HEADERS,
		body: JSON.stringify(body),
	});
	return parseJson<T>(res);
}

export async function apiDelete<T>(url: string): Promise<T> {
	const res = await fetch(url, { method: 'DELETE' });
	return parseJson<T>(res);
}

/**
 * Multipart upload. Browser sets the boundary header automatically when given
 * a `FormData` instance — do NOT set Content-Type manually.
 */
export async function apiUpload<T>(url: string, formData: FormData): Promise<T> {
	const res = await fetch(url, {
		method: 'POST',
		body: formData,
	});
	return parseJson<T>(res);
}

// ---------------------------------------------------------------------------
// API response shapes — kept here so backend & frontend agree on the contract.
// ---------------------------------------------------------------------------

/**
 * A `RagSourcePublic` returned by the list endpoint, augmented with
 * denormalized counts so the dashboard does not need a second round-trip.
 *
 * `RagSourcePublic` is the decrypted API projection (config: object | null)
 * and must never be confused with the storage-row `RagSource` type.
 */
export type RagSourceWithCounts = RagSourcePublic & {
	folderCount: number;
	documentCount: number;
};

// Re-export so consumers can import from a single web-layer module.
export type { RagSourcePublic };

export interface RagSourceListResponse {
	sources: RagSourceWithCounts[];
}

export interface RagFolderListResponse {
	folders: RagFolder[];
}

export interface RagDocumentListResponse {
	documents: RagDocument[];
}

export interface RagJobListResponse {
	jobs: RagJob[];
}

/**
 * `RagSearchResult` is already shaped as a response. Re-export under a more
 * conventional name for symmetry with the *List response types above.
 */
export type RagSearchResponse = RagSearchResult;
