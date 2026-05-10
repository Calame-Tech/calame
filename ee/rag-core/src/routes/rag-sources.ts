// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Express, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { RagSourceType } from '../types.js';
import type { RagSourcePublic } from './api-types.js';
import type { RagAuditEntry, RagRouteDeps } from './types.js';

const SOURCE_TYPES: ReadonlyArray<RagSourceType> = [
	'local',
	's3',
	'http',
	'gdrive',
	'gsheets',
	'sharepoint',
	'notion',
	'git',
];

/**
 * Phase 1 limitation — single dimension across all RAG sources.
 *
 * The `rag_chunks_vec` virtual table has a fixed dimension at create time
 * (sqlite-vec quirk). To keep Phase 1 simple, we enforce that ALL rag_sources
 * use embedding models with the same dimension count. The first source created
 * locks the dimension; subsequent sources that would use a different dimension
 * are rejected with HTTP 409.
 *
 * To change dimensions in Phase 1, the operator must drop `rag_chunks_vec` (and
 * ideally re-ingest from scratch). A future Phase will support per-source vec
 * tables and lift this constraint.
 */

/**
 * Body for POST /api/rag/sources.
 *
 * Note: the client only sends `embeddingSettingName` — the host derives the
 * concrete `embeddingModelVersion` and `embeddingDimensions` server-side via
 * `deps.resolveEmbeddingSetting`. This keeps the storage row authoritative
 * and prevents the client from desynchronizing model & dimension fields.
 */
const sourceCreateSchema = z.object({
	name: z.string().min(1).max(255),
	type: z.enum(SOURCE_TYPES as [RagSourceType, ...RagSourceType[]]),
	/** Decrypted, structured config object — encrypted server-side before persist. */
	config: z.record(z.string(), z.unknown()),
	embeddingSettingName: z.string().min(1),
	/**
	 * Optional auto-sync interval in seconds. `null` (or absent) disables
	 * polling; the source is then synced manually only. Range:
	 *   - min 60s — protects against accidental DB churn / connector DDoS,
	 *   - max 86400s (24h) — anything longer is more reliably handled by an
	 *     external cron in production.
	 */
	pollingIntervalSeconds: z.number().int().min(60).max(86400).nullable().optional(),
});

const sourcePatchSchema = sourceCreateSchema.partial();

interface SourceRow {
	id: string;
	name: string;
	type: string;
	config_encrypted: string;
	embedding_setting_name: string;
	embedding_model_version: string;
	embedding_dimensions: number;
	polling_interval_seconds: number | null;
	created_at: string;
	updated_at: string;
	last_sync_at: string | null;
}

/**
 * Project a SourceRow onto its public API shape, decrypting the config blob.
 *
 * Decryption errors do NOT throw — they're surfaced via `configError` so that a
 * single bad row doesn't break the entire list endpoint.
 */
function rowToSource(row: SourceRow, deps: RagRouteDeps): RagSourcePublic {
	let config: Record<string, unknown> | null = null;
	let configError: string | undefined;
	try {
		const plaintext = deps.decryptConfig(row.config_encrypted);
		const parsed: unknown = JSON.parse(plaintext);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			configError = 'Decrypted config is not a JSON object.';
		} else {
			config = parsed as Record<string, unknown>;
		}
	} catch (error: unknown) {
		configError = error instanceof Error ? error.message : 'Failed to decrypt config.';
	}

	const out: RagSourcePublic = {
		id: row.id,
		name: row.name,
		type: row.type as RagSourceType,
		config,
		embeddingSettingName: row.embedding_setting_name,
		embeddingModelVersion: row.embedding_model_version,
		embeddingDimensions: row.embedding_dimensions,
		pollingIntervalSeconds: row.polling_interval_seconds,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.last_sync_at !== null ? { lastSyncAt: row.last_sync_at } : {}),
		...(configError !== undefined ? { configError } : {}),
	};
	return out;
}

function audit(deps: RagRouteDeps, entry: Omit<RagAuditEntry, 'timestamp'>): void {
	deps.onAudit?.({ ...entry, timestamp: new Date().toISOString() });
}

function sendError(res: Response, status: number, message: string): void {
	res.status(status).json({ error: message });
}

/**
 * Returns the dimension already in use by existing rag_sources, or `null` when
 * the table is empty. Used to enforce the Phase 1 single-dimension invariant.
 */
function getCurrentDimension(deps: RagRouteDeps): number | null {
	const row = deps.db
		.prepare<[], { embedding_dimensions: number }>(
			`SELECT embedding_dimensions FROM rag_sources
			 WHERE embedding_dimensions > 0
			 ORDER BY created_at ASC LIMIT 1`,
		)
		.get();
	return row ? row.embedding_dimensions : null;
}

/**
 * Register CRUD + connection-test routes for RAG sources.
 *
 *  - POST   /api/rag/sources
 *  - GET    /api/rag/sources
 *  - GET    /api/rag/sources/:id
 *  - PATCH  /api/rag/sources/:id
 *  - DELETE /api/rag/sources/:id
 *  - POST   /api/rag/sources/:id/test
 */
export function registerRagSourcesRoutes(app: Express, deps: RagRouteDeps): void {
	app.get('/api/rag/sources', (_req: Request, res: Response) => {
		try {
			const rows = deps.db
				.prepare(`SELECT * FROM rag_sources ORDER BY created_at ASC`)
				.all() as SourceRow[];
			res.json({ sources: rows.map((r) => rowToSource(r, deps)) });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			audit(deps, { type: 'rag.sources.list.failed', payload: { error: message } });
			sendError(res, 500, message);
		}
	});

	app.get('/api/rag/sources/:id', (req: Request, res: Response) => {
		try {
			const id = String(req.params['id'] ?? '');
			const row = deps.db
				.prepare<[string], SourceRow>(`SELECT * FROM rag_sources WHERE id = ?`)
				.get(id);
			if (!row) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			res.json({ source: rowToSource(row, deps) });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			sendError(res, 500, message);
		}
	});

	app.post('/api/rag/sources', async (req: Request, res: Response) => {
		const parsed = sourceCreateSchema.safeParse(req.body);
		if (!parsed.success) {
			sendError(res, 400, parsed.error.issues.map((i) => i.message).join('; '));
			return;
		}

		// Resolve (model, dimensions) from the embedding setting name.
		let resolved: { embeddingModel: string; dimensions: number };
		try {
			resolved = deps.resolveEmbeddingSetting(parsed.data.embeddingSettingName);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			audit(deps, {
				type: 'rag.sources.create.failed',
				payload: { error: message, embeddingSettingName: parsed.data.embeddingSettingName },
			});
			sendError(res, 400, message);
			return;
		}

		// Phase 1: enforce a single dimension across all rag_sources.
		const currentDim = getCurrentDimension(deps);
		if (currentDim !== null && currentDim !== resolved.dimensions) {
			const message =
				`All RAG sources must use embedding models with the same dimension; ` +
				`existing sources use ${currentDim} dims, this would use ${resolved.dimensions}.`;
			audit(deps, {
				type: 'rag.sources.create.failed',
				payload: { error: message, embeddingSettingName: parsed.data.embeddingSettingName },
			});
			sendError(res, 409, message);
			return;
		}

		// Validate the connector config end-to-end before persisting. For local
		// sources this also auto-creates the rootPath when its parent exists,
		// so admins don't need to mkdir the folder manually.
		const connector = deps.resolveConnector?.(parsed.data.type);
		if (connector) {
			try {
				await connector.testConnection(parsed.data.config);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				audit(deps, {
					type: 'rag.sources.create.failed',
					payload: { error: message, type: parsed.data.type },
				});
				sendError(res, 400, `Connector validation failed: ${message}`);
				return;
			}
		}

		try {
			const id = nanoid();
			const now = new Date().toISOString();
			const encrypted = deps.encryptConfig(JSON.stringify(parsed.data.config));
			// `pollingIntervalSeconds` may be omitted (undefined) or explicitly null.
			// Both map to NULL in SQL — better-sqlite3 binds JS `null` to SQL NULL.
			const pollingInterval = parsed.data.pollingIntervalSeconds ?? null;
			deps.db
				.prepare(
					`INSERT INTO rag_sources
					 (id, name, type, config_encrypted, embedding_setting_name,
					  embedding_model_version, embedding_dimensions,
					  polling_interval_seconds,
					  created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					parsed.data.name,
					parsed.data.type,
					encrypted,
					parsed.data.embeddingSettingName,
					resolved.embeddingModel,
					resolved.dimensions,
					pollingInterval,
					now,
					now,
				);
			const row = deps.db
				.prepare<[string], SourceRow>(`SELECT * FROM rag_sources WHERE id = ?`)
				.get(id);
			// Register the scheduler timer when polling is enabled. We do this
			// AFTER the INSERT succeeded so a failed write doesn't leave a
			// dangling timer pointing at a nonexistent source.
			if (pollingInterval !== null) {
				deps.pollScheduler.upsert(id, pollingInterval);
			}
			// Register the real-time watcher. The manager is type-aware
			// and no-ops for non-local sources, so we call it unconditionally.
			// Passing the encrypted blob straight from the inserted row
			// keeps the call site terse — the manager decrypts internally.
			if (row) {
				deps.watchManager.upsert({
					id: row.id,
					type: row.type,
					configEncrypted: row.config_encrypted,
				});
			}
			audit(deps, { type: 'rag.sources.created', payload: { id, name: parsed.data.name } });
			res.status(201).json({ source: row ? rowToSource(row, deps) : null });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			audit(deps, { type: 'rag.sources.create.failed', payload: { error: message } });
			sendError(res, 500, message);
		}
	});

	app.patch('/api/rag/sources/:id', (req: Request, res: Response) => {
		const id = String(req.params['id'] ?? '');
		const parsed = sourcePatchSchema.safeParse(req.body);
		if (!parsed.success) {
			sendError(res, 400, parsed.error.issues.map((i) => i.message).join('; '));
			return;
		}
		try {
			const existing = deps.db
				.prepare<[string], SourceRow>(`SELECT * FROM rag_sources WHERE id = ?`)
				.get(id);
			if (!existing) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}

			// Re-resolve (model, dimensions) only when the embedding setting changes.
			let nextEmbeddingSettingName = existing.embedding_setting_name;
			let nextEmbeddingModel = existing.embedding_model_version;
			let nextEmbeddingDimensions = existing.embedding_dimensions;

			if (
				parsed.data.embeddingSettingName !== undefined &&
				parsed.data.embeddingSettingName !== existing.embedding_setting_name
			) {
				let resolved: { embeddingModel: string; dimensions: number };
				try {
					resolved = deps.resolveEmbeddingSetting(parsed.data.embeddingSettingName);
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : 'Unknown error';
					audit(deps, { type: 'rag.sources.update.failed', payload: { id, error: message } });
					sendError(res, 400, message);
					return;
				}

				// Phase 1 single-dimension invariant — also enforced on PATCH that
				// changes the embedding setting.
				const currentDim = getCurrentDimension(deps);
				if (currentDim !== null && currentDim !== resolved.dimensions) {
					const message =
						`All RAG sources must use embedding models with the same dimension; ` +
						`existing sources use ${currentDim} dims, this would use ${resolved.dimensions}.`;
					audit(deps, { type: 'rag.sources.update.failed', payload: { id, error: message } });
					sendError(res, 409, message);
					return;
				}

				nextEmbeddingSettingName = parsed.data.embeddingSettingName;
				nextEmbeddingModel = resolved.embeddingModel;
				nextEmbeddingDimensions = resolved.dimensions;
			}

			// Compute the next polling interval. `parsed.data.pollingIntervalSeconds`:
			//   - undefined → field absent from PATCH body, keep existing value,
			//   - null      → caller wants polling disabled,
			//   - number    → caller wants polling enabled at that interval.
			// The Zod schema already constrains the number to [60, 86400].
			const pollingChanged = Object.prototype.hasOwnProperty.call(
				parsed.data,
				'pollingIntervalSeconds',
			);
			const nextPollingInterval = pollingChanged
				? (parsed.data.pollingIntervalSeconds ?? null)
				: existing.polling_interval_seconds;

			const next = {
				name: parsed.data.name ?? existing.name,
				type: parsed.data.type ?? existing.type,
				config_encrypted:
					parsed.data.config !== undefined
						? deps.encryptConfig(JSON.stringify(parsed.data.config))
						: existing.config_encrypted,
				embedding_setting_name: nextEmbeddingSettingName,
				embedding_model_version: nextEmbeddingModel,
				embedding_dimensions: nextEmbeddingDimensions,
				polling_interval_seconds: nextPollingInterval,
			};
			const now = new Date().toISOString();
			deps.db
				.prepare(
					`UPDATE rag_sources
					 SET name = ?, type = ?, config_encrypted = ?, embedding_setting_name = ?,
					     embedding_model_version = ?, embedding_dimensions = ?,
					     polling_interval_seconds = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.run(
					next.name,
					next.type,
					next.config_encrypted,
					next.embedding_setting_name,
					next.embedding_model_version,
					next.embedding_dimensions,
					next.polling_interval_seconds,
					now,
					id,
				);
			// Sync the in-process timer registry with whatever value just landed
			// in the DB. We only re-call upsert when the field actually changed
			// to avoid resetting an active timer (which would push the next
			// fire forward by `intervalSeconds`) on unrelated PATCHes.
			if (pollingChanged) {
				deps.pollScheduler.upsert(id, next.polling_interval_seconds);
			}
			const row = deps.db
				.prepare<[string], SourceRow>(`SELECT * FROM rag_sources WHERE id = ?`)
				.get(id);
			// Refresh the real-time watcher whenever the type or config changed.
			// The manager replaces the existing watcher in-place — closing the
			// old chokidar handle and starting a new one — so a rootPath or
			// globs change is reflected immediately. No-op for non-local types
			// (the manager removes any existing watcher and returns).
			const watchSensitiveChanged =
				parsed.data.type !== undefined || parsed.data.config !== undefined;
			if (row && watchSensitiveChanged) {
				deps.watchManager.upsert({
					id: row.id,
					type: row.type,
					configEncrypted: row.config_encrypted,
				});
			}
			audit(deps, { type: 'rag.sources.updated', payload: { id } });
			res.json({ source: row ? rowToSource(row, deps) : null });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			audit(deps, { type: 'rag.sources.update.failed', payload: { id, error: message } });
			sendError(res, 500, message);
		}
	});

	app.delete('/api/rag/sources/:id', (req: Request, res: Response) => {
		const id = String(req.params['id'] ?? '');
		try {
			const result = deps.db.prepare(`DELETE FROM rag_sources WHERE id = ?`).run(id);
			if (result.changes === 0) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			// Clear any registered poll timer. `remove` is idempotent so calling
			// it on a source that never had polling enabled is a no-op.
			deps.pollScheduler.remove(id);
			deps.watchManager.remove(id);
			audit(deps, { type: 'rag.sources.deleted', payload: { id } });
			res.json({ success: true });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			audit(deps, { type: 'rag.sources.delete.failed', payload: { id, error: message } });
			sendError(res, 500, message);
		}
	});

	/**
	 * POST /api/rag/sources/:id/test — Validate connector reachability.
	 *
	 * For `local`, the connector's `testConnection` is invoked: it auto-creates
	 * the rootPath when its parent directory exists (typo guard), and surfaces
	 * filesystem errors with a clear message. Other source types respond 501
	 * until their connectors land.
	 */
	app.post('/api/rag/sources/:id/test', async (req: Request, res: Response) => {
		const id = String(req.params['id'] ?? '');
		try {
			const row = deps.db
				.prepare<[string], SourceRow>(`SELECT * FROM rag_sources WHERE id = ?`)
				.get(id);
			if (!row) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			const connector = deps.resolveConnector?.(row.type);
			if (!connector) {
				sendError(
					res,
					501,
					`Source type "${row.type}" is not yet supported. Install the corresponding connector or wait until it lands.`,
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
			try {
				await connector.testConnection(config);
			} catch (err: unknown) {
				const m = err instanceof Error ? err.message : String(err);
				audit(deps, { type: 'rag.sources.test.failed', payload: { id, error: m } });
				res.status(400).json({ ok: false, error: m });
				return;
			}
			audit(deps, { type: 'rag.sources.test.ok', payload: { id, type: row.type } });
			res.json({ ok: true });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			audit(deps, { type: 'rag.sources.test.failed', payload: { id, error: message } });
			sendError(res, 500, message);
		}
	});
}
