import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SecretResolver } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { type ControlStore, type CredentialMetadata } from '@winsendotai/ovo-plugin-storage';

export interface CreateCredentialInput {
  workspaceId: string;
  label: string;
  provider: string;
  type: string;
  environment: string;
  value: string;
  permittedAgentIds?: string[];
  expiresAt?: string | null;
  createdBy: string;
}
export interface SecretManager extends SecretResolver {
  create(input: CreateCredentialInput): Promise<CredentialMetadata>;
  rotate(workspaceId: string, credentialId: string, value: string): Promise<CredentialMetadata>;
  retire(workspaceId: string, credentialId: string): Promise<CredentialMetadata>;
  forAgent(agentId: string): SecretResolver;
}

function fingerprint(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}
export function decodeMasterKey(encoded: string): Buffer {
  const key = /^[a-f\d]{64}$/i.test(encoded)
    ? Buffer.from(encoded, 'hex')
    : Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('OVO_SECRETS_MASTER_KEY must decode to exactly 32 bytes');
  return key;
}

export class LocalAesGcmSecretManager implements SecretManager {
  constructor(
    private readonly store: ControlStore,
    private readonly key: Uint8Array,
  ) {
    if (key.length !== 32) throw new Error('AES-256-GCM key must be 32 bytes');
  }
  private encrypt(workspaceId: string, credentialId: string, version: number, value: string) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${workspaceId}:${credentialId}:${version}`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { ciphertext, nonce, authTag: cipher.getAuthTag(), backendRef: null };
  }
  async create(input: CreateCredentialInput) {
    const id = randomUUID(),
      secret = this.encrypt(input.workspaceId, id, 1, input.value);
    return this.store.createCredential({
      ...input,
      id,
      backend: 'local',
      permittedAgentIds: input.permittedAgentIds ?? [],
      fingerprint: fingerprint(input.value),
      secret,
    });
  }
  async rotate(workspaceId: string, credentialId: string, value: string) {
    const metadata = this.store.getCredential(workspaceId, credentialId);
    if (!metadata || metadata.status !== 'active') throw new Error('Active credential not found');
    return this.store.rotateCredential(workspaceId, credentialId, {
      fingerprint: fingerprint(value),
      secret: this.encrypt(workspaceId, credentialId, metadata.currentVersion + 1, value),
    });
  }
  async resolve(workspaceId: string, credentialId: string) {
    this.assertPolicy(workspaceId, credentialId);
    const secret = this.store.getActiveSecretBlob(workspaceId, credentialId);
    if (
      !secret ||
      secret.backend !== 'local' ||
      !secret.ciphertext ||
      !secret.nonce ||
      !secret.authTag
    )
      throw new Error('Active local secret not found');
    const decipher = createDecipheriv('aes-256-gcm', this.key, secret.nonce);
    decipher.setAAD(Buffer.from(`${workspaceId}:${credentialId}:${secret.version}`));
    decipher.setAuthTag(secret.authTag);
    return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
  }
  forAgent(agentId: string): SecretResolver {
    return {
      resolve: async (workspaceId, credentialId) => {
        this.assertPolicy(workspaceId, credentialId, agentId);
        return this.resolve(workspaceId, credentialId);
      },
    };
  }
  private assertPolicy(workspaceId: string, credentialId: string, agentId?: string) {
    const metadata = this.store.getCredential(workspaceId, credentialId);
    if (!metadata || metadata.status !== 'active') throw new Error('Active credential not found');
    if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now())
      throw new Error('Credential expired');
    if (
      agentId &&
      metadata.permittedAgentIds.length &&
      !metadata.permittedAgentIds.includes(agentId)
    )
      throw new Error('Credential is not permitted for this agent');
  }
  async retire(workspaceId: string, credentialId: string) {
    return this.store.retireCredential(workspaceId, credentialId);
  }
}

interface AwsClient {
  send(command: unknown): Promise<Record<string, unknown>>;
  destroy?(): void;
}
interface AwsModule {
  SecretsManagerClient: new (config: Record<string, unknown>) => AwsClient;
  CreateSecretCommand: new (input: Record<string, unknown>) => unknown;
  PutSecretValueCommand: new (input: Record<string, unknown>) => unknown;
  GetSecretValueCommand: new (input: Record<string, unknown>) => unknown;
  DeleteSecretCommand: new (input: Record<string, unknown>) => unknown;
}

/** AWS adapter loaded lazily so local development does not initialize AWS clients. */
export class AwsSecretsManagerSecretManager implements SecretManager {
  constructor(
    private readonly store: ControlStore,
    private readonly client: AwsClient,
    private readonly aws: AwsModule,
    private readonly prefix = 'ovo',
  ) {}
  async create(input: CreateCredentialInput) {
    const id = randomUUID(),
      name = `${this.prefix}/${input.workspaceId}/${id}`;
    const result = await this.client.send(
      new this.aws.CreateSecretCommand({
        Name: name,
        SecretString: input.value,
        ClientRequestToken: randomUUID(),
        Tags: [
          { Key: 'ovo-workspace', Value: input.workspaceId },
          { Key: 'ovo-credential', Value: id },
        ],
      }),
    );
    const backendRef = JSON.stringify({
      arn: String(result.ARN ?? name),
      versionId: String(result.VersionId ?? ''),
    });
    try {
      return this.store.createCredential({
        ...input,
        id,
        backend: 'aws-secrets-manager',
        permittedAgentIds: input.permittedAgentIds ?? [],
        fingerprint: fingerprint(input.value),
        secret: { ciphertext: null, nonce: null, authTag: null, backendRef },
      });
    } catch (error) {
      await this.client
        .send(
          new this.aws.DeleteSecretCommand({
            SecretId: this.reference(backendRef).arn,
            ForceDeleteWithoutRecovery: true,
          }),
        )
        .catch(() => undefined);
      throw error;
    }
  }
  async rotate(workspaceId: string, credentialId: string, value: string) {
    const current = this.store.getActiveSecretBlob(workspaceId, credentialId);
    if (!current || current.backend !== 'aws-secrets-manager' || !current.backendRef)
      throw new Error('Active AWS secret not found');
    const reference = this.reference(current.backendRef),
      result = await this.client.send(
        new this.aws.PutSecretValueCommand({
          SecretId: reference.arn,
          SecretString: value,
          ClientRequestToken: randomUUID(),
          VersionStages: ['AWSCURRENT'],
        }),
      );
    const backendRef = JSON.stringify({
      arn: reference.arn,
      versionId: String(result.VersionId ?? ''),
    });
    return this.store.rotateCredential(workspaceId, credentialId, {
      fingerprint: fingerprint(value),
      secret: { ciphertext: null, nonce: null, authTag: null, backendRef },
    });
  }
  async resolve(workspaceId: string, credentialId: string) {
    this.assertPolicy(workspaceId, credentialId);
    const secret = this.store.getActiveSecretBlob(workspaceId, credentialId);
    if (!secret || secret.backend !== 'aws-secrets-manager' || !secret.backendRef)
      throw new Error('Active AWS secret not found');
    const reference = this.reference(secret.backendRef),
      result = await this.client.send(
        new this.aws.GetSecretValueCommand({
          SecretId: reference.arn,
          ...(reference.versionId
            ? { VersionId: reference.versionId }
            : { VersionStage: 'AWSCURRENT' }),
        }),
      );
    if (typeof result.SecretString !== 'string')
      throw new Error('Binary AWS secrets are not supported');
    return result.SecretString;
  }
  async retire(workspaceId: string, credentialId: string) {
    // Retirement revokes OVO resolution. Remote deletion is deliberately a separate operator retention action.
    return this.store.retireCredential(workspaceId, credentialId);
  }
  forAgent(agentId: string): SecretResolver {
    return {
      resolve: async (workspaceId, credentialId) => {
        this.assertPolicy(workspaceId, credentialId, agentId);
        return this.resolve(workspaceId, credentialId);
      },
    };
  }
  private assertPolicy(workspaceId: string, credentialId: string, agentId?: string) {
    const metadata = this.store.getCredential(workspaceId, credentialId);
    if (!metadata || metadata.status !== 'active') throw new Error('Active credential not found');
    if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now())
      throw new Error('Credential expired');
    if (
      agentId &&
      metadata.permittedAgentIds.length &&
      !metadata.permittedAgentIds.includes(agentId)
    )
      throw new Error('Credential is not permitted for this agent');
  }
  private reference(value: string): { arn: string; versionId: string } {
    try {
      return JSON.parse(value) as { arn: string; versionId: string };
    } catch {
      return { arn: value, versionId: '' };
    }
  }
}

export const secretsPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-secrets',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    provides: ['secretManager', 'secretResolver', 'ovo.secret-resolver'],
    requires: ['controlStore'],
    configSchema: {
      type: 'object',
      properties: {
        backend: { enum: ['local', 'aws-secrets-manager'] },
        masterKey: { type: 'string' },
        region: { type: 'string' },
        awsPrefix: { type: 'string' },
      },
      required: ['backend'],
      additionalProperties: false,
    },
    secretFields: ['masterKey'],
  },
  async (ctx, config) => {
    const store = ctx.get('controlStore') as ControlStore;
    let service: SecretManager;
    if (config.backend === 'aws-secrets-manager') {
      const aws = (await import('@aws-sdk/client-secrets-manager')) as unknown as AwsModule;
      const client = new aws.SecretsManagerClient({
        region: typeof config.region === 'string' ? config.region : undefined,
      });
      service = new AwsSecretsManagerSecretManager(
        store,
        client,
        aws,
        typeof config.awsPrefix === 'string' ? config.awsPrefix : 'ovo',
      );
      ctx.fiber.effect(() => () => client.destroy?.(), 'close AWS Secrets Manager client');
    } else {
      const encoded =
        typeof config.masterKey === 'string'
          ? config.masterKey
          : process.env.OVO_SECRETS_MASTER_KEY;
      if (!encoded)
        throw new Error('OVO_SECRETS_MASTER_KEY is required for local encrypted secrets');
      service = new LocalAesGcmSecretManager(store, decodeMasterKey(encoded));
    }
    ctx.provide('secretManager', service);
    ctx.provide('secretResolver', service);
    ctx.provide('ovo.secret-resolver', service);
  },
);
