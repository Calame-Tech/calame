/**
 * Regression tests for: an MCP profile backed only by a knowledge base (RAG
 * document sources) could not be started when the instance had no database
 * connection.
 *
 * Two independent defects were in play:
 *
 *  1. `/api/serve/start` rejected every request with
 *     "No database connections available" as soon as `state.connections` was
 *     empty — even though the MCP endpoint itself has supported document-only
 *     profiles since Phase 3c (serve.ts registers the `rag_*` tool set without
 *     touching a database).
 *
 *  2. `ensureProfilesLoaded` (GET /api/serve/status) overwrote `sources` with
 *     `['default']` on any profile that had no relational source, which
 *     stranded the RAG source ids of a knowledge-only profile.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '../../app.js';
import { AppState } from '../../state.js';
import { UserManager } from '../../user.js';
import { CalameDatabase } from '../../database.js';
import { setupAdminAndGetCookie } from './helpers.js';
import type { ConnectionState } from '../../state.js';
import type { NamedConnection } from '@calame/core';

const RAG_SOURCE_ID = 'kb-source-1';

describe('serve/start — knowledge-only profiles (no database connection)', () => {
  let app: ReturnType<typeof createApp>;
  let state: AppState;
  let db: CalameDatabase;
  let originalCwd: string;
  let tmpDir: string;
  let cookie: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = path.join(os.tmpdir(), `calame-serve-knowledge-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    state = new AppState();
    db = new CalameDatabase(tmpDir);
    state.db = db;
    state.userManager = new UserManager(db);
    app = createApp(state);
    cookie = await setupAdminAndGetCookie(app);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** Insert a Configuration whose only scope is a RAG document allowlist. */
  function insertKnowledgeConfiguration(name = 'knowledge'): void {
    db.raw
      .prepare(
        `INSERT INTO configurations (name, label, connections, selected_tables, table_options, column_masking, sources_scopes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        name,
        JSON.stringify([]),
        JSON.stringify({}),
        null,
        null,
        JSON.stringify({
          name,
          label: name,
          sources: [RAG_SOURCE_ID],
          scopes: {
            [RAG_SOURCE_ID]: {
              kind: 'document',
              mode: 'allowAll',
              allowedFolders: [],
              allowedDocuments: [],
            },
          },
        }),
      );
  }

  /** Persist the `profiles` blob row for the default tenant. */
  function insertProfiles(profiles: Record<string, unknown>): void {
    db.raw
      .prepare("INSERT INTO profiles (key, data) VALUES ('main', ?)")
      .run(JSON.stringify({ profiles }));
  }

  function makeConnectionState(name: string): ConnectionState {
    return {
      connection: {
        name,
        label: name,
        databaseType: 'postgresql',
        connectionString: `postgres://localhost/${name}`,
      } as NamedConnection,
      schema: { tables: [], relations: [] },
      piiDetections: null,
    };
  }

  // -------------------------------------------------------------------------
  // /api/serve/start
  // -------------------------------------------------------------------------

  it('starts a profile whose only source is a knowledge base (via Configuration)', async () => {
    insertKnowledgeConfiguration();
    insertProfiles({
      docs: { label: 'Docs', authMode: 'open', configurations: ['knowledge'] },
    });

    const res = await request(app)
      .post('/api/serve/start')
      .set('Cookie', cookie)
      .send({ profiles: ['docs'] })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.profiles).toEqual(['docs']);
    expect(state.activeProfileNames.has('docs')).toBe(true);
    expect(state.connections.size).toBe(0);
  });

  it('starts a profile whose document scope is declared directly on the profile', async () => {
    insertProfiles({
      docs: {
        label: 'Docs',
        authMode: 'open',
        sources: [RAG_SOURCE_ID],
        scopes: {
          [RAG_SOURCE_ID]: {
            kind: 'document',
            mode: 'allowAll',
            allowedFolders: [],
            allowedDocuments: [],
          },
        },
      },
    });

    await request(app)
      .post('/api/serve/start')
      .set('Cookie', cookie)
      .send({ profiles: ['docs'] })
      .expect(200);

    expect(state.activeProfileNames.has('docs')).toBe(true);
  });

  it('leaves the knowledge source untouched — no relational scope is grafted on', async () => {
    insertKnowledgeConfiguration();
    insertProfiles({
      docs: {
        label: 'Docs',
        authMode: 'open',
        sources: [RAG_SOURCE_ID],
        scopes: {
          [RAG_SOURCE_ID]: {
            kind: 'document',
            mode: 'allowAll',
            allowedFolders: [],
            allowedDocuments: [],
          },
        },
        configurations: ['knowledge'],
      },
    });

    await request(app)
      .post('/api/serve/start')
      .set('Cookie', cookie)
      .send({ profiles: ['docs'] })
      .expect(200);

    const served = state.serveProfiles['docs'];
    expect(served.sources).toContain(RAG_SOURCE_ID);
    expect(served.scopes?.[RAG_SOURCE_ID].kind).toBe('document');
  });

  it('still rejects when the instance has neither a connection nor a knowledge source', async () => {
    insertProfiles({ empty: { label: 'Empty', authMode: 'open' } });

    const res = await request(app)
      .post('/api/serve/start')
      .set('Cookie', cookie)
      .send({ profiles: ['empty'] })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/No data source available/);
  });

  it('still starts a relational profile when a connection exists (no regression)', async () => {
    state.addConnection('main', makeConnectionState('main'));
    insertProfiles({ db: { label: 'DB', authMode: 'open', sources: ['main'] } });

    await request(app)
      .post('/api/serve/start')
      .set('Cookie', cookie)
      .send({ profiles: ['db'] })
      .expect(200);

    expect(state.activeProfileNames.has('db')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // /api/serve/status — ensureProfilesLoaded must not clobber document sources
  // -------------------------------------------------------------------------

  it('does not overwrite a document-scoped profile with a synthetic relational source', async () => {
    insertProfiles({
      docs: {
        label: 'Docs',
        authMode: 'open',
        sources: [RAG_SOURCE_ID],
        scopes: {
          [RAG_SOURCE_ID]: {
            kind: 'document',
            mode: 'allowAll',
            allowedFolders: [],
            allowedDocuments: [],
          },
        },
      },
    });

    await request(app).get('/api/serve/status').set('Cookie', cookie).expect(200);

    const loaded = state.serveProfiles['docs'];
    expect(loaded.sources).toEqual([RAG_SOURCE_ID]);
    expect(loaded.scopes?.[RAG_SOURCE_ID].kind).toBe('document');
  });

  it('still synthesises a default relational source on a truly empty profile', async () => {
    insertProfiles({ empty: { label: 'Empty', authMode: 'open' } });

    await request(app).get('/api/serve/status').set('Cookie', cookie).expect(200);

    const loaded = state.serveProfiles['empty'];
    expect(loaded.sources).toEqual(['default']);
    expect(loaded.scopes?.['default'].kind).toBe('relational');
  });
});
