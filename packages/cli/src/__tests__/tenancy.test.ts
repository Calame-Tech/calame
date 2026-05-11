import { describe, it, expect } from 'vitest';
import { DEFAULT_TENANT_ID, getTenantId, isDefaultTenant } from '../tenancy.js';

describe('tenancy — Phase A foundation', () => {
  describe('DEFAULT_TENANT_ID', () => {
    it('is the literal "default"', () => {
      // Sanity check: the literal must stay exactly 'default'. The whole
      // migration story relies on this string matching the DEFAULT clause
      // on every per-tenant column. If this constant ever changes, the
      // companion migration on those tables must change in lock-step.
      expect(DEFAULT_TENANT_ID).toBe('default');
    });
  });

  describe('getTenantId', () => {
    it('returns "default" with no argument', () => {
      expect(getTenantId()).toBe(DEFAULT_TENANT_ID);
    });

    it('returns "default" with a request-like argument (Phase A ignores req)', () => {
      // Phase A always returns the default regardless of input. Phase B
      // will read from req.auth.tenantId / X-Tenant-Id, so the call site
      // already passes the request — this test pins the Phase A behavior.
      const req = { headers: { 'x-tenant-id': 'acme' } };
      expect(getTenantId(req)).toBe(DEFAULT_TENANT_ID);
    });

    it('returns "default" even when req.auth.tenantId is populated (Phase A)', () => {
      // Future-proofing — once Phase B lands, this test must flip to
      // assert the auth-derived value. For now Phase A is intentionally
      // request-agnostic.
      const req = { auth: { tenantId: 'acme' } };
      expect(getTenantId(req)).toBe(DEFAULT_TENANT_ID);
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
