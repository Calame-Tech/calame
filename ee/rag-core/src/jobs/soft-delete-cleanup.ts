// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { VectorStore } from '../types.js';

/**
 * Audit hook entry shape — duplicated from routes/types.ts so this module has
 * no upstream dependency on the route layer. Mirrors the shape used by the
 * host's audit log.
 */
export interface SoftDeleteCleanupAuditEntry {
	type: string;
	payload: Record<string, unknown>;
	timestamp: string;
}

/**
 * Dependencies wired into {@link runSoftDeleteCleanup}.
 *
 * The function deliberately does NOT pull a host-side cron primitive — it is
 * called once at boot from `rag-runtime.ts` and runs synchronously to
 * completion. Hosts that want a recurring schedule layer a `setInterval` on
 * top; for MVP the single-boot pass suffices because servers reboot often
 * enough that a 7-day window rarely lapses without a chance to fire.
 */
export interface SoftDeleteCleanupDeps {
	/** Shared SQLite handle. */
	db: BetterSqlite3Database;
	/**
	 * Vector store backing the chunks for the doomed sources. Embeddings are
	 * deleted BEFORE the SQL cascade so the vec0 virtual table doesn't carry
	 * orphan vectors pointing at deleted chunk ids.
	 */
	vectorStore: VectorStore;
	/**
	 * Retention window in days. Sources soft-deleted more than this many days
	 * ago are hard-deleted. Defaults to 7 (matches §12 Q7 of the RAG plan).
	 */
	retentionDays?: number;
	/** Optional audit hook called once per hard-deleted source plus a summary. */
	onAudit?: (event: SoftDeleteCleanupAuditEntry) => void;
	/** Optional clock injection point — tests pin `now` to make assertions stable. */
	now?: () => Date;
}

/**
 * Result of a {@link runSoftDeleteCleanup} pass. Surfaced to the caller so the
 * host can log a one-line summary on boot.
 */
export interface SoftDeleteCleanupResult {
	/** Number of `rag_sources` rows hard-deleted by this pass. */
	hardDeletedSources: number;
	/** Number of `rag_documents` rows wiped (== sum across all deleted sources). */
	wipedDocuments: number;
	/** Number of `rag_chunks` rows wiped. */
	wipedChunks: number;
	/** Number of `rag_jobs` rows wiped. */
	wipedJobs: number;
	/** Number of `rag_folders` rows wiped. */
	wipedFolders: number;
}

/**
 * Walk the `rag_sources` table and hard-delete every row whose `deleted_at`
 * timestamp is older than `retentionDays` (default: 7) days.
 *
 * **Algorithm**:
 *   1. SELECT id FROM rag_sources WHERE deleted_at IS NOT NULL AND deleted_at < ?
 *   2. For each expired source:
 *      a. Pull the list of document ids (needed for the vec0 wipe).
 *      b. Call `vectorStore.deleteByDocument(docId)` for each — failures are
 *         logged via the audit hook but do not abort the cascade.
 *      c. Inside a single SQLite transaction, DELETE the chunks → documents →
 *         folders → jobs → source. The FK ON DELETE CASCADE clauses declared
 *         in v1 would cover the same ground when `PRAGMA foreign_keys = ON`,
 *         but we run the cascade manually so the cleanup works on any host
 *         configuration (and on the in-memory DBs that tests use, where the
 *         pragma is off by default).
 *
 * **Idempotency**: the function is a no-op when no expired sources exist —
 * safe to invoke at every boot. Re-running it on the same DB never produces
 * duplicate audit events because the source row is gone after the first pass.
 *
 * **Failure handling**: the function returns the partial counts even when one
 * source's cleanup throws. Callers (rag-runtime.ts) wrap it in a try/catch
 * and log a warning — the boot path must never abort on a cleanup failure.
 *
 * @param deps see {@link SoftDeleteCleanupDeps}
 * @returns the count of rows touched, per table
 */
export function runSoftDeleteCleanup(
	deps: SoftDeleteCleanupDeps,
): SoftDeleteCleanupResult {
	const retentionDays = deps.retentionDays ?? 7;
	const now = (deps.now ?? (() => new Date()))();
	const cutoffIso = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

	// Defensive: the `deleted_at` column may not exist yet on legacy DBs that
	// haven't replayed `runRagMigrations`. Probe before SELECTing so the
	// boot-time call doesn't crash on a pre-v8 schema.
	const cols = deps.db.pragma('table_info(rag_sources)') as Array<{ name: string }>;
	if (!cols.some((c) => c.name === 'deleted_at')) {
		return {
			hardDeletedSources: 0,
			wipedDocuments: 0,
			wipedChunks: 0,
			wipedFolders: 0,
			wipedJobs: 0,
		};
	}

	const expired = deps.db
		.prepare<[string], { id: string }>(
			`SELECT id FROM rag_sources WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
		)
		.all(cutoffIso);

	const result: SoftDeleteCleanupResult = {
		hardDeletedSources: 0,
		wipedDocuments: 0,
		wipedChunks: 0,
		wipedFolders: 0,
		wipedJobs: 0,
	};

	for (const { id: sourceId } of expired) {
		try {
			const docIds = deps.db
				.prepare<[string], { id: string }>(
					`SELECT id FROM rag_documents WHERE source_id = ?`,
				)
				.all(sourceId);
			for (const doc of docIds) {
				try {
					deps.vectorStore.deleteByDocument(doc.id);
				} catch (err: unknown) {
					// Surface the failure but keep going — the SQL cascade
					// still needs to land. Orphan vectors will be cleaned up
					// at the next vacuum / re-index.
					const message = err instanceof Error ? err.message : String(err);
					deps.onAudit?.({
						type: 'rag.cleanup.vector_wipe.failed',
						payload: { sourceId, documentId: doc.id, error: message },
						timestamp: new Date().toISOString(),
					});
				}
			}

			// Run the cascade inside a single transaction so a partial
			// failure rolls everything back and the source remains
			// soft-deleted (eligible for the next pass).
			let chunkChanges = 0;
			let docChanges = 0;
			let folderChanges = 0;
			let jobChanges = 0;
			let sourceChanges = 0;
			const cascade = deps.db.transaction((targetId: string) => {
				chunkChanges = deps.db
					.prepare(
						`DELETE FROM rag_chunks WHERE document_id IN (SELECT id FROM rag_documents WHERE source_id = ?)`,
					)
					.run(targetId).changes;
				docChanges = deps.db
					.prepare(`DELETE FROM rag_documents WHERE source_id = ?`)
					.run(targetId).changes;
				folderChanges = deps.db
					.prepare(`DELETE FROM rag_folders WHERE source_id = ?`)
					.run(targetId).changes;
				jobChanges = deps.db
					.prepare(`DELETE FROM rag_jobs WHERE source_id = ?`)
					.run(targetId).changes;
				sourceChanges = deps.db
					.prepare(`DELETE FROM rag_sources WHERE id = ?`)
					.run(targetId).changes;
			});
			cascade(sourceId);

			result.hardDeletedSources += sourceChanges;
			result.wipedChunks += chunkChanges;
			result.wipedDocuments += docChanges;
			result.wipedFolders += folderChanges;
			result.wipedJobs += jobChanges;

			deps.onAudit?.({
				type: 'rag.sources.hard_deleted',
				payload: {
					id: sourceId,
					reason: 'soft-delete-retention-expired',
					retentionDays,
					documentsWiped: docChanges,
					chunksWiped: chunkChanges,
					foldersWiped: folderChanges,
					jobsWiped: jobChanges,
				},
				timestamp: new Date().toISOString(),
			});
		} catch (err: unknown) {
			// Single-source failure: log and continue with the next id so a
			// single bad row doesn't block the entire pass.
			const message = err instanceof Error ? err.message : String(err);
			deps.onAudit?.({
				type: 'rag.cleanup.cascade.failed',
				payload: { sourceId, error: message },
				timestamp: new Date().toISOString(),
			});
		}
	}

	if (result.hardDeletedSources > 0) {
		deps.onAudit?.({
			type: 'rag.cleanup.completed',
			payload: {
				retentionDays,
				cutoffIso,
				hardDeletedSources: result.hardDeletedSources,
				wipedDocuments: result.wipedDocuments,
				wipedChunks: result.wipedChunks,
				wipedFolders: result.wipedFolders,
				wipedJobs: result.wipedJobs,
			},
			timestamp: new Date().toISOString(),
		});
	}

	return result;
}
