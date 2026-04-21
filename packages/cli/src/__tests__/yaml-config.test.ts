import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AppConfig } from '../config.js';
import type { AppState } from '../state.js';

// ---------------------------------------------------------------------------
// Mock @calame/connectors at the module level (hoisted by vitest)
// ---------------------------------------------------------------------------
vi.mock('@calame/connectors', () => ({
  getConnector: vi.fn(() => ({
    introspect: vi.fn().mockResolvedValue({ tables: [{ name: 't1' }], relations: [] }),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): AppConfig {
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
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadYamlConfig', () => {
  let tmpDir: string;
  let warnMessages: string[];
  let infoMessages: string[];
  let errorMessages: string[];

  const logger = {
    info: (msg: string) => { infoMessages.push(msg); },
    warn: (msg: string) => { warnMessages.push(msg); },
    error: (msg: string) => { errorMessages.push(msg); },
    debug: () => {},
    child: () => logger,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calame-yaml-test-'));
    warnMessages = [];
    infoMessages = [];
    errorMessages = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('warns and does not throw when file does not exist', async () => {
    const { loadYamlConfig } = await import('../yaml-config.js');
    const nonExistent = path.join(tmpDir, 'does-not-exist.yaml');
    const state = {
      connections: new Map(),
      addConnection: vi.fn(),
    } as unknown as AppState;

    await expect(
      loadYamlConfig(nonExistent, state, makeConfig(), logger),
    ).resolves.toBeUndefined();

    expect(warnMessages.some((m) => m.includes('not found'))).toBe(true);
  });

  it('warns and does not throw when file is empty', async () => {
    const { loadYamlConfig } = await import('../yaml-config.js');
    const filePath = path.join(tmpDir, 'empty.yaml');
    fs.writeFileSync(filePath, '');

    const state = {
      connections: new Map(),
      addConnection: vi.fn(),
    } as unknown as AppState;

    await expect(
      loadYamlConfig(filePath, state, makeConfig(), logger),
    ).resolves.toBeUndefined();

    expect(warnMessages.some((m) => m.includes('empty'))).toBe(true);
  });

  it('logs loaded message when file is valid YAML without databases', async () => {
    const { loadYamlConfig } = await import('../yaml-config.js');
    const filePath = path.join(tmpDir, 'valid.yaml');
    fs.writeFileSync(filePath, 'dataProfiles: []\n');

    const state = {
      connections: new Map(),
      addConnection: vi.fn(),
    } as unknown as AppState;

    await loadYamlConfig(filePath, state, makeConfig(), logger);

    expect(infoMessages.some((m) => m.includes('loaded from'))).toBe(true);
  });

  it('interpolates env vars in connection strings', async () => {
    process.env.YAML_TEST_DB_HOST = 'mydbhost.example.com';

    try {
      const { loadYamlConfig } = await import('../yaml-config.js');
      const filePath = path.join(tmpDir, 'with-db.yaml');
      fs.writeFileSync(
        filePath,
        `databases:\n  - name: testdb\n    type: postgresql\n    connectionString: "postgresql://user:pass@\${YAML_TEST_DB_HOST}:5432/mydb"\n`,
      );

      const addConnection = vi.fn();
      const state = {
        connections: new Map(),
        addConnection,
      } as unknown as AppState;

      await loadYamlConfig(filePath, state, makeConfig(), logger);

      expect(addConnection).toHaveBeenCalledOnce();
      const callArg = addConnection.mock.calls[0][1] as { connection: { connectionString: string } };
      expect(callArg.connection.connectionString).toContain('mydbhost.example.com');
    } finally {
      delete process.env.YAML_TEST_DB_HOST;
    }
  });

  it('skips connection that already exists in state', async () => {
    const { loadYamlConfig } = await import('../yaml-config.js');
    const filePath = path.join(tmpDir, 'existing.yaml');
    fs.writeFileSync(
      filePath,
      `databases:\n  - name: existing-db\n    type: sqlite\n    connectionString: /tmp/test.db\n`,
    );

    const existing = new Map([['existing-db', {}]]);
    const addConnection = vi.fn();
    const state = {
      connections: existing,
      addConnection,
    } as unknown as AppState;

    await loadYamlConfig(filePath, state, makeConfig(), logger);

    expect(addConnection).not.toHaveBeenCalled();
    expect(infoMessages.some((m) => m.includes('already exists'))).toBe(true);
  });

  it('logs error when connection introspection fails', async () => {
    // Override the mock to throw for this test
    const { getConnector } = await import('@calame/connectors');
    vi.mocked(getConnector).mockReturnValueOnce({
      introspect: vi.fn().mockRejectedValue(new Error('Connection refused')),
      testConnection: vi.fn(),
      sampleColumnValues: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as ReturnType<typeof getConnector>);

    const { loadYamlConfig } = await import('../yaml-config.js');
    const filePath = path.join(tmpDir, 'fail-db.yaml');
    fs.writeFileSync(
      filePath,
      `databases:\n  - name: fail-db\n    type: postgresql\n    connectionString: "postgresql://bad:bad@localhost:9999/none"\n`,
    );

    const state = {
      connections: new Map(),
      addConnection: vi.fn(),
    } as unknown as AppState;

    await expect(
      loadYamlConfig(filePath, state, makeConfig(), logger),
    ).resolves.toBeUndefined();

    expect(errorMessages.some((m) => m.includes('Failed to connect'))).toBe(true);
  });
});
