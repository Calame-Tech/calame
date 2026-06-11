import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerUsersRoute } from './users.js';
import type { AppState } from '../state.js';

// Minimal mock for userManager
const createUserManager = () => {
  const users = new Map<string, {
    id: string;
    tenant_id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    profiles: any[];
    createdAt: Date;
    lastActiveAt: Date | null;
    disabledAt: Date | null;
    disabledReason: string | null;
    onboardingCode: string | null;
  }>();

  const add = (id: string, tenantId: string, overrides: Partial<any> = {}) => {
    const u = {
      id,
      tenant_id: tenantId,
      name: `User ${id}`,
      email: `${id}@test.com`,
      role: 'user',
      status: 'active',
      profiles: [],
      createdAt: new Date(),
      lastActiveAt: new Date(),
      disabledAt: null,
      disabledReason: null,
      onboardingCode: null,
      ...overrides,
    };
    users.set(id, u);
    return u;
  };

  return {
    getUserById: (id: string) => users.get(id) ?? null,
    listUsers: (filters: any, tenantId: string) =>
      Array.from(users.values())
        .filter((u) => u.tenant_id === tenantId)
        .filter((u) => !filters.profileName || u.profiles?.some((p: any) => p.name === filters.profileName))
        .filter((u) => !filters.role || u.role === filters.role)
        .filter((u) => !filters.status || u.status === filters.status)
        .filter((u) => !filters.search || u.name?.includes(filters.search) || u.email?.includes(filters.search)),
    updateUser: (id: string, data: any) => {
      const u = users.get(id);
      if (u) Object.assign(u, data);
      return u;
    },
    disableUser: (id: string) => {
      const u = users.get(id);
      if (u) { u.status = 'disabled'; u.disabledAt = new Date(); }
      return u;
    },
    enableUser: (id: string) => {
      const u = users.get(id);
      if (u) { u.status = 'active'; u.disabledAt = null; }
      return u;
    },
    deleteUser: (id: string) => {
      const u = users.get(id);
      if (u) users.delete(id);
      return u;
    },
    addProfile: (userId: string, profile: any) => {
      const u = users.get(userId);
      if (u) { u.profiles = u.profiles || []; u.profiles.push(profile); }
      return u;
    },
    deleteProfile: (userId: string, profileName: string) => {
      const u = users.get(userId);
      if (u) u.profiles = u.profiles?.filter((p: any) => p.name !== profileName);
      return u;
    },
    resendInvitation: (id: string) => users.get(id),
    _add: add,
    _users: users,
  };
};

// Minimal mock DB
const createMockDb = (users: Map<string, any>) => ({
  raw: {
    prepare: () => ({
      get: (id: string, tenantId: string) => {
        const u = users.get(id);
        return u && u.tenant_id === tenantId ? { tenant_id: u.tenant_id } : undefined;
      },
    }),
  },
  prepare: () => ({
    get: () => undefined,
  }),
});

const buildState = (userManager: any) => {
  const state: any = {
    userManager,
    db: createMockDb(userManager._users),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
  return state;
};

const createApp = (state: any) => {
  const app = express();
  app.use(express.json());
  registerUsersRoute(app, state);
  return app;
};

describe('Phase 2 — IDOR security tests', () => {
  let app: express.Express;
  let userManager: any;
  let state: any;

  beforeEach(() => {
    userManager = createUserManager();
    const userA = userManager._add('user-a', 'tenant-a', { email: 'a@tenant-a.com' });
    const userB = userManager._add('user-b', 'tenant-b', { email: 'b@tenant-b.com' });
    state = buildState(userManager);
    // Mock email service so resend-invitation doesn't return 503
    state.emailService = {
      sendInvitationEmail: vi.fn().mockResolvedValue(undefined),
    } as any;
    app = createApp(state);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /:id', () => {
    it('returns 404 when cross-tenant access is attempted', async () => {
      const res = await request(app)
        .get(`/api/users/${'user-b'}`)
        .set('X-Tenant-Id', 'tenant-a');
      expect(res.status).toBe(404);
    });

    it('returns 200 for same-tenant access', async () => {
      const res = await request(app)
        .get(`/api/users/${'user-a'}`)
        .set('X-Tenant-Id', 'tenant-a');
      expect(res.status).toBe(200);
    });

    it('falls back to the default tenant when no tenant header is provided (single-tenant mode)', async () => {
      // B1: omitting X-Tenant-Id no longer 403s — it resolves to 'default'.
      // user-a belongs to 'tenant-a', so the default-tenant lookup still
      // can't reach it: cross-tenant access stays blocked with a 404.
      const res = await request(app)
        .get(`/api/users/${'user-a'}`);
      expect(res.status).toBe(404);
    });

    it('serves a default-tenant user when no tenant header is provided', async () => {
      userManager._add('user-default', 'default', { email: 'd@default.com' });
      const res = await request(app)
        .get(`/api/users/${'user-default'}`);
      expect(res.status).toBe(200);
    });

    it('returns 400 for malformed :id', async () => {
      // Express normalizes ../../etc/passwd → /etc/passwd, donc params.id = 'etc'
      // qui matche la regex. On teste un ID avec des caractères interdits.
      const res = await request(app)
        .get('/api/users/user%00b')
        .set('X-Tenant-Id', 'tenant-a');
      expect(res.status).toBe(400);
    });

    it('returns 400 for oversized :id', async () => {
      const oversized = 'a'.repeat(100);
      const res = await request(app)
        .get(`/api/users/${oversized}`)
        .set('X-Tenant-Id', 'tenant-a');
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /:id', () => {
    it('returns 404 when cross-tenant PUT is attempted', async () => {
      const res = await request(app)
        .put(`/api/users/${'user-b'}`)
        .set('X-Tenant-Id', 'tenant-a')
        .set('Content-Type', 'application/json')
        .send({ name: 'Hacked' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /:id', () => {
    it('returns 404 when cross-tenant DELETE is attempted', async () => {
      const res = await request(app)
        .delete(`/api/users/${'user-b'}`)
        .set('X-Tenant-Id', 'tenant-a');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /:id/enable', () => {
    it('returns 404 when cross-tenant enable is attempted (token leak prevention)', async () => {
      const res = await request(app)
        .post(`/api/users/${'user-b'}/enable`)
        .set('X-Tenant-Id', 'tenant-a');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /:id/disable', () => {
    it('returns 404 when cross-tenant disable is attempted', async () => {
      const res = await request(app)
        .post(`/api/users/${'user-b'}/disable`)
        .set('X-Tenant-Id', 'tenant-a');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /:id/profiles', () => {
    it('returns 404 when cross-tenant profile creation is attempted', async () => {
      const res = await request(app)
        .post(`/api/users/${'user-b'}/profiles`)
        .set('X-Tenant-Id', 'tenant-a')
        .set('Content-Type', 'application/json')
        .send({ profileName: 'test-profile', accessMode: 'mcp' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /:id/profiles/:profileName', () => {
    it('returns 404 when cross-tenant profile deletion is attempted', async () => {
      const res = await request(app)
        .delete(`/api/users/${'user-b'}/profiles/${'test-profile'}`)
        .set('X-Tenant-Id', 'tenant-a');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /:id/resend-invitation', () => {
    it('returns 404 when cross-tenant resend is attempted', async () => {
      const res = await request(app)
        .post(`/api/users/${'user-b'}/resend-invitation`)
        .set('X-Tenant-Id', 'tenant-a');
      expect(res.status).toBe(404);
    });
  });
});
