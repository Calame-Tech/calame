export interface SecretsProvider {
  name: string;
  getSecret(path: string): Promise<string>;
}

export interface SecretsConfig {
  provider: 'none' | 'vault' | 'aws';
  // Vault
  vaultAddr?: string;
  vaultToken?: string;
  // AWS
  awsRegion?: string;
  // AWS credentials come from standard AWS env vars (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
}

/** HashiCorp Vault KV v2 provider — uses HTTP API, no SDK dependency */
export class VaultProvider implements SecretsProvider {
  name = 'vault';
  private addr: string;
  private token: string;

  constructor(addr: string, token: string) {
    this.addr = addr.replace(/\/$/, '');
    this.token = token;
  }

  async getSecret(path: string): Promise<string> {
    // path format: "secret/data/myapp/db" or "kv/data/connections/prod"
    const res = await fetch(`${this.addr}/v1/${path}`, {
      headers: { 'X-Vault-Token': this.token },
    });
    if (!res.ok) throw new Error(`Vault error: ${res.status} for path ${path}`);
    const data = (await res.json()) as { data?: { data?: Record<string, string> } };
    // KV v2 nests under data.data
    const secrets = data?.data?.data;
    if (!secrets) throw new Error(`No secret found at ${path}`);
    // Return the first value if single key, or JSON string if multiple
    const values = Object.values(secrets);
    if (values.length === 1) return values[0];
    return JSON.stringify(secrets);
  }
}

/** AWS Secrets Manager provider — uses AWS SDK via dynamic import */
export class AwsSecretsProvider implements SecretsProvider {
  name = 'aws';
  private region: string;

  constructor(region: string) {
    this.region = region;
  }

  async getSecret(secretId: string): Promise<string> {
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!accessKey || !secretKey) {
      throw new Error(
        'AWS credentials not found in environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)',
      );
    }

    try {
      // @ts-expect-error -- @aws-sdk/client-secrets-manager is an optional peer dependency
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const awsSdk = await import('@aws-sdk/client-secrets-manager');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const client = new awsSdk.SecretsManagerClient({ region: this.region });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const response = await client.send(new awsSdk.GetSecretValueCommand({ SecretId: secretId }));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
      return response.SecretString ?? '';
    } catch (importErr: unknown) {
      throw new Error(
        `AWS Secrets Manager requires @aws-sdk/client-secrets-manager. ` +
          `Install it with: pnpm add @aws-sdk/client-secrets-manager\n` +
          `Original error: ${importErr instanceof Error ? importErr.message : String(importErr)}`,
      );
    }
  }
}

export function createSecretsProvider(config: SecretsConfig): SecretsProvider | null {
  switch (config.provider) {
    case 'vault':
      if (!config.vaultAddr || !config.vaultToken) {
        throw new Error('Vault requires CALAME_SECRETS_VAULT_ADDR and CALAME_SECRETS_VAULT_TOKEN');
      }
      return new VaultProvider(config.vaultAddr, config.vaultToken);
    case 'aws':
      if (!config.awsRegion) {
        throw new Error('AWS requires CALAME_SECRETS_AWS_REGION');
      }
      return new AwsSecretsProvider(config.awsRegion);
    case 'none':
    default:
      return null;
  }
}

/**
 * Resolve a connection string that may reference an external secret.
 * Format: secret://vault/secret/data/myapp/db
 *         secret://aws/my-secret-name
 */
export async function resolveSecret(
  connectionString: string,
  provider: SecretsProvider | null,
): Promise<string> {
  if (!connectionString.startsWith('secret://')) return connectionString;
  if (!provider)
    throw new Error('Connection string references a secret but no secrets provider is configured');

  const path = connectionString.slice('secret://'.length);
  // Remove provider prefix if present: "vault/secret/data/..." -> "secret/data/..."
  const slashIdx = path.indexOf('/');
  const secretPath = slashIdx >= 0 ? path.slice(slashIdx + 1) : path;

  return provider.getSecret(secretPath);
}
