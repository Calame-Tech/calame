import request from 'supertest';
import type express from 'express';

const ADMIN = { name: 'Admin', email: 'admin@test.com', password: 'testpass123' };

/**
 * Create the initial admin account via /api/auth/setup and return the session cookie.
 * If an admin already exists (e.g. loaded from file), logs in instead.
 */
export async function setupAdminAndGetCookie(app: express.Express): Promise<string> {
  // Try setup first
  const setupRes = await request(app).post('/api/auth/setup').send(ADMIN);
  if (setupRes.status === 200) {
    const cookie = setupRes.headers['set-cookie']?.[0];
    if (!cookie) throw new Error('No cookie returned from setup');
    return cookie;
  }

  // Admin already exists — login instead
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email: ADMIN.email, password: ADMIN.password });
  if (loginRes.status !== 200) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  const cookie = loginRes.headers['set-cookie']?.[0];
  if (!cookie) throw new Error('No cookie returned from login');
  return cookie;
}

export { ADMIN };
