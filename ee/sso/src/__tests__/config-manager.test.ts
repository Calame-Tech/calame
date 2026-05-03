// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { OidcConfigManager } from '../config-manager.js';
import type { DatabaseLike } from '../types.js';

function makeInMemoryDb(): DatabaseLike {
  return { raw: new Database(':memory:') };
}

describe('OidcConfigManager', () => {
  let mgr: OidcConfigManager;

  beforeEach(() => {
    mgr = new OidcConfigManager(makeInMemoryDb());
  });

  it('returns null when no config has been saved', () => {
    expect(mgr.getConfig()).toBeNull();
  });

  it('isConfigured() returns false when no config exists', () => {
    expect(mgr.isConfigured()).toBe(false);
  });

  it('saves and retrieves a full config', () => {
    mgr.setConfig({
      enabled: true,
      issuerUrl: 'https://accounts.example.com',
      clientId: 'my-client',
      clientSecret: 'super-secret',
      redirectUri: 'https://app.example.com/callback',
      scopes: 'openid profile email',
      groupClaim: 'groups',
      groupToProfile: { admins: 'admin', viewers: 'readonly' },
      autoCreateUsers: true,
    });

    const config = mgr.getConfig();
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.issuerUrl).toBe('https://accounts.example.com');
    expect(config!.clientId).toBe('my-client');
    expect(config!.clientSecret).toBe('super-secret');
    expect(config!.redirectUri).toBe('https://app.example.com/callback');
    expect(config!.scopes).toBe('openid profile email');
    expect(config!.groupClaim).toBe('groups');
    expect(config!.groupToProfile).toEqual({ admins: 'admin', viewers: 'readonly' });
    expect(config!.autoCreateUsers).toBe(true);
  });

  it('isConfigured() returns true when enabled + issuerUrl + clientId are set', () => {
    mgr.setConfig({
      enabled: true,
      issuerUrl: 'https://accounts.example.com',
      clientId: 'my-client',
      clientSecret: '',
      redirectUri: '',
      scopes: 'openid profile email',
      groupClaim: 'groups',
      groupToProfile: {},
      autoCreateUsers: true,
    });

    expect(mgr.isConfigured()).toBe(true);
  });

  it('isConfigured() returns false when enabled=false', () => {
    mgr.setConfig({
      enabled: false,
      issuerUrl: 'https://accounts.example.com',
      clientId: 'my-client',
      clientSecret: '',
      redirectUri: '',
      scopes: 'openid profile email',
      groupClaim: 'groups',
      groupToProfile: {},
      autoCreateUsers: true,
    });

    expect(mgr.isConfigured()).toBe(false);
  });

  it('getMaskedConfig() masks the clientSecret when longer than 4 chars', () => {
    mgr.setConfig({
      enabled: true,
      issuerUrl: 'https://accounts.example.com',
      clientId: 'my-client',
      clientSecret: 'super-secret',
      redirectUri: '',
      scopes: 'openid profile email',
      groupClaim: 'groups',
      groupToProfile: {},
      autoCreateUsers: true,
    });

    const masked = mgr.getMaskedConfig();
    expect(masked).not.toBeNull();
    expect(masked!.clientSecret).toContain('***');
    expect(masked!.clientSecret).not.toBe('super-secret');
    expect(masked!.clientSecret.startsWith('su')).toBe(true);
    expect(masked!.clientSecret.endsWith('et')).toBe(true);
  });

  it('getMaskedConfig() replaces short secrets with "***"', () => {
    mgr.setConfig({
      enabled: true,
      issuerUrl: 'https://accounts.example.com',
      clientId: 'my-client',
      clientSecret: 'abc',
      redirectUri: '',
      scopes: 'openid profile email',
      groupClaim: 'groups',
      groupToProfile: {},
      autoCreateUsers: true,
    });

    const masked = mgr.getMaskedConfig();
    expect(masked!.clientSecret).toBe('***');
  });

  it('getMaskedConfig() returns null when no config is saved', () => {
    expect(mgr.getMaskedConfig()).toBeNull();
  });

  it('setConfig() keeps existing clientSecret when the new value contains "***"', () => {
    mgr.setConfig({
      enabled: true,
      issuerUrl: 'https://accounts.example.com',
      clientId: 'my-client',
      clientSecret: 'original-secret',
      redirectUri: '',
      scopes: 'openid profile email',
      groupClaim: 'groups',
      groupToProfile: {},
      autoCreateUsers: true,
    });

    mgr.setConfig({
      enabled: true,
      issuerUrl: 'https://accounts.example.com',
      clientId: 'my-client',
      clientSecret: 'or***et',
      redirectUri: '',
      scopes: 'openid profile email',
      groupClaim: 'groups',
      groupToProfile: {},
      autoCreateUsers: true,
    });

    const config = mgr.getConfig();
    expect(config!.clientSecret).toBe('original-secret');
  });

  it('overwrites existing config on second setConfig() call', () => {
    mgr.setConfig({
      enabled: true,
      issuerUrl: 'https://old.example.com',
      clientId: 'old-client',
      clientSecret: 'old-secret',
      redirectUri: '',
      scopes: 'openid',
      groupClaim: 'roles',
      groupToProfile: {},
      autoCreateUsers: false,
    });

    mgr.setConfig({
      enabled: true,
      issuerUrl: 'https://new.example.com',
      clientId: 'new-client',
      clientSecret: 'new-secret',
      redirectUri: 'https://app/callback',
      scopes: 'openid profile email',
      groupClaim: 'groups',
      groupToProfile: { devs: 'dev' },
      autoCreateUsers: true,
    });

    const config = mgr.getConfig();
    expect(config!.issuerUrl).toBe('https://new.example.com');
    expect(config!.clientId).toBe('new-client');
    expect(config!.clientSecret).toBe('new-secret');
    expect(config!.groupToProfile).toEqual({ devs: 'dev' });
  });
});
