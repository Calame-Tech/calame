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

const CURRENT_RAG_SCHEMA_VERSION = 9;

/**
 * Default tenant id used by Phase A of the multi-tenancy rollout. The column is
 * present on every RAG table from v6 onwards but no route enforces tenant
 * scoping yet — every existing row and every fresh INSERT goes under this
 * literal. Phase B will resolve the value from the authenticated request and
 * filter SELECTs.
 *
 * Kept here (and not imported from `packages/cli/src/tenancy.ts`) to avoid
 * cross-package dependency cycles — `ee/rag-core` MUST NOT depend on the host.
 */
const DEFAULT_TENANT_ID = 'default';

/** Returns true if a column exists on a table. */
function hasColumn(db: BetterSqlite3Database, table: string, column: string): boolean {
	const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
	return cols.some((c) => c.name === column);
}

/** Returns true if a table exists. Works for both regular and virtual tables. */
function hasTable(db: BetterSqlite3Database, name: string): boolean {
	const row = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
		.get(name) as { name: string } | undefined;
	return row !== undefined;
}

/**
 * Create the FTS5 virtual table mirroring `rag_chunks.text` plus the
 * insert/update/delete triggers that keep it in sync. Idempotent —
 * uses `IF NOT EXISTS` guards everywhere and back-fills existing rows
 * the first time it is run.
 *
 * Configuration:
 *  - `content='rag_chunks'` + `content_rowid='rowid'` enables FTS5's
 *    "external content" mode: the FTS table only stores the index,
 *    not a copy of the text. Saves disk on large corpora.
 *  - `porter unicode61 remove_diacritics 2` applies English stemming
 *    on top of unicode-normalized tokens with diacritics stripped.
 *    Acceptable default for fr/es content; a per-mimetype tokenizer
 *    selection is out of scope for this tranche.
 *
 * NOTE (commercial frontier): hybrid retrieval (FTS5 + RRF fusion)
 * lives in `ee/rag-core/` for this tranche. If the boundary between
 * "free" (vector-only) and "Pro" (hybrid + reranker) hardens, this
 * block plus `search/hybrid-search.ts` can be extracted into a
 * separate `ee/rag-advanced` package without touching the
 * DocumentSearchIndex contract — the host already injects the
 * implementation.
 */
function createFtsTableAndTriggers(db: BetterSqlite3Database): void {
	// Defensive guard for partial-schema DBs (typically test fixtures that
	// only seed `rag_sources` + `rag_schema_version` to exercise upgrade
	// paths). In a real installation `rag_chunks` is always created by the
	// v1 baseline, but we don't want this step to crash on incomplete
	// fixtures — the table can simply be skipped and the next sync will
	// trigger a full re-run when chunks first appear.
	if (!hasTable(db, 'rag_chunks')) {
		return;
	}

	if (!hasTable(db, 'rag_chunks_fts')) {
		db.exec(
			`CREATE VIRTUAL TABLE rag_chunks_fts USING fts5(
				text,
				content='rag_chunks',
				content_rowid='rowid',
				tokenize='porter unicode61 remove_diacritics 2'
			)`,
		);
	}

	// Triggers — CREATE TRIGGER IF NOT EXISTS is supported by sqlite, so the
	// migration is safe to re-run.
	db.exec(`CREATE TRIGGER IF NOT EXISTS rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
		INSERT INTO rag_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
	END`);
	db.exec(`CREATE TRIGGER IF NOT EXISTS rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
		INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
	END`);
	db.exec(`CREATE TRIGGER IF NOT EXISTS rag_chunks_au AFTER UPDATE ON rag_chunks BEGIN
		INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
		INSERT INTO rag_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
	END`);

	// Back-fill — covers two cases:
	//   1. Upgrade from v4: rag_chunks_fts is new and empty.
	//   2. Fresh v5 DB created before any chunks were inserted: nothing to copy.
	// The insert is keyed by rowid so re-running it is a no-op on already
	// indexed rows in external-content mode (FTS5 dedupes by rowid in the
	// index — re-inserting the same rowid+text simply replaces the entry).
	const chunkCount = db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks`).get() as { n: number };
	if (chunkCount.n > 0) {
		db.exec(`INSERT INTO rag_chunks_fts(rowid, text) SELECT rowid, text FROM rag_chunks`);
	}
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
		// `tenant_id` (added at v6) is included in the v1 baseline DDL so fresh
		// installs don't have to walk the upgrade path. Existing v1..v5 databases
		// pick it up via `addColumnIfMissing` in the v6 branch below. The default
		// value 'default' matches DEFAULT_TENANT_ID — every row written before
		// the auth-integrated phase lands implicitly under that tenant.
		raw.exec(`CREATE TABLE IF NOT EXISTS rag_sources (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			type TEXT NOT NULL,
			config_encrypted TEXT NOT NULL,
			embedding_setting_name TEXT NOT NULL,
			embedding_model_version TEXT NOT NULL,
			embedding_dimensions INTEGER NOT NULL DEFAULT 0,
			polling_interval_seconds INTEGER,
			tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_sync_at TEXT,
			deleted_at TEXT
		)`);

		raw.exec(`CREATE TABLE IF NOT EXISTS rag_folders (
			id TEXT PRIMARY KEY,
			source_id TEXT NOT NULL,
			parent_id TEXT,
			path TEXT NOT NULL,
			name TEXT NOT NULL,
			tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
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
			tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
			last_indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
			deleted_at TEXT,
			ingest_error TEXT,
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
			tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
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
			tokens_embedded INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
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

		// Soft-delete index — supports the `WHERE deleted_at IS NULL` filter
		// applied to every listing query plus the `WHERE deleted_at < ?`
		// scan run by the boot-time cleanup cron (see jobs/soft-delete-cleanup.ts).
		// Added at v1 for fresh DBs so the index is present from day one; the
		// v8 migration below back-fills it on upgraded DBs via
		// `CREATE INDEX IF NOT EXISTS`.
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_sources_deleted_at ON rag_sources(deleted_at)`);

		// Tenant indexes — created here so fresh DBs are ready for the
		// upcoming WHERE tenant_id = ? filters without an extra migration.
		// Non-unique by design: future tenants will be allowed to host sources
		// with names that collide across tenant boundaries.
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_sources_tenant ON rag_sources(tenant_id)`);
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_folders_tenant ON rag_folders(tenant_id)`);
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_documents_tenant ON rag_documents(tenant_id)`);
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_tenant ON rag_chunks(tenant_id)`);
		raw.exec(`CREATE INDEX IF NOT EXISTS idx_rag_jobs_tenant ON rag_jobs(tenant_id)`);

		// FTS5 mirror + triggers — created at v1 for fresh DBs so we don't run
		// the v5 migration path on never-used installs. Pre-v5 DBs that upgrade
		// from v4 hit the v5 branch below; both paths converge on the same
		// `rag_chunks_fts` table.
		createFtsTableAndTriggers(raw);

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

	if (current < 4) {
		// v4 — add `polling_interval_seconds` to rag_sources. Nullable: NULL
		// means "no polling, manual sync only". Existing rows remain unaffected
		// (NULL after ALTER), preserving the prior behavior. The PollScheduler
		// only registers timers for rows where this column is non-null.
		addColumnIfMissing(raw, 'rag_sources', 'polling_interval_seconds', 'INTEGER');
		setRagSchemaVersion(raw, 4);
	}

	if (current < 5) {
		// v5 — add the FTS5 virtual table mirroring `rag_chunks.text` plus the
		// AI/AU/AD triggers that keep it in sync. Used by HybridSearchIndex
		// (search/hybrid-search.ts) to combine keyword and vector retrieval
		// through Reciprocal Rank Fusion (RRF).
		//
		// Idempotent: the helper guards table creation with IF NOT EXISTS and
		// only backfills when rag_chunks contains rows. Re-running this step
		// (e.g. after a partial earlier upgrade) is safe.
		createFtsTableAndTriggers(raw);
		setRagSchemaVersion(raw, 5);
	}

	if (current < 6) {
		// v6 — multi-tenancy foundation (Phase A).
		//
		// Adds a `tenant_id TEXT NOT NULL DEFAULT 'default'` column to every
		// RAG table so existing rows transparently migrate under the literal
		// 'default' tenant. NO route enforces tenant filtering yet — this
		// migration is intentionally additive so it can be reverted by a
		// simple `ALTER TABLE … DROP COLUMN tenant_id` on each table.
		//
		// Phase B will resolve the tenant from the authenticated request and
		// wire `WHERE tenant_id = ?` clauses into every read path. The indexes
		// below exist now so that filtering doesn't kill query performance
		// when it eventually lands.
		//
		// Idempotent: `addColumnIfMissing` skips the ALTER when the column is
		// already present (e.g. fresh installs that picked up the column from
		// the v1 baseline DDL above).
		const ragTables = [
			'rag_sources',
			'rag_folders',
			'rag_documents',
			'rag_chunks',
			'rag_jobs',
		] as const;
		for (const table of ragTables) {
			if (hasTable(raw, table)) {
				addColumnIfMissing(
					raw,
					table,
					'tenant_id',
					`TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}'`,
				);
				raw.exec(
					`CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id)`,
				);
			}
		}
		setRagSchemaVersion(raw, 6);
	}

	if (current < 7) {
		// v7 — embedding cost tracking foundation.
		//
		// Adds `tokens_embedded INTEGER NOT NULL DEFAULT 0` to `rag_jobs` so the
		// sync orchestrator (and the upload route) can record the sum of chunk
		// token counts that were actually embedded by the job. The usage endpoint
		// aggregates this column at query time — no separate counter table is
		// needed because rag_jobs already carries source_id and started_at, which
		// gives us per-source and per-period rollups for free.
		//
		// Idempotent: `addColumnIfMissing` skips the ALTER when the column is
		// already present (fresh installs that picked it up from the v1
		// baseline DDL above).
		if (hasTable(raw, 'rag_jobs')) {
			addColumnIfMissing(raw, 'rag_jobs', 'tokens_embedded', 'INTEGER NOT NULL DEFAULT 0');
		}
		setRagSchemaVersion(raw, 7);
	}

	if (current < 8) {
		// v8 — source-level soft delete with 7-day retention.
		//
		// Adds `deleted_at TEXT NULL` to `rag_sources`. A non-null value means
		// the source is soft-deleted: it is hidden from every listing
		// (`WHERE deleted_at IS NULL` is applied at the route layer), the poll
		// scheduler / watch manager skip it on boot, and the cleanup cron
		// (`jobs/soft-delete-cleanup.ts`) hard-deletes it once
		// `deleted_at < now - 7 days`. Cascading FKs (added in v1) drop every
		// dependent `rag_folders` / `rag_documents` / `rag_chunks` / `rag_jobs`
		// row in the same transaction.
		//
		// Idempotent: `addColumnIfMissing` skips the ALTER when the column is
		// already present (fresh installs that picked it up from the v1
		// baseline DDL above). The index is created with IF NOT EXISTS so
		// re-running the migration is a no-op.
		if (hasTable(raw, 'rag_sources')) {
			addColumnIfMissing(raw, 'rag_sources', 'deleted_at', 'TEXT');
			raw.exec(
				`CREATE INDEX IF NOT EXISTS idx_rag_sources_deleted_at ON rag_sources(deleted_at)`,
			);
		}
		setRagSchemaVersion(raw, 8);
	}

	if (current < 9) {
		// v9 — surface unsupported / failed documents in the tree view.
		//
		// Adds `ingest_error TEXT NULL` to `rag_documents`. A non-null value
		// means the last sync attempt couldn't ingest the file (today: only
		// `UnsupportedMimeTypeError`, but the column is provider-agnostic).
		// The row is otherwise a real document — it just has no chunks /
		// embeddings, so semantic search ignores it while the tree view can
		// surface it with a "Format non supporté" badge.
		//
		// Idempotent: `addColumnIfMissing` skips the ALTER when the column is
		// already present (fresh installs that picked it up from the v1
		// baseline DDL above).
		if (hasTable(raw, 'rag_documents')) {
			addColumnIfMissing(raw, 'rag_documents', 'ingest_error', 'TEXT');
		}
		setRagSchemaVersion(raw, 9);
	}

	// Future migrations slot here, each gated on `current < N`.
	// They MUST be idempotent and update `rag_schema_version` on success.
	if (current < CURRENT_RAG_SCHEMA_VERSION) {
		setRagSchemaVersion(raw, CURRENT_RAG_SCHEMA_VERSION);
	}
}
