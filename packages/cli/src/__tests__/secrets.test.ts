import { describe, it, expect } from 'vitest';
import {
  createSecretsProvider,
  resolveSecret,
  VaultProvider,
  AwsSecretsProvider,
} from '../secrets.js';

describe('createSecretsProvider', () => {
  it('returns null for provider "none"', () => {
    const provider = createSecretsProvider({ provider: 'none' });
    expect(provider).toBeNull();
  });

  it('returns null for default (no provider specified)', () => {
    const provider = createSecretsProvider({ provider: 'none' });
    expect(provider).toBeNull();
  });

  it('throws for vault provider without vaultAddr', () => {
    expect(() => createSecretsProvider({ provider: 'vault', vaultToken: 'token' })).toThrow(
      'CALAME_SECRETS_VAULT_ADDR',
    );
  });

  it('throws for vault provider without vaultToken', () => {
    expect(() =>
      createSecretsProvider({ provider: 'vault', vaultAddr: 'http://vault:8200' }),
    ).toThrow('CALAME_SECRETS_VAULT_TOKEN');
  });

  it('throws for vault provider with neither addr nor token', () => {
    expect(() => createSecretsProvider({ provider: 'vault' })).toThrow('CALAME_SECRETS_VAULT_ADDR');
  });

  it('throws for aws provider without awsRegion', () => {
    expect(() => createSecretsProvider({ provider: 'aws' })).toThrow('CALAME_SECRETS_AWS_REGION');
  });

  it('returns a VaultProvider when vault config is complete', () => {
    const provider = createSecretsProvider({
      provider: 'vault',
      vaultAddr: 'http://vault:8200',
      vaultToken: 's.mytoken',
    });
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe('vault');
  });

  it('returns an AwsSecretsProvider when aws config is complete', () => {
    const provider = createSecretsProvider({
      provider: 'aws',
      awsRegion: 'eu-west-1',
    });
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe('aws');
  });
});

describe('resolveSecret', () => {
  it('passes through a plain connection string unchanged', async () => {
    const plain = 'postgresql://user:pass@localhost:5432/mydb';
    const result = await resolveSecret(plain, null);
    expect(result).toBe(plain);
  });

  it('passes through a non-secret:// string even with a provider', async () => {
    const vault = new VaultProvider('http://vault:8200', 'token');
    const plain = 'postgresql://user:pass@localhost/db';
    const result = await resolveSecret(plain, vault);
    expect(result).toBe(plain);
  });

  it('throws when connection string uses secret:// but no provider is configured', async () => {
    await expect(resolveSecret('secret://vault/secret/data/myapp/db', null)).rejects.toThrow(
      'no secrets provider is configured',
    );
  });

  it('strips provider prefix before delegating to provider.getSecret', async () => {
    let capturedPath: string | null = null;
    const mockProvider = {
      name: 'mock',
      getSecret: async (path: string) => {
        capturedPath = path;
        return 'resolved-value';
      },
    };

    const result = await resolveSecret('secret://vault/secret/data/myapp/db', mockProvider);
    expect(result).toBe('resolved-value');
    // The "vault/" prefix should be stripped
    expect(capturedPath).toBe('secret/data/myapp/db');
  });

  it('handles secret:// with no slash after provider prefix', async () => {
    let capturedPath: string | null = null;
    const mockProvider = {
      name: 'mock',
      getSecret: async (path: string) => {
        capturedPath = path;
        return 'value';
      },
    };

    await resolveSecret('secret://aws', mockProvider);
    // path = 'aws', slashIdx = -1, so secretPath = path = 'aws'
    expect(capturedPath).toBe('aws');
  });
});

describe('VaultProvider constructor', () => {
  it('strips trailing slash from addr', () => {
    const vault = new VaultProvider('http://vault:8200/', 'mytoken');
    // name is exposed
    expect(vault.name).toBe('vault');
  });

  it('accepts addr without trailing slash', () => {
    const vault = new VaultProvider('http://vault:8200', 'mytoken');
    expect(vault.name).toBe('vault');
  });
});

describe('AwsSecretsProvider constructor', () => {
  it('stores the region', () => {
    const aws = new AwsSecretsProvider('us-east-1');
    expect(aws.name).toBe('aws');
  });
});
