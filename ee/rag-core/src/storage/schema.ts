// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import type { Database as BetterSqlite3Database } from 'better-sqlite3';

/**
 * Minimal database wrapper shape. Mirrors `CalameDatabase` from packages/cli but
 * only exposes the fields this migration needs. We intentionally avoid a hard
 * dependency on packages/cli — the host passes the wrapper in.
 */
export interface RagMigrationDb {
	raw: BetterSqlite3Database;
}

const CURRENT_RAG_SCHEMA_VERSION = 3;

/** Returns true if a column exists on a table. */
function hasColumn(db: BetterSqlite3Database, table: string, column: string): boolean {
	const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
	return cols.some((c) => c.name === column);
}

/** Idempotent ALTER TABLE — adds a column only when missing. */
function addColumnIfMissing(
	db: BetterSqlite3Database,
	table: string,
	column: string,
	type: string,
): void {
	if (!hasColumn(db, table, column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
	}
}

/** Read the current rag schema version from `rag_schema_version`. Returns 0 if not set. */
function getRagSchemaVersion(db: BetterSqlite3Database): number {
	db.exec(`CREATE TABLE IF NOT EXISTS rag_schema_version (
		key TEXT PRIMARY KEY,
		version INTEGER NOT NULL
	)`);
	const row = db.prepare(`SELECT version FROM rag_schema_version WHERE key = 'rag'`).get() as
		| { version: number }
		| undefined;
	return row?.version ?? 0;
}

/** Persist the rag schema version. */
function setRagSchemaVersion(db: BetterSqlite3Database, version: number): void {
	db.prepare(
		`INSERT INTO rag_schema_version (key, version) VALUES ('rag', ?)
		 ON CONFLICT(key) DO UPDATE SET version = excluded.version`,
	).run(version);
}

/**
 * Run idempotent RAG migrations on the supplied SQLite database.
 *
 * The RAG schema is **independently versioned** in `rag_schema_version` so it
 * never collides with the host's `schema_version` table.
 *
 * Note: the sqlite-vec virtual table (`rag_chunks_vec`) is NOT created here —
 * its dimension is dynamic per source/embedding model and is owned by
 * `SqliteVecStore`.
 */
export function runRagMigrations(db: RagMigrationDb): void {
	const raw = db.raw;
	const current = getRagSchemaVersion(raw);

	if (current < 1) {
		// v1 baseline. Note: `embedding_dimensions` is added in v2 — but for fresh
		// databases we include it directly in v1's CREATE so we don't need an ALTER
		// in v2 below. The v2 migration only handles upgrades from a v1 DB.
		raw.exec(`CREATE TABLE IF NOT EXISTS rag_sources (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			type TEXT NOT NULL,
			config_encrypted TEXT NOT NULL,
			embedding_setting_name TEXT NOT NULL,
			embedding_model_version TEXT NOT NULL,
			embedding_dimensions INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_sync_at TEXT
		)`);

		raw.exec(`CREATE TABLE IF NOT EXISTS rag_folders (
			id TEXT PRIMARY KEY,
			source_id TEXT NOT NULL,
			parent_id TEXT,
			path TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (source_id) REFERENCES rag_sources(id) ON DELETE CASCADE,
			FOREIGN KEY (parent_id) REFERENCES rag_folders(id) ON DELETE CASCADE
		)`);

		raw.exec(`CREATE TABLE IF NOT EXISTS rag_documents (
			id TEXT PRIMARY KEY,
			source_id TEXT NOT NULL,
			folder_id TEXT,
			path TEXT NOT NULL,
			name TEXT NOT NULL,
			mime_type TEXT NOT NULL,
			size INTEGER NOT NULL,
			hash TEXT NOT NULL,
			etag TEXT,
			last_indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
			deleted_at TEXT,
			FOREIGN KEY (source_id) REFERENCES rag_sources(id) ON DELETE CASCADE,
			FOREIGN KEY (folder_id) REFERENCES rag_folders(id) ON DELETE SET NULL
		)`);

		raw.exec(`CREATE TABLE IF NOT EXISTS rag_chunks (
			id TEXT PRIMARY KEY,
			document_id TEXT NOT NULL,
			position INTEGER NOT NULL,
			text TEXT NOT NULL,
			token_count INTEGER NOT NULL,
			embedding_dimensions INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (document_id) REFERENCES rag_documents(id) ON DELETE CASCADE
		)`);

		raw.exec(`CREATE TABLE IF NOT EXISTS rag_jobs (
			id TEXT PRIMARY KEY,
			source_id TEXT NOT NULL,
			status TEXT NOT NULL,
			progress REAL NOT NULL DEFAULT 0,
			total_documents INTEGER NOT NULL DEFAULT 0,
			processed_documents INTEGER NOT NULL DEFAULT 0,
			skipped_by_etag INTEGER NOT NULL DEFAULT 0,
			gc_deleted INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			finished_at TEXT,
			FOREIGN KEY (source_id) REFERENCES rag_sources(id) ON DELETE CASCADE
		)`);

		// Indexes on FKs and frequently filtered columns.
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_folders_source ON rag_folders(source_id)`);
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_folders_parent ON rag_folders(parent_id)`);
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_documents_source ON rag_documents(source_id)`);
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_documents_folder ON rag_documents(folder_id)`);
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_documents_deleted ON rag_documents(deleted_at)`);
		raw.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_documents_source_path ON rag_documents(source_id, path)`,
		);
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_document ON rag_chunks(document_id)`);
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_jobs_source ON rag_jobs(source_id)`);

		setRagSchemaVersion(raw, 1);
	}

	if (current < 2) {
		// v2 — add `embedding_dimensions` to rag_sources for hosts that already
		// have a v1 rag_sources table without that column. Default to 0 for
		// existing rows; the host MUST update them on its next sync (or the
		// admin must re-create the source). Phase 1 limitation, see
		// routes/rag-sources.ts for context.
		addColumnIfMissing(raw, 'rag_sources', 'embedding_dimensions', 'INTEGER NOT NULL DEFAULT 0');
		setRagSchemaVersion(raw, 2);
	}

	if (current < 3) {
		// v3 — extend rag_jobs with incremental-sync counters: `skipped_by_etag`
		// (docs whose etag matched the indexed copy and were skipped pre-fetch)
		// and `gc_deleted` (docs absent from the source listing and soft-deleted
		// by the GC pass). Both default to 0 so existing rows remain valid.
		addColumnIfMissing(raw, 'rag_jobs', 'skipped_by_etag', 'INTEGER NOT NULL DEFAULT 0');
		addColumnIfMissing(raw, 'rag_jobs', 'gc_deleted', 'INTEGER NOT NULL DEFAULT 0');
		setRagSchemaVersion(raw, 3);
	}

	// Future migrations slot here, each gated on `current < N`.
	// They MUST be idempotent and update `rag_schema_version` on success.
	if (current < CURRENT_RAG_SCHEMA_VERSION) {
		setRagSchemaVersion(raw, CURRENT_RAG_SCHEMA_VERSION);
	}
}
