// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Express, Request, Response } from 'express';
import type { RagDocument, RagFolder } from '../types.js';
import type { RagRouteDeps } from './types.js';

/**
 * Resolve the tenant id for a request, falling back to the literal
 * `'default'` when the host hasn't wired a resolver (e.g. test deps).
 */
function resolveTenantId(deps: RagRouteDeps, req?: Request): string {
	return deps.getTenantId ? deps.getTenantId(req) : 'default';
}

interface FolderRow {
	id: string;
	source_id: string;
	parent_id: string | null;
	path: string;
	name: string;
	tenant_id: string;
	created_at: string;
}

interface DocumentRow {
	id: string;
	source_id: string;
	folder_id: string | null;
	path: string;
	name: string;
	mime_type: string;
	size: number;
	hash: string;
	etag: string | null;
	tenant_id: string;
	last_indexed_at: string;
	deleted_at: string | null;
	ingest_error: string | null;
}

interface ChunkRow {
	id: string;
	document_id: string;
	position: number;
	text: string;
	token_count: number;
	embedding_dimensions: number;
	tenant_id: string;
}

function rowToFolder(row: FolderRow): RagFolder {
	return {
		id: row.id,
		sourceId: row.source_id,
		parentId: row.parent_id,
		path: row.path,
		name: row.name,
		// Defensive `?? 'default'` for fixtures that bypass the migration.
		tenantId: row.tenant_id ?? 'default',
		createdAt: row.created_at,
	};
}

function rowToDocument(row: DocumentRow): RagDocument {
	return {
		id: row.id,
		sourceId: row.source_id,
		folderId: row.folder_id,
		path: row.path,
		name: row.name,
		mimeType: row.mime_type,
		size: row.size,
		hash: row.hash,
		etag: row.etag,
		tenantId: row.tenant_id ?? 'default',
		lastIndexedAt: row.last_indexed_at,
		deletedAt: row.deleted_at,
		// Defensive `?? null` for fixtures that bypass the v9 migration.
		ingestError: row.ingest_error ?? null,
	};
}

function sendError(res: Response, status: number, message: string): void {
	res.status(status).json({ error: message });
}

/**
 * Routes that expose the indexed content of a source:
 *
 *  - GET /api/rag/sources/:id/folders        list folders for a source
 *  - GET /api/rag/sources/:id/documents      list (non-deleted) documents
 *  - GET /api/rag/documents/:id              full document metadata + reconstructed text
 *
 * Phase B multi-tenancy: every read path binds the parent source's tenant
 * into the visibility check. Cross-tenant sources resolve as 404, so the
 * existence of folders/documents under another tenant is never leaked.
 */
/**
 * Returns true when the parent source exists, is not soft-deleted AND
 * belongs to the supplied tenant. Used by every listing handler to refuse
 * to expose folders / documents of a source the caller doesn't own.
 */
function isSourceVisible(deps: RagRouteDeps, sourceId: string, tenantId: string): boolean {
	const row = deps.db
		.prepare<[string, string], { deleted_at: string | null }>(
			`SELECT deleted_at FROM rag_sources WHERE id = ? AND tenant_id = ?`,
		)
		.get(sourceId, tenantId);
	return row !== undefined && row.deleted_at === null;
}

export function registerRagContentRoutes(app: Express, deps: RagRouteDeps): void {
	app.get('/api/rag/sources/:id/folders', (req: Request, res: Response) => {
		try {
			const tenantId = resolveTenantId(deps, req);
			const id = String(req.params['id'] ?? '');
			if (!isSourceVisible(deps, id, tenantId)) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			// `source_id` is already gated by the parent-source tenant check above,
			// so binding `tenant_id` on the JOIN-less query is redundant but kept
			// for defence-in-depth (and to keep the audit-trail of every read
			// path passing through the tenant filter).
			// Honour the `?folder=<parentId>` query param so the frontend tree-view
			// can lazily load one level at a time. Without this filter the route
			// returns every folder of the source on each expand, which makes the
			// recursive `renderFolder` map over its own ancestors and blows the
			// React call stack ("Maximum call stack size exceeded").
			const folderParam = req.query['folder'];
			let rows: FolderRow[];
			if (typeof folderParam === 'string' && folderParam.length > 0) {
				rows = deps.db
					.prepare<[string, string, string], FolderRow>(
						`SELECT * FROM rag_folders
						 WHERE source_id = ? AND parent_id = ? AND tenant_id = ?
						 ORDER BY path ASC`,
					)
					.all(id, folderParam, tenantId);
			} else {
				rows = deps.db
					.prepare<[string, string], FolderRow>(
						`SELECT * FROM rag_folders
						 WHERE source_id = ? AND parent_id IS NULL AND tenant_id = ?
						 ORDER BY path ASC`,
					)
					.all(id, tenantId);
			}
			res.json({ folders: rows.map(rowToFolder) });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			sendError(res, 500, message);
		}
	});

	app.get('/api/rag/sources/:id/documents', (req: Request, res: Response) => {
		try {
			const tenantId = resolveTenantId(deps, req);
			const id = String(req.params['id'] ?? '');
			if (!isSourceVisible(deps, id, tenantId)) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			const folder = req.query['folder'];

			let rows: DocumentRow[];
			if (typeof folder === 'string' && folder.length > 0) {
				rows = deps.db
					.prepare<[string, string, string], DocumentRow>(
						`SELECT * FROM rag_documents
						 WHERE source_id = ? AND folder_id = ? AND tenant_id = ? AND deleted_at IS NULL
						 ORDER BY path ASC`,
					)
					.all(id, folder, tenantId);
			} else {
				rows = deps.db
					.prepare<[string, string], DocumentRow>(
						`SELECT * FROM rag_documents
						 WHERE source_id = ? AND tenant_id = ? AND deleted_at IS NULL
						 ORDER BY path ASC`,
					)
					.all(id, tenantId);
			}
			res.json({ documents: rows.map(rowToDocument) });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			sendError(res, 500, message);
		}
	});

	app.get('/api/rag/documents/:id', (req: Request, res: Response) => {
		try {
			const tenantId = resolveTenantId(deps, req);
			const id = String(req.params['id'] ?? '');
			// Bind the tenant on the document lookup so a cross-tenant document
			// id resolves as 404 directly.
			const row = deps.db
				.prepare<[string, string], DocumentRow>(
					`SELECT * FROM rag_documents WHERE id = ? AND tenant_id = ?`,
				)
				.get(id, tenantId);
			if (!row) {
				sendError(res, 404, `Document "${id}" not found.`);
				return;
			}
			// Refuse to surface a document whose parent source is soft-deleted —
			// it would leak data that should be invisible until the source is
			// restored (or hard-deleted by the cleanup cron). The visibility
			// check also re-applies the tenant filter for defence-in-depth.
			if (!isSourceVisible(deps, row.source_id, tenantId)) {
				sendError(res, 404, `Document "${id}" not found.`);
				return;
			}
			const chunks = deps.db
				.prepare<[string, string], ChunkRow>(
					`SELECT * FROM rag_chunks
					 WHERE document_id = ? AND tenant_id = ?
					 ORDER BY position ASC`,
				)
				.all(id, tenantId);
			const text = chunks.map((c) => c.text).join('\n');
			res.json({
				document: rowToDocument(row),
				text,
				chunkCount: chunks.length,
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			sendError(res, 500, message);
		}
	});
}
