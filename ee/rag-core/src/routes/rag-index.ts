// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Express, Request, Response } from 'express';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { RagFolder, RagJob, RagJobStatus, RagSource, RagSourceType } from '../types.js';
import type { ConnectorLike, RagRouteDeps } from './types.js';

interface SourceRow {
	id: string;
	name: string;
	type: string;
	config_encrypted: string;
	embedding_setting_name: string;
	embedding_model_version: string;
	created_at: string;
	updated_at: string;
	last_sync_at: string | null;
}

interface JobRow {
	id: string;
	source_id: string;
	status: string;
	progress: number;
	total_documents: number;
	processed_documents: number;
	skipped_by_etag: number;
	gc_deleted: number;
	error: string | null;
	started_at: string;
	finished_at: string | null;
}

/**
 * Mini shape used by the etag fast-path. Intentionally NOT reusing
 * `DocumentRow` from `pipeline/ingest.ts` (private to the pipeline) — only the
 * two columns we need to decide whether to skip a fetch.
 */
interface ExistingDocLookupRow {
	id: string;
	etag: string | null;
	deleted_at: string | null;
}

function rowToSource(row: SourceRow): RagSource {
	return {
		id: row.id,
		name: row.name,
		type: row.type as RagSourceType,
		configEncrypted: row.config_encrypted,
		embeddingSettingName: row.embedding_setting_name,
		embeddingModelVersion: row.embedding_model_version,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.last_sync_at !== null ? { lastSyncAt: row.last_sync_at } : {}),
	};
}

function rowToJob(row: JobRow): RagJob {
	return {
		id: row.id,
		sourceId: row.source_id,
		status: row.status as RagJobStatus,
		progress: row.progress,
		totalDocuments: row.total_documents,
		processedDocuments: row.processed_documents,
		skippedByEtag: row.skipped_by_etag,
		gcDeleted: row.gc_deleted,
		error: row.error,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
	};
}

function sendError(res: Response, status: number, message: string): void {
	res.status(status).json({ error: message });
}

/** Read all bytes from a Node Readable stream into a single Buffer. */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
	}
	return Buffer.concat(chunks);
}

/**
 * Look up the indexed copy of a document by `(source_id, path)`. Returns the
 * minimal shape required by the etag fast-path: the id, the previously
 * recorded etag and the soft-delete marker. Returns `null` when no row exists.
 */
function lookupExistingDoc(
	db: BetterSqlite3Database,
	sourceId: string,
	path: string,
): { etag: string | null; deletedAt: string | null } | null {
	const row = db
		.prepare<[string, string], ExistingDocLookupRow>(
			`SELECT id, etag, deleted_at FROM rag_documents WHERE source_id = ? AND path = ?`,
		)
		.get(sourceId, path);
	if (!row) return null;
	return { etag: row.etag, deletedAt: row.deleted_at };
}

/** Recursively walk a connector to enumerate every document under a source. */
async function walkConnector(
	connector: ConnectorLike,
	config: Record<string, unknown>,
	sourceId: string,
): Promise<Array<{ doc: Awaited<ReturnType<ConnectorLike['listDocuments']>>[number]; folder: RagFolder | null }>> {
	const out: Array<{ doc: Awaited<ReturnType<ConnectorLike['listDocuments']>>[number]; folder: RagFolder | null }> = [];

	async function visit(folder: RagFolder | undefined): Promise<void> {
		const folderArg = folder ? { id: folder.id, path: folder.path } : undefined;
		const docs = await connector.listDocuments(config, sourceId, folderArg);
		for (const d of docs) {
			out.push({ doc: d, folder: folder ?? null });
		}
		const subfolders = await connector.listFolders(config, sourceId, folderArg);
		for (const sf of subfolders) {
			await visit(sf);
		}
	}

	await visit(undefined);
	return out;
}

/**
 * Routes:
 *  - POST /api/rag/sources/:id/sync — kick off a (synchronous, MVP) re-index.
 *  - GET  /api/rag/jobs              — list recent jobs, newest first.
 */
export function registerRagIndexRoutes(app: Express, deps: RagRouteDeps): void {
	app.get('/api/rag/jobs', (req: Request, res: Response) => {
		try {
			const sourceId = req.query['sourceId'];
			let rows: JobRow[];
			if (typeof sourceId === 'string' && sourceId.length > 0) {
				rows = deps.db
					.prepare<[string], JobRow>(
						`SELECT * FROM rag_jobs WHERE source_id = ? ORDER BY started_at DESC LIMIT 50`,
					)
					.all(sourceId);
			} else {
				rows = deps.db
					.prepare<[], JobRow>(`SELECT * FROM rag_jobs ORDER BY started_at DESC LIMIT 50`)
					.all();
			}
			res.json({ jobs: rows.map(rowToJob) });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			sendError(res, 500, message);
		}
	});

	app.post('/api/rag/sources/:id/sync', async (req: Request, res: Response) => {
		const id = String(req.params['id'] ?? '');
		const jobId = nanoid();
		const startedAt = new Date().toISOString();
		try {
			const row = deps.db
				.prepare<[string], SourceRow>(`SELECT * FROM rag_sources WHERE id = ?`)
				.get(id);
			if (!row) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			const source = rowToSource(row);

			const connector = deps.resolveConnector?.(source.type);
			if (!connector) {
				sendError(
					res,
					501,
					`Connector for source type "${source.type}" is not installed. ` +
						`Install @calame-ee/rag-connectors or wait until the connector lands.`,
				);
				return;
			}

			let config: Record<string, unknown>;
			try {
				config = JSON.parse(deps.decryptConfig(row.config_encrypted)) as Record<string, unknown>;
			} catch (err: unknown) {
				const m = err instanceof Error ? err.message : String(err);
				sendError(res, 500, `Failed to decrypt source configuration: ${m}`);
				return;
			}

			deps.db
				.prepare(
					`INSERT INTO rag_jobs
					 (id, source_id, status, progress, total_documents, processed_documents, started_at)
					 VALUES (?, ?, 'running', 0, 0, 0, ?)`,
				)
				.run(jobId, id, startedAt);

			deps.onAudit?.({
				type: 'rag.sync.started',
				payload: { sourceId: id, jobId },
				timestamp: startedAt,
			});

			let entries: Awaited<ReturnType<typeof walkConnector>>;
			try {
				entries = await walkConnector(connector, config, source.id);
			} catch (err: unknown) {
				const m = err instanceof Error ? err.message : String(err);
				deps.db
					.prepare(
						`UPDATE rag_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
					)
					.run(m, new Date().toISOString(), jobId);
				deps.onAudit?.({
					type: 'rag.sync.failed',
					payload: { sourceId: id, jobId, error: m },
					timestamp: new Date().toISOString(),
				});
				sendError(res, 500, `Failed to enumerate source documents: ${m}`);
				return;
			}

			deps.db
				.prepare(`UPDATE rag_jobs SET total_documents = ? WHERE id = ?`)
				.run(entries.length, jobId);

			let processed = 0;
			let failures = 0;
			let skippedByEtag = 0;
			let gcDeleted = 0;
			let lastError: string | null = null;
			for (const { doc, folder } of entries) {
				try {
					// Etag pre-fetch fast-path: if the connector reports a non-empty
					// etag and our indexed copy has the same etag (and is not
					// soft-deleted), skip both the network fetch and the ingest.
					// Without this, the pipeline only short-circuits on sha256
					// AFTER the buffer has been fetched — wasteful for S3/HTTP.
					const docEtag = doc.etag ?? null;
					if (docEtag !== null && docEtag !== '') {
						const existing = lookupExistingDoc(deps.db, source.id, doc.path);
						if (
							existing !== null &&
							existing.deletedAt === null &&
							existing.etag === docEtag
						) {
							skippedByEtag++;
							processed++;
							deps.db
								.prepare(
									`UPDATE rag_jobs SET processed_documents = ?, progress = ?, skipped_by_etag = ? WHERE id = ?`,
								)
								.run(
									processed,
									entries.length === 0 ? 1 : processed / entries.length,
									skippedByEtag,
									jobId,
								);
							continue;
						}
					}

					const fetched = await connector.fetchDocument(config, source.id, doc.id);
					const buffer = await streamToBuffer(fetched.stream);
					await deps.pipeline.ingestDocument({
						source,
						folder,
						path: doc.path,
						mimeType: fetched.mimeType,
						buffer,
						etag: docEtag,
					});
				} catch (err: unknown) {
					failures++;
					lastError = err instanceof Error ? err.message : String(err);
				}
				processed++;
				deps.db
					.prepare(
						`UPDATE rag_jobs SET processed_documents = ?, progress = ?, skipped_by_etag = ? WHERE id = ?`,
					)
					.run(
						processed,
						entries.length === 0 ? 1 : processed / entries.length,
						skippedByEtag,
						jobId,
					);
			}

			// GC pass: any document tracked under this source whose path is no
			// longer reported by the connector listing is treated as removed at
			// the source and soft-deleted. We do this UNCONDITIONALLY for the
			// MVP because `walkConnector` either returns a complete listing or
			// throws (which is handled above and aborts the sync before this
			// point). Limitation: if we ever add support for partial walks
			// (e.g. continue-on-folder-error), this GC must become conditional
			// on "the listing is known to be complete" — otherwise an outage on
			// a single subfolder would soft-delete every doc under it.
			interface IndexedDocRow {
				id: string;
				path: string;
			}
			const indexedRows = deps.db
				.prepare<[string], IndexedDocRow>(
					`SELECT id, path FROM rag_documents WHERE source_id = ? AND deleted_at IS NULL`,
				)
				.all(source.id);
			const seenPaths = new Set(entries.map((e) => e.doc.path));
			for (const row of indexedRows) {
				if (!seenPaths.has(row.path)) {
					try {
						deps.pipeline.markDocumentDeleted(row.id);
						gcDeleted++;
					} catch (err: unknown) {
						failures++;
						lastError = err instanceof Error ? err.message : String(err);
					}
				}
			}

			const finalStatus: RagJobStatus = failures === 0 ? 'completed' : 'failed';
			const finishedAt = new Date().toISOString();
			deps.db
				.prepare(
					`UPDATE rag_jobs
					 SET status = ?, finished_at = ?, error = ?, progress = 1,
					     skipped_by_etag = ?, gc_deleted = ?
					 WHERE id = ?`,
				)
				.run(
					finalStatus,
					finishedAt,
					failures > 0 ? `${failures}/${entries.length} failed; last: ${lastError}` : null,
					skippedByEtag,
					gcDeleted,
					jobId,
				);
			deps.db
				.prepare(`UPDATE rag_sources SET last_sync_at = ? WHERE id = ?`)
				.run(finishedAt, id);

			deps.onAudit?.({
				type: failures === 0 ? 'rag.sync.completed' : 'rag.sync.partial',
				payload: {
					sourceId: id,
					jobId,
					total: entries.length,
					processed,
					skippedByEtag,
					gcDeleted,
					failures,
				},
				timestamp: finishedAt,
			});

			const final = deps.db
				.prepare<[string], JobRow>(`SELECT * FROM rag_jobs WHERE id = ?`)
				.get(jobId);
			res.status(200).json({ job: final ? rowToJob(final) : null });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			deps.db
				.prepare(`UPDATE rag_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
				.run(message, new Date().toISOString(), jobId);
			deps.onAudit?.({
				type: 'rag.sync.failed',
				payload: { sourceId: id, jobId, error: message },
				timestamp: new Date().toISOString(),
			});
			sendError(res, 500, message);
		}
	});
}
