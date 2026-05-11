import { describe, it, expect } from 'vitest';
import { DEFAULT_TENANT_ID, getTenantId, isDefaultTenant } from '../tenancy.js';

describe('tenancy — Phase B enforcement', () => {
  describe('DEFAULT_TENANT_ID', () => {
    it('is the literal "default"', () => {
      // Sanity check: the literal must stay exactly 'default'. The whole
      // migration story relies on this string matching the DEFAULT clause
      // on every per-tenant column. If this constant ever changes, the
      // companion migration on those tables must change in lock-step.
      expect(DEFAULT_TENANT_ID).toBe('default');
    });
  });

  describe('getTenantId — backward compat', () => {
    it('returns "default" with no argument', () => {
      // Background workers and schedulers call this without a request so
      // they obtain the implicit default explicitly rather than hard-
      // coding the literal. Must keep working.
      expect(getTenantId()).toBe(DEFAULT_TENANT_ID);
    });

    it('returns "default" when no headers and no auth are present', () => {
      // Empty request shape — same outcome as "no argument".
      expect(getTenantId({})).toBe(DEFAULT_TENANT_ID);
      expect(getTenantId({ headers: {} })).toBe(DEFAULT_TENANT_ID);
    });

    it('returns "default" when the X-Tenant-Id header is absent', () => {
      // Any unrelated headers must not affect the resolution.
      const req = { headers: { 'content-type': 'application/json' } };
      expect(getTenantId(req)).toBe(DEFAULT_TENANT_ID);
    });
  });

  describe('getTenantId — header resolution', () => {
    it('returns the header value when valid', () => {
      const req = { headers: { 'x-tenant-id': 'acme' } };
      expect(getTenantId(req)).toBe('acme');
    });

    it('accepts the full alphabet [A-Za-z0-9_-]', () => {
      const req = { headers: { 'x-tenant-id': 'Acme_Corp-42' } };
      expect(getTenantId(req)).toBe('Acme_Corp-42');
    });

    it('accepts a 64-character tenant id (upper bound)', () => {
      const value = 'a'.repeat(64);
      const req = { headers: { 'x-tenant-id': value } };
      expect(getTenantId(req)).toBe(value);
    });

    it('falls back to "default" when the header is empty string', () => {
      // Express occasionally surfaces an empty header — must not bind
      // an empty string into the WHERE clause.
      const req = { headers: { 'x-tenant-id': '' } };
      expect(getTenantId(req)).toBe(DEFAULT_TENANT_ID);
    });

    it('falls back to "default" when the header has whitespace', () => {
      const req = { headers: { 'x-tenant-id': 'acme corp' } };
      expect(getTenantId(req)).toBe(DEFAULT_TENANT_ID);
    });

    it('falls back to "default" when the header has illegal characters', () => {
      // Defence-in-depth — these are bound parameterised but we still
      // refuse to round-trip them through SQL.
      for (const bad of [
        'acme;drop',
        "acme'",
        'acme/sub',
        'acme.sub',
        'acme:42',
        'acme*',
        '<script>',
      ]) {
        const req = { headers: { 'x-tenant-id': bad } };
        expect(getTenantId(req)).toBe(DEFAULT_TENANT_ID);
      }
    });

    it('falls back to "default" when the header exceeds 64 characters', () => {
      const tooLong = 'a'.repeat(65);
      const req = { headers: { 'x-tenant-id': tooLong } };
      expect(getTenantId(req)).toBe(DEFAULT_TENANT_ID);
    });

    it('reads the first valid value when the header is repeated (string[])', () => {
      // Express represents repeated headers as `string[]` — we use the
      // first non-empty entry. This matches the standard "first wins"
      // convention for forwarded request metadata.
      const req = { headers: { 'x-tenant-id': ['acme', 'beta'] } };
      expect(getTenantId(req)).toBe('acme');
    });

    it('skips empty entries when the header is an array', () => {
      const req = { headers: { 'x-tenant-id': ['', 'acme'] } };
      expect(getTenantId(req)).toBe('acme');
    });

    it('falls back to "default" when every array entry is invalid', () => {
      const req = { headers: { 'x-tenant-id': ['', '   bad value   ', '<bad>'] } };
      expect(getTenantId(req)).toBe(DEFAULT_TENANT_ID);
    });

    it('falls back to "default" when the header is undefined inside the map', () => {
      const req = { headers: { 'x-tenant-id': undefined } };
      expect(getTenantId(req)).toBe(DEFAULT_TENANT_ID);
    });
  });

  describe('getTenantId — auth resolution', () => {
    it('prefers req.auth.tenantId over the header when both are present', () => {
      // Future Phase C: once the auth middleware populates `req.auth`,
      // it always wins over the (forgeable) header. This pins the
      // ordering today so the wiring is ready.
      const req = {
        auth: { tenantId: 'auth-wins' },
        headers: { 'x-tenant-id': 'header-loses' },
      };
      expect(getTenantId(req)).toBe('auth-wins');
    });

    it('falls back to the header when auth.tenantId is missing', () => {
      const req = {
        auth: {} as { tenantId?: string },
        headers: { 'x-tenant-id': 'from-header' },
      };
      expect(getTenantId(req)).toBe('from-header');
    });

    it('falls back to the header when auth.tenantId is malformed', () => {
      // Malformed auth tenant must not poison the resolution — the
      // header (when valid) takes over.
      const req = {
        auth: { tenantId: 'bad value' },
        headers: { 'x-tenant-id': 'from-header' },
      };
      expect(getTenantId(req)).toBe('from-header');
    });
  });

  describe('isDefaultTenant', () => {
    it('returns true for the literal "default"', () => {
      expect(isDefaultTenant(DEFAULT_TENANT_ID)).toBe(true);
      expect(isDefaultTenant('default')).toBe(true);
    });

    it('returns false for any other value', () => {
      expect(isDefaultTenant('acme')).toBe(false);
      expect(isDefaultTenant('')).toBe(false);
      expect(isDefaultTenant('DEFAULT')).toBe(false);
    });
  });
});
