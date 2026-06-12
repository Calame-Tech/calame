// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Express, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { RagSourceType } from '../types.js';
import type { RagSourcePublic } from './api-types.js';
import type { RagAuditEntry, RagRouteDeps } from './types.js';

/**
 * Resolve the tenant id for a request, falling back to the literal
 * `'default'` when the host hasn't wired a resolver (e.g. test deps).
 * Kept local to keep `ee/rag-core` decoupled from `packages/cli`.
 *
 * Phase B: every read path binds the resolved value into a
 * `WHERE tenant_id = ?` clause; cross-tenant ids land as 404.
 */
function resolveTenantId(deps: RagRouteDeps, req?: Request): string {
	return deps.getTenantId ? deps.getTenantId(req) : 'default';
}

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
	/** Phase B multi-tenancy column — bound on every read. */
	tenant_id: string;
	created_at: string;
	updated_at: string;
	last_sync_at: string | null;
	/** Phase 12 (Q7) soft-delete marker — null when active, ISO timestamp when soft-deleted. */
	deleted_at: string | null;
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
		// Defensive `?? 'default'` covers test fixtures that hand-roll a row
		// without going through `runRagMigrations` — the column doesn't exist
		// there yet, so the projection lands as `undefined` at runtime.
		tenantId: row.tenant_id ?? 'default',
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		// Same defensive `?? null` pattern as `tenantId` above — fixtures that
		// bypass the v8 migration project the column as undefined; we normalize
		// to `null` so the public API contract stays stable.
		deletedAt: row.deleted_at ?? null,
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
 * Returns the dimension already in use by existing rag_sources within the
 * supplied tenant, or `null` when the table is empty for that tenant. Used
 * to enforce the Phase 1 single-dimension invariant — scoped per tenant
 * since each tenant gets its own population of sources.
 */
function getCurrentDimension(deps: RagRouteDeps, tenantId: string): number | null {
	// Exclude soft-deleted rows so an admin can recover from "stuck on the
	// wrong dimension" by soft-deleting every existing source and creating a
	// new one with a different model. Without this clause the Phase 1
	// single-dimension invariant would keep blocking the new source forever.
	const row = deps.db
		.prepare<[string], { embedding_dimensions: number }>(
			`SELECT embedding_dimensions FROM rag_sources
			 WHERE embedding_dimensions > 0
			   AND deleted_at IS NULL
			   AND tenant_id = ?
			 ORDER BY created_at ASC LIMIT 1`,
		)
		.get(tenantId);
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
 *
 * Phase B multi-tenancy: every read path binds `tenant_id = ?`. Cross-
 * tenant ids surface as 404 so the existence of the foreign row is not
 * leaked.
 */
export function registerRagSourcesRoutes(app: Express, deps: RagRouteDeps): void {
	app.get('/api/rag/sources', (req: Request, res: Response) => {
		try {
			const tenantId = resolveTenantId(deps, req);
			// `?filter=deleted` returns ONLY soft-deleted sources (UI "Recently deleted" view).
			// `?includeDeleted=true` returns active AND soft-deleted (admin tooling).
			// Default: active only — `deleted_at IS NULL`.
			const filter = req.query['filter'];
			const includeDeleted = req.query['includeDeleted'];
			const onlyDeleted = filter === 'deleted';
			const showDeleted =
				onlyDeleted ||
				includeDeleted === 'true' ||
				includeDeleted === '1';

			let sql: string;
			if (onlyDeleted) {
				sql = `SELECT * FROM rag_sources
				       WHERE deleted_at IS NOT NULL AND tenant_id = ?
				       ORDER BY deleted_at DESC`;
			} else if (showDeleted) {
				sql = `SELECT * FROM rag_sources
				       WHERE tenant_id = ?
				       ORDER BY created_at ASC`;
			} else {
				sql = `SELECT * FROM rag_sources
				       WHERE deleted_at IS NULL AND tenant_id = ?
				       ORDER BY created_at ASC`;
			}
			const rows = deps.db.prepare<[string], SourceRow>(sql).all(tenantId);
			res.json({ sources: rows.map((r) => rowToSource(r, deps)) });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			audit(deps, { type: 'rag.sources.list.failed', payload: { error: message } });
			sendError(res, 500, message);
		}
	});

	app.get('/api/rag/sources/:id', (req: Request, res: Response) => {
		try {
			const tenantId = resolveTenantId(deps, req);
			const id = String(req.params['id'] ?? '');
			const includeDeleted = req.query['includeDeleted'];
			const showDeleted = includeDeleted === 'true' || includeDeleted === '1';
			// Bind the tenant directly in the SELECT so a row in another tenant
			// surfaces as 404 (rather than 200 with cross-tenant content).
			const row = deps.db
				.prepare<[string, string], SourceRow>(
					`SELECT * FROM rag_sources WHERE id = ? AND tenant_id = ?`,
				)
				.get(id, tenantId);
			if (!row) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			// Soft-deleted sources are 404 by default — admin tools opt in via
			// `?includeDeleted=true` (used by the "Recently deleted" restore flow).
			if (row.deleted_at !== null && !showDeleted) {
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

		// Phase B multi-tenancy — the single-dimension invariant is scoped per
		// tenant. Each tenant's source population is independent, so a new
		// tenant can pick a different embedding model without colliding with
		// the default tenant's invariant.
		const tenantId = resolveTenantId(deps, req);
		const currentDim = getCurrentDimension(deps, tenantId);
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
					  polling_interval_seconds, tenant_id,
					  created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
					tenantId,
					now,
					now,
				);
			const row = deps.db
				.prepare<[string, string], SourceRow>(
					`SELECT * FROM rag_sources WHERE id = ? AND tenant_id = ?`,
				)
				.get(id, tenantId);
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
			const tenantId = resolveTenantId(deps, req);
			// Tenant-scoped lookup — cross-tenant ids land as 404 here too so
			// PATCH never surfaces "exists" / "doesn't exist" leakage.
			const existing = deps.db
				.prepare<[string, string], SourceRow>(
					`SELECT * FROM rag_sources WHERE id = ? AND tenant_id = ?`,
				)
				.get(id, tenantId);
			if (!existing) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			// PATCH on a soft-deleted source is a 404 — callers must `restore`
			// first. Returning 404 (rather than 409 / 410) matches the
			// "invisible to admins" semantics enforced by GET.
			if (existing.deleted_at !== null) {
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
				// changes the embedding setting. Scoped per tenant.
				const currentDim = getCurrentDimension(deps, tenantId);
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
					 WHERE id = ? AND tenant_id = ?`,
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
					tenantId,
				);
			// Sync the in-process timer registry with whatever value just landed
			// in the DB. We only re-call upsert when the field actually changed
			// to avoid resetting an active timer (which would push the next
			// fire forward by `intervalSeconds`) on unrelated PATCHes.
			if (pollingChanged) {
				deps.pollScheduler.upsert(id, next.polling_interval_seconds);
			}
			const row = deps.db
				.prepare<[string, string], SourceRow>(
					`SELECT * FROM rag_sources WHERE id = ? AND tenant_id = ?`,
				)
				.get(id, tenantId);
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

	/**
	 * DELETE /api/rag/sources/:id — Phase 12 (Q7) soft delete.
	 *
	 * Marks the source as soft-deleted (`deleted_at = now`) rather than
	 * dropping the row. The cleanup cron (`jobs/soft-delete-cleanup.ts`) runs
	 * at boot and hard-deletes any source whose `deleted_at` is older than 7
	 * days, cascading every dependent `rag_folders` / `rag_documents` /
	 * `rag_chunks` / `rag_jobs` row through the FKs declared at v1.
	 *
	 * The poll scheduler and watch manager are torn down immediately so a
	 * soft-deleted source never fires a sync — the timers / handles are
	 * re-registered by the `POST /:id/restore` endpoint if the source is
	 * recovered within the 7-day window.
	 *
	 * Admin force-delete: `POST` to `/:id/permanent` (or use any of the
	 * permanent-delete query flags described in that handler) to bypass the
	 * retention window and hard-delete immediately.
	 */
	app.delete('/api/rag/sources/:id', (req: Request, res: Response) => {
		const id = String(req.params['id'] ?? '');
		try {
			const tenantId = resolveTenantId(deps, req);
			// Look up first so we can distinguish "never existed" from
			// "already soft-deleted" and produce a clear error message. Cross-
			// tenant ids never make it past this lookup → 404.
			const existing = deps.db
				.prepare<[string, string], { id: string; deleted_at: string | null }>(
					`SELECT id, deleted_at FROM rag_sources WHERE id = ? AND tenant_id = ?`,
				)
				.get(id, tenantId);
			if (!existing) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			if (existing.deleted_at !== null) {
				// Already soft-deleted — surface 410 Gone so the UI can render
				// "this source is already in the trash" without falling back
				// to the generic 404 path.
				sendError(res, 410, `Source "${id}" is already deleted.`);
				return;
			}
			const now = new Date().toISOString();
			deps.db
				.prepare(
					`UPDATE rag_sources SET deleted_at = ?, updated_at = ?
					 WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
				)
				.run(now, now, id, tenantId);
			// Clear any registered poll timer / watcher. `remove` is idempotent so
			// calling it on a source that never had polling enabled is a no-op.
			deps.pollScheduler.remove(id);
			deps.watchManager.remove(id);
			audit(deps, { type: 'rag.sources.soft_deleted', payload: { id, deletedAt: now } });
			res.json({ success: true, deletedAt: now });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			audit(deps, { type: 'rag.sources.soft_delete.failed', payload: { id, error: message } });
			sendError(res, 500, message);
		}
	});

	/**
	 * POST /api/rag/sources/:id/restore — un-soft-delete a source within the
	 * 7-day retention window. After this call the source is visible again,
	 * its child rows (folders / documents / chunks / jobs) become accessible
	 * to listings and search, and the poll scheduler / watch manager are
	 * re-registered if `polling_interval_seconds` is set or `type === 'local'`.
	 */
	app.post('/api/rag/sources/:id/restore', (req: Request, res: Response) => {
		const id = String(req.params['id'] ?? '');
		try {
			const tenantId = resolveTenantId(deps, req);
			const existing = deps.db
				.prepare<[string, string], SourceRow>(
					`SELECT * FROM rag_sources WHERE id = ? AND tenant_id = ?`,
				)
				.get(id, tenantId);
			if (!existing) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			if (existing.deleted_at === null) {
				sendError(res, 400, `Source "${id}" is not deleted.`);
				return;
			}
			const now = new Date().toISOString();
			deps.db
				.prepare(
					`UPDATE rag_sources SET deleted_at = NULL, updated_at = ?
					 WHERE id = ? AND tenant_id = ?`,
				)
				.run(now, id, tenantId);
			// Re-register the poll timer and watcher. Both `upsert` methods
			// are idempotent — they replace any existing state in place —
			// so calling them here is safe even when the source had its
			// timer/watcher torn down at soft-delete time.
			if (existing.polling_interval_seconds !== null) {
				deps.pollScheduler.upsert(id, existing.polling_interval_seconds);
			}
			deps.watchManager.upsert({
				id: existing.id,
				type: existing.type,
				configEncrypted: existing.config_encrypted,
			});
			const row = deps.db
				.prepare<[string, string], SourceRow>(
					`SELECT * FROM rag_sources WHERE id = ? AND tenant_id = ?`,
				)
				.get(id, tenantId);
			audit(deps, { type: 'rag.sources.restored', payload: { id } });
			res.json({ source: row ? rowToSource(row, deps) : null });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			audit(deps, { type: 'rag.sources.restore.failed', payload: { id, error: message } });
			sendError(res, 500, message);
		}
	});

	/**
	 * DELETE /api/rag/sources/:id/permanent — admin force-delete bypassing
	 * the 7-day retention window. Hard-deletes the row and lets the FK
	 * ON DELETE CASCADE clauses drop every dependent `rag_folders` /
	 * `rag_documents` / `rag_chunks` / `rag_jobs` row in the same
	 * transaction. Vector embeddings are wiped via `vectorStore.deleteByDocument`
	 * for each document BEFORE the SQL cascade, because the FK cascade has
	 * no visibility into the sqlite-vec virtual table.
	 *
	 * Callable on either an active source or a soft-deleted one — the
	 * endpoint exists for both "I really want this gone right now" and
	 * "cleanup the trash early" workflows.
	 */
	app.delete('/api/rag/sources/:id/permanent', (req: Request, res: Response) => {
		const id = String(req.params['id'] ?? '');
		try {
			const tenantId = resolveTenantId(deps, req);
			const existing = deps.db
				.prepare<[string, string], SourceRow>(
					`SELECT * FROM rag_sources WHERE id = ? AND tenant_id = ?`,
				)
				.get(id, tenantId);
			if (!existing) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}

			// 1. Wipe vector embeddings for every document of the source.
			// We do this BEFORE the SQL cascade so the vec0 index doesn't
			// carry orphan vectors pointing at deleted chunk ids.
			const docIds = deps.db
				.prepare<[string], { id: string }>(
					`SELECT id FROM rag_documents WHERE source_id = ?`,
				)
				.all(id);
			for (const doc of docIds) {
				try {
					deps.vectorStore.deleteByDocument(doc.id);
				} catch {
					// Never let a vector store error prevent the SQL cascade —
					// any orphan vectors will be re-cleaned at the next
					// vacuum pass. We still hard-delete the row so the source
					// disappears from the UI immediately.
				}
			}

			// 2. Tear down any in-process timer / watcher. Idempotent.
			deps.pollScheduler.remove(id);
			deps.watchManager.remove(id);

			// 3. Explicit cascade. The v1 baseline declares ON DELETE CASCADE
			// on every FK pointing at rag_sources(id), but FK enforcement is
			// only active when the host enables `PRAGMA foreign_keys = ON`
			// (which `packages/cli/src/database.ts` does). Tests build raw
			// in-memory DBs that DON'T enable FK enforcement — running the
			// cascade manually inside a single transaction guarantees the
			// same result regardless of the PRAGMA state and keeps the audit
			// counts accurate. The final DELETE on rag_sources binds
			// `tenant_id` defensively so concurrent writers in another tenant
			// can't observe a partial cascade.
			const cascade = deps.db.transaction((sourceId: string, tenant: string) => {
				deps.db
					.prepare(
						`DELETE FROM rag_chunks WHERE document_id IN (SELECT id FROM rag_documents WHERE source_id = ?)`,
					)
					.run(sourceId);
				deps.db.prepare(`DELETE FROM rag_documents WHERE source_id = ?`).run(sourceId);
				deps.db.prepare(`DELETE FROM rag_folders WHERE source_id = ?`).run(sourceId);
				deps.db.prepare(`DELETE FROM rag_jobs WHERE source_id = ?`).run(sourceId);
				deps.db
					.prepare(`DELETE FROM rag_sources WHERE id = ? AND tenant_id = ?`)
					.run(sourceId, tenant);
			});
			cascade(id, tenantId);

			audit(deps, {
				type: 'rag.sources.hard_deleted',
				payload: { id, documentsWiped: docIds.length },
			});
			res.json({ success: true, documentsWiped: docIds.length });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			audit(deps, { type: 'rag.sources.hard_delete.failed', payload: { id, error: message } });
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
			const tenantId = resolveTenantId(deps, req);
			const row = deps.db
				.prepare<[string, string], SourceRow>(
					`SELECT * FROM rag_sources WHERE id = ? AND tenant_id = ?`,
				)
				.get(id, tenantId);
			if (!row) {
				sendError(res, 404, `Source "${id}" not found.`);
				return;
			}
			// Soft-deleted sources are off-limits to the test endpoint — the
			// connector may have been disabled / its credentials rotated since
			// the source was retired. Restore first if you want to re-test.
			if (row.deleted_at !== null) {
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
