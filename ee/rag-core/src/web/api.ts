// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { RagFolder, RagDocument, RagJob, RagSearchResult } from '../types.js';
import type { RagSourcePublic } from '../routes/api-types.js';
import type { RagUsageResponse } from '../routes/rag-usage.js';

/**
 * Tenant header injection. Duplicated from `packages/web/src/lib/api.ts` to
 * respect the cross-license import rule (BUSL packages can't value-import from
 * Apache `packages/*`). The localStorage key and regex MUST stay in lockstep
 * with the host helper.
 */
const TENANT_STORAGE_KEY = 'calame.tenant';
const TENANT_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function getCurrentTenant(): string {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return 'default';
  const stored = localStorage.getItem(TENANT_STORAGE_KEY);
  if (stored && TENANT_ID_REGEX.test(stored)) return stored;
  return 'default';
}

function withTenantHeader(init?: RequestInit): RequestInit {
  const tenant = getCurrentTenant();
  if (tenant === 'default') return init ?? {};
  const headers = new Headers(init?.headers);
  headers.set('X-Tenant-Id', tenant);
  return { ...init, headers };
}

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
  const res = await fetch(url, withTenantHeader({ method: 'GET' }));
  return parseJson<T>(res);
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(
    url,
    withTenantHeader({
      method: 'POST',
      headers: body === undefined ? undefined : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return parseJson<T>(res);
}

export async function apiPatch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(
    url,
    withTenantHeader({
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
  );
  return parseJson<T>(res);
}

export async function apiDelete<T>(url: string): Promise<T> {
  const res = await fetch(url, withTenantHeader({ method: 'DELETE' }));
  return parseJson<T>(res);
}

/**
 * Multipart upload. Browser sets the boundary header automatically when given
 * a `FormData` instance — do NOT set Content-Type manually.
 */
export async function apiUpload<T>(url: string, formData: FormData): Promise<T> {
  const res = await fetch(
    url,
    withTenantHeader({
      method: 'POST',
      body: formData,
    }),
  );
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

// Re-export the usage shape so the EmbeddingUsageCard can import it from the
// web-layer barrel without reaching across the routes directory.
export type { RagUsageResponse };
