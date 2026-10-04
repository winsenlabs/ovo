import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeSqliteControlStore } from '../../plugin-storage/src/index.ts';
import { AwsSecretsManagerSecretManager, type AwsClient, type AwsModule } from '../src/aws.ts';
import type { CredentialStore } from '../src/types.ts';

class CreateSecretCommand {
  readonly kind = 'create';
  constructor(readonly input: Record<string, unknown>) {}
}
class PutSecretValueCommand {
  readonly kind = 'put';
  constructor(readonly input: Record<string, unknown>) {}
}
class GetSecretValueCommand {
  readonly kind = 'get';
  constructor(readonly input: Record<string, unknown>) {}
}
class DeleteSecretCommand {
  readonly kind = 'delete';
  constructor(readonly input: Record<string, unknown>) {}
}
type Command =
  CreateSecretCommand | PutSecretValueCommand | GetSecretValueCommand | DeleteSecretCommand;

const aws: AwsModule = {
  SecretsManagerClient: class {
    async send(): Promise<Record<string, unknown>> {
      throw new Error('The SDK client must not be constructed by this test');
    }
  },
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
  DeleteSecretCommand,
};

const input = {
  workspaceId: 'workspace-a',
  label: 'Fixture credential',
  provider: 'fixture',
  type: 'api-key',
  environment: 'test',
  value: 'synthetic-first',
  createdBy: 'operator',
  permittedAgentIds: ['agent-a'],
};

describe('AWS secrets adapter with an in-memory command client', () => {
  const stores: NodeSqliteControlStore[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
  });

  async function setup() {
    const store = new NodeSqliteControlStore(':memory:');
    stores.push(store);
    await store.ensureWorkspace('workspace-a');
    await store.ensureWorkspace('workspace-b');
    let secretValue = 'synthetic-first';
    let version = 1;
    const send = vi.fn(async (command: unknown): Promise<Record<string, unknown>> => {
      const value = command as Command;
      if (value.kind === 'create') return { ARN: 'arn:fixture:credential', VersionId: 'v1' };
      if (value.kind === 'put') {
        secretValue = String(value.input.SecretString);
        version += 1;
        return { VersionId: `v${version}` };
      }
      if (value.kind === 'get') return { SecretString: secretValue };
      if (value.kind === 'delete') return {};
      throw new Error('Unexpected command');
    });
    const manager = new AwsSecretsManagerSecretManager(store, { send } satisfies AwsClient, aws);
    return { store, send, manager };
  }

  it('stores only a reference and resolves the pinned version after workspace and agent checks', async () => {
    const { store, send, manager } = await setup();
    const credential = await manager.create(input);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      kind: 'create',
      input: {
        Name: expect.stringMatching(/^ovo\/workspace-a\//),
        SecretString: 'synthetic-first',
        Tags: [
          { Key: 'ovo-workspace', Value: 'workspace-a' },
          { Key: 'ovo-credential', Value: credential.id },
        ],
      },
    });
    expect(await store.getActiveSecretBlob('workspace-a', credential.id)).toMatchObject({
      backend: 'aws-secrets-manager',
      ciphertext: null,
      nonce: null,
      authTag: null,
      backendRef: JSON.stringify({ arn: 'arn:fixture:credential', versionId: 'v1' }),
    });
    expect(credential.fingerprint).toMatch(/^sha256:/);
    expect(await manager.forAgent('agent-a').resolve('workspace-a', credential.id)).toBe(
      'synthetic-first',
    );
    expect(send.mock.lastCall?.[0]).toMatchObject({
      kind: 'get',
      input: { SecretId: 'arn:fixture:credential', VersionId: 'v1' },
    });
    const count = send.mock.calls.length;
    await expect(manager.resolve('workspace-b', credential.id)).rejects.toThrow(
      'Active credential not found',
    );
    await expect(manager.forAgent('agent-b').resolve('workspace-a', credential.id)).rejects.toThrow(
      'not permitted',
    );
    expect(send).toHaveBeenCalledTimes(count);
  });

  it('rotates a referenced secret, refuses binary results, and revokes local resolution', async () => {
    const { store, send, manager } = await setup();
    const credential = await manager.create(input);
    const rotated = await manager.rotate('workspace-a', credential.id, 'synthetic-second');
    expect(rotated.currentVersion).toBe(2);
    expect(rotated.fingerprint).not.toBe(credential.fingerprint);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      kind: 'put',
      input: {
        SecretId: 'arn:fixture:credential',
        SecretString: 'synthetic-second',
        VersionStages: ['AWSCURRENT'],
      },
    });
    expect(await manager.resolve('workspace-a', credential.id)).toBe('synthetic-second');
    expect(send.mock.lastCall?.[0]).toMatchObject({
      kind: 'get',
      input: { SecretId: 'arn:fixture:credential', VersionId: 'v2' },
    });
    send.mockResolvedValueOnce({ SecretBinary: new Uint8Array([1]) });
    await expect(manager.resolve('workspace-a', credential.id)).rejects.toThrow(
      'Binary AWS secrets are not supported',
    );
    await manager.retire('workspace-a', credential.id);
    const count = send.mock.calls.length;
    await expect(manager.resolve('workspace-a', credential.id)).rejects.toThrow(
      'Active credential not found',
    );
    await expect(manager.rotate('workspace-a', credential.id, 'unused')).rejects.toThrow(
      'Active AWS secret not found',
    );
    expect(send).toHaveBeenCalledTimes(count);
    expect((await store.getCredential('workspace-a', credential.id))?.status).toBe('retired');
  });

  it('deletes a remote secret if durable creation fails', async () => {
    const send = vi.fn(async (command: unknown) =>
      (command as Command).kind === 'create'
        ? { ARN: 'arn:fixture:rollback', VersionId: 'v1' }
        : {},
    );
    const store = {
      createCredential: vi.fn(async () => {
        throw new Error('durable write failed');
      }),
    } as unknown as CredentialStore;
    const manager = new AwsSecretsManagerSecretManager(store, { send }, aws);
    await expect(manager.create(input)).rejects.toThrow('durable write failed');
    expect(send.mock.calls.map(([command]) => (command as Command).kind)).toEqual([
      'create',
      'delete',
    ]);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      kind: 'delete',
      input: { SecretId: 'arn:fixture:rollback', ForceDeleteWithoutRecovery: true },
    });
  });

  it('uses the known name for an empty ARN and refuses missing version IDs', async () => {
    const { store, send, manager } = await setup();
    send.mockResolvedValueOnce({ ARN: '', VersionId: 'v1' });
    const credential = await manager.create(input);
    const created = send.mock.calls[0]?.[0] as CreateSecretCommand;
    expect(await store.getActiveSecretBlob('workspace-a', credential.id)).toMatchObject({
      backendRef: JSON.stringify({ arn: created.input.Name, versionId: 'v1' }),
    });

    send.mockResolvedValueOnce({ ARN: 'arn:fixture:no-version' });
    await expect(manager.create(input)).rejects.toThrow('AWS secret version is missing');
    expect(send.mock.lastCall?.[0]).toMatchObject({
      kind: 'delete',
      input: { SecretId: 'arn:fixture:no-version', ForceDeleteWithoutRecovery: true },
    });

    send.mockResolvedValueOnce({});
    await expect(manager.rotate('workspace-a', credential.id, 'synthetic-next')).rejects.toThrow(
      'AWS secret version is missing',
    );
    expect((await store.getCredential('workspace-a', credential.id))?.currentVersion).toBe(1);
  });

  it('refuses a missing reference or wrong backend before remote rotation and resolution', async () => {
    const { store, send, manager } = await setup();
    const credential = await manager.create(input);
    const original = await store.getActiveSecretBlob('workspace-a', credential.id);
    expect(original).toBeDefined();
    const count = send.mock.calls.length;
    for (const secret of [
      { ...original!, backend: 'local' as const },
      { ...original!, backendRef: null },
    ]) {
      const guardedStore = {
        getCredential: store.getCredential.bind(store),
        getActiveSecretBlob: vi.fn(async () => secret),
      } as unknown as CredentialStore;
      const guardedManager = new AwsSecretsManagerSecretManager(guardedStore, { send }, aws);
      await expect(guardedManager.rotate('workspace-a', credential.id, 'unused')).rejects.toThrow(
        'Active AWS secret not found',
      );
      await expect(guardedManager.resolve('workspace-a', credential.id)).rejects.toThrow(
        'Active AWS secret not found',
      );
    }
    expect(send).toHaveBeenCalledTimes(count);
  });
});
