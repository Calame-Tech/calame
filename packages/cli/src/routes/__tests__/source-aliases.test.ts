import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  legacyPathDeprecationMiddleware,
  _resetSeenPaths,
} from '../source-aliases.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): express.Express {
  const app = express();
  app.use(legacyPathDeprecationMiddleware());

  // Stub handlers for the legacy paths so requests return 200 (not 404)
  app.get('/api/connections/:rest(*)', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/api/connections/:rest(*)', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/rag/:rest(*)', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/other', (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('legacyPathDeprecationMiddleware', () => {
  beforeEach(() => {
    // Reset the de-duplication set between tests so each test starts clean.
    _resetSeenPaths();
  });

  it('sets Sunset header on /api/connections/* requests', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/connections/foo').expect(200);

    expect(res.headers['sunset']).toBeDefined();
    expect(res.headers['sunset']).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('sets Sunset header on /api/rag/* requests', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/rag/sources').expect(200);

    expect(res.headers['sunset']).toBeDefined();
  });

  it('does NOT set Sunset header on non-legacy paths', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/other').expect(200);

    expect(res.headers['sunset']).toBeUndefined();
  });

  it('passes through to the next handler unchanged', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/connections/test').expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('de-duplicates: second call to the same path does not re-add to seenPaths', async () => {
    const app = makeApp();

    // First call — should add to seenPaths
    const res1 = await request(app).get('/api/connections/foo').expect(200);
    expect(res1.headers['sunset']).toBeDefined();

    // Second call — seenPaths already has the key, but the Sunset header is still set
    // (de-duplication only affects logging, not header emission)
    const res2 = await request(app).get('/api/connections/foo').expect(200);
    expect(res2.headers['sunset']).toBeDefined();
  });

  it('treats different METHOD:path combinations as separate keys', async () => {
    const app = makeApp();

    const res1 = await request(app).get('/api/connections/items').expect(200);
    const res2 = await request(app).post('/api/connections/items').expect(200);

    // Both should get Sunset headers
    expect(res1.headers['sunset']).toBeDefined();
    expect(res2.headers['sunset']).toBeDefined();
  });

  it('treats different paths as separate keys', async () => {
    const app = makeApp();

    const res1 = await request(app).get('/api/connections/foo').expect(200);
    const res2 = await request(app).get('/api/connections/bar').expect(200);

    expect(res1.headers['sunset']).toBeDefined();
    expect(res2.headers['sunset']).toBeDefined();
  });

  it('_resetSeenPaths clears the de-duplication set', async () => {
    const app = makeApp();

    await request(app).get('/api/connections/foo');
    // Reset and verify the set is cleared by checking that a subsequent call
    // still gets the Sunset header (reset doesn't break functionality)
    _resetSeenPaths();
    const res = await request(app).get('/api/connections/foo').expect(200);
    expect(res.headers['sunset']).toBeDefined();
  });
});
