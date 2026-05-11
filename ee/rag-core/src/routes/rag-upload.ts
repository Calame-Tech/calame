// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { Express, Request, Response } from 'express';
import type { RagSource, RagSourceType } from '../types.js';
import type { RagRouteDeps } from './types.js';

interface SourceRow {
	id: string;
	name: string;
	type: string;
	config_encrypted: string;
	embedding_setting_name: string;
	embedding_model_version: string;
	tenant_id: string;
	created_at: string;
	updated_at: string;
	last_sync_at: string | null;
}

function rowToSource(row: SourceRow): RagSource {
	return {
		id: row.id,
		name: row.name,
		type: row.type as RagSourceType,
		configEncrypted: row.config_encrypted,
		embeddingSettingName: row.embedding_setting_name,
		embeddingModelVersion: row.embedding_model_version,
		// Defensive `?? 'default'` for fixtures that bypass the migration.
		tenantId: row.tenant_id ?? 'default',
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.last_sync_at !== null ? { lastSyncAt: row.last_sync_at } : {}),
	};
}

const MIME_BY_EXT: Record<string, string> = {
	'.pdf': 'application/pdf',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.md': 'text/markdown',
	'.markdown': 'text/markdown',
	'.csv': 'text/csv',
	'.html': 'text/html',
	'.htm': 'text/html',
	'.txt': 'text/plain',
};

/**
 * Best-effort MIME detection. Prefers the multipart-supplied content-type
 * header, falling back to the filename extension.
 */
function detectMime(filename: string, headerMime: string | undefined): string {
	if (headerMime && headerMime !== 'application/octet-stream') {
		return headerMime.split(';')[0]?.trim().toLowerCase() ?? headerMime;
	}
	const ext = path.extname(filename).toLowerCase();
	return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function sendError(res: Response, status: number, message: string): void {
	res.status(status).json({ error: message });
}

/**
 * Lazy-load `formidable`. The dep is already pulled into the workspace via
 * other packages; we resolve at runtime so a missing install yields a clear
 * 501 instead of a startup crash.
 */
type FormidableFile = {
	filepath: string;
	originalFilename: string | null;
	mimetype: string | null;
};

type FormidableForm = {
	parse: (
		req: Request,
	) => Promise<[Record<string, unknown>, Record<string, FormidableFile[]>]>;
};

type FormidableFactory = (options: object) => FormidableForm;

async function loadFormidable(): Promise<FormidableFactory | null> {
	try {
		// Dynamic specifier prevents TypeScript from trying to resolve the module
		// at build time — `formidable` is loaded lazily at runtime.
		const specifier = 'formidable';
		const mod = (await import(/* @vite-ignore */ specifier)) as {
			default?: unknown;
			[key: string]: unknown;
		};
		const factory = (mod.default ?? mod) as unknown;
		if (typeof factory !== 'function') return null;
		return factory as FormidableFactory;
	} catch {
		return null;
	}
}

/**
 * POST /api/rag/sources/:id/upload — multipart/form-data upload for `local`
 * sources. Each file is parsed and ingested. Returns the resulting documents.
 */
export function registerRagUploadRoutes(app: Express, deps: RagRouteDeps): void {
	app.post('/api/rag/sources/:id/upload', async (req: Request, res: Response) => {
		const id = String(req.params['id'] ?? '');
		try {
			const row = deps.db
				.prepare<[string], SourceRow>(`SELECT * FROM rag_sources WHERE id = ?`)
				.get(id);
			if (!row) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			const source = rowToSource(row);
			if (source.type !== 'local') {
				sendError(res, 400, `Upload is only supported for sources of type "local".`);
				return;
			}

			const formidable = await loadFormidable();
			if (!formidable) {
				sendError(
					res,
					501,
					`Multipart parsing requires "formidable". Install it in the host package.`,
				);
				return;
			}

			const form = formidable({ multiples: true, keepExtensions: true });
			const [, filesRaw] = await form.parse(req);

			// formidable normalizes single uploads to arrays with `multiples: true`.
			const allFiles: FormidableFile[] = [];
			for (const value of Object.values(filesRaw)) {
				if (Array.isArray(value)) allFiles.push(...value);
			}

			if (allFiles.length === 0) {
				sendError(res, 400, 'No files were provided in the multipart payload.');
				return;
			}

			// Synthetic job row to track embedding-token usage from manual
			// uploads. We INSERT with status='completed' at the end of the
			// request rather than at the start so a thrown ingest doesn't
			// leave a phantom 'pending' row the UI would chase. The usage
			// endpoint aggregates over status='completed' so this row is
			// indistinguishable from a sync job for cost accounting purposes.
			let tokensEmbeddedThisUpload = 0;
			const ingested = [];
			for (const file of allFiles) {
				const buffer = await fs.readFile(file.filepath);
				const filename = file.originalFilename ?? path.basename(file.filepath);
				const mime = detectMime(filename, file.mimetype ?? undefined);
				const doc = await deps.pipeline.ingestDocument({
					source,
					folder: null,
					path: filename,
					mimeType: mime,
					buffer,
					onTokensEmbedded: (count: number) => {
						tokensEmbeddedThisUpload += count;
					},
				});
				ingested.push(doc);
				// Cleanup the temp file — best effort.
				await fs.unlink(file.filepath).catch(() => undefined);
			}

			// Record the upload as a completed synthetic job. tenant_id is
			// inherited from the parent source (same model as sync jobs).
			const uploadJobId = nanoid();
			const finishedAt = new Date().toISOString();
			deps.db
				.prepare(
					`INSERT INTO rag_jobs
					 (id, source_id, status, progress, total_documents, processed_documents,
					  skipped_by_etag, gc_deleted, tokens_embedded, tenant_id,
					  started_at, finished_at)
					 VALUES (?, ?, 'completed', 1, ?, ?, 0, 0, ?, ?, ?, ?)`,
				)
				.run(
					uploadJobId,
					id,
					ingested.length,
					ingested.length,
					tokensEmbeddedThisUpload,
					source.tenantId,
					finishedAt,
					finishedAt,
				);

			deps.onAudit?.({
				type: 'rag.upload.ok',
				payload: {
					sourceId: id,
					count: ingested.length,
					tokensEmbedded: tokensEmbeddedThisUpload,
				},
				timestamp: finishedAt,
			});
			res.status(201).json({ documents: ingested });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			deps.onAudit?.({
				type: 'rag.upload.failed',
				payload: { sourceId: id, error: message },
				timestamp: new Date().toISOString(),
			});
			sendError(res, 500, message);
		}
	});
}
