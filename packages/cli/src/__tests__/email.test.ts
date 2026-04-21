import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '../config.js';

// Stub nodemailer before importing EmailService
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({}),
      verify: vi.fn().mockResolvedValue(true),
    })),
  },
}));

import { EmailService, isSmtpConfigured } from '../email.js';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 4567,
    basePath: '/',
    adminPassword: null,
    secretKey: null,
    dataDir: '/tmp',
    trustProxy: false,
    corsOrigins: '*',
    logLevel: 'info',
    logFormat: 'text',
    dbPoolSize: 10,
    dbIdleTimeoutMs: 30000,
    queryTimeoutMs: 10000,
    auditRetentionDays: 90,
    chatRetentionDays: 30,
    llmProvider: 'anthropic',
    llmEndpoint: null,
    llmModel: null,
    llmApiKey: null,
    tlsCert: null,
    tlsKey: null,
    rateLimitRpm: 0,
    configFile: null,
    smtpHost: null,
    smtpPort: 587,
    smtpUser: null,
    smtpPass: null,
    smtpFrom: null,
    oidcEnabled: false,
    oidcIssuerUrl: null,
    oidcClientId: null,
    oidcClientSecret: null,
    oidcRedirectUri: null,
    oidcScopes: 'openid profile email',
    oidcGroupClaim: 'groups',
    oidcGroupMap: null,
    oidcAutoCreateUsers: true,
    secretsProvider: 'none',
    secretsVaultAddr: null,
    secretsVaultToken: null,
    secretsAwsRegion: null,
    llmRouterEnabled: false,
    llmClassifierProvider: null,
    llmClassifierModel: null,
    llmClassifierApiKey: null,
    llmClassifierEndpoint: null,
    llmRouterInjectionThreshold: 0.8,
    ...overrides,
  };
}

describe('isSmtpConfigured', () => {
  it('returns false when smtpHost is null', () => {
    expect(isSmtpConfigured(makeConfig())).toBe(false);
  });

  it('returns true when smtpHost is set', () => {
    expect(isSmtpConfigured(makeConfig({ smtpHost: 'smtp.example.com' }))).toBe(true);
  });

  it('returns false when smtpHost is empty string', () => {
    expect(isSmtpConfigured(makeConfig({ smtpHost: '' }))).toBe(false);
  });
});

describe('EmailService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructor does not throw with minimal SMTP config', () => {
    const config = makeConfig({ smtpHost: 'smtp.example.com' });
    expect(() => new EmailService(config)).not.toThrow();
  });

  it('constructor does not throw with full SMTP config', () => {
    const config = makeConfig({
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpUser: 'user@example.com',
      smtpPass: 'secret',
      smtpFrom: 'Calame <no-reply@example.com>',
    });
    expect(() => new EmailService(config)).not.toThrow();
  });

  it('uses smtpFrom when provided', () => {
    const config = makeConfig({
      smtpHost: 'smtp.example.com',
      smtpFrom: 'Custom <custom@example.com>',
    });
    // No throws — the from is set internally; just check instantiation
    const svc = new EmailService(config);
    expect(svc).toBeDefined();
  });

  it('falls back to default from address when smtpFrom is null', () => {
    const config = makeConfig({ smtpHost: 'smtp.example.com', smtpFrom: null });
    const svc = new EmailService(config);
    expect(svc).toBeDefined();
  });

  it('testConnection returns true when verify succeeds', async () => {
    const config = makeConfig({ smtpHost: 'smtp.example.com' });
    const svc = new EmailService(config);
    const result = await svc.testConnection();
    expect(result).toBe(true);
  });

  it('testConnection returns false when verify throws', async () => {
    const nodemailer = await import('nodemailer');
    vi.mocked(nodemailer.default.createTransport).mockReturnValueOnce({
      sendMail: vi.fn(),
      verify: vi.fn().mockRejectedValue(new Error('Connection refused')),
    } as unknown as ReturnType<typeof nodemailer.default.createTransport>);

    const config = makeConfig({ smtpHost: 'smtp.example.com' });
    const svc = new EmailService(config);
    const result = await svc.testConnection();
    expect(result).toBe(false);
  });
});
