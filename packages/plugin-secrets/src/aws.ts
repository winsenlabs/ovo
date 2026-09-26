import { randomUUID } from 'node:crypto';
import type { SecretResolver } from '@winsendotai/ovo-contracts';
import type { CredentialStore, CreateCredentialInput, SecretManager } from './types.ts';
import { fingerprint } from './crypto.ts';
import { assertCredentialPolicy } from './policy.ts';
export interface AwsClient {
  send(command: unknown): Promise<Record<string, unknown>>;
  destroy?(): void;
}
export interface AwsModule {
  SecretsManagerClient: new (config: Record<string, unknown>) => AwsClient;
  CreateSecretCommand: new (input: Record<string, unknown>) => unknown;
  PutSecretValueCommand: new (input: Record<string, unknown>) => unknown;
  GetSecretValueCommand: new (input: Record<string, unknown>) => unknown;
  DeleteSecretCommand: new (input: Record<string, unknown>) => unknown;
}

export class AwsSecretsManagerSecretManager implements SecretManager {
  constructor(
    private readonly store: CredentialStore,
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
      return await this.store.createCredential({
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
    const current = await this.store.getActiveSecretBlob(workspaceId, credentialId);
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
    await assertCredentialPolicy(this.store, workspaceId, credentialId);
    const secret = await this.store.getActiveSecretBlob(workspaceId, credentialId);
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
        await assertCredentialPolicy(this.store, workspaceId, credentialId, agentId);
        return this.resolve(workspaceId, credentialId);
      },
    };
  }
  private reference(value: string): { arn: string; versionId: string } {
    try {
      return JSON.parse(value) as { arn: string; versionId: string };
    } catch {
      return { arn: value, versionId: '' };
    }
  }
}
