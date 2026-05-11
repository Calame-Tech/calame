// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Express, Request, Response } from 'express';
import type { RagDocument, RagFolder } from '../types.js';
import type { RagRouteDeps } from './types.js';

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
 */
export function registerRagContentRoutes(app: Express, deps: RagRouteDeps): void {
	app.get('/api/rag/sources/:id/folders', (req: Request, res: Response) => {
		try {
			const id = String(req.params['id'] ?? '');
			const rows = deps.db
				.prepare<[string], FolderRow>(
					`SELECT * FROM rag_folders WHERE source_id = ? ORDER BY path ASC`,
				)
				.all(id);
			res.json({ folders: rows.map(rowToFolder) });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			sendError(res, 500, message);
		}
	});

	app.get('/api/rag/sources/:id/documents', (req: Request, res: Response) => {
		try {
			const id = String(req.params['id'] ?? '');
			const folder = req.query['folder'];

			let rows: DocumentRow[];
			if (typeof folder === 'string' && folder.length > 0) {
				rows = deps.db
					.prepare<[string, string], DocumentRow>(
						`SELECT * FROM rag_documents
						 WHERE source_id = ? AND folder_id = ? AND deleted_at IS NULL
						 ORDER BY path ASC`,
					)
					.all(id, folder);
			} else {
				rows = deps.db
					.prepare<[string], DocumentRow>(
						`SELECT * FROM rag_documents
						 WHERE source_id = ? AND deleted_at IS NULL
						 ORDER BY path ASC`,
					)
					.all(id);
			}
			res.json({ documents: rows.map(rowToDocument) });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			sendError(res, 500, message);
		}
	});

	app.get('/api/rag/documents/:id', (req: Request, res: Response) => {
		try {
			const id = String(req.params['id'] ?? '');
			const row = deps.db
				.prepare<[string], DocumentRow>(`SELECT * FROM rag_documents WHERE id = ?`)
				.get(id);
			if (!row) {
				sendError(res, 404, `Document "${id}" not found.`);
				return;
			}
			const chunks = deps.db
				.prepare<[string], ChunkRow>(
					`SELECT * FROM rag_chunks WHERE document_id = ? ORDER BY position ASC`,
				)
				.all(id);
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
