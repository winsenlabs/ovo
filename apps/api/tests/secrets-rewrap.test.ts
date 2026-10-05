import { describe, expect, it } from 'vitest';
import { LocalAesGcmSecretManager, masterKeyId } from '@winsendotai/ovo-plugin-secrets';
import { NodeSqliteControlStore, type ControlStore } from '@winsendotai/ovo-plugin-storage';
import { runSecretsRewrap } from '../src/secrets-rewrap.ts';

const oldKey = Buffer.alloc(32, 1),
  newKey = Buffer.alloc(32, 2);

describe('secrets:rewrap', () => {
  it('moves stored credentials to the new master key and logs no secret values', async () => {
    const store = new NodeSqliteControlStore(':memory:');
    const close = store.close.bind(store);
    // The command closes its store; keep this one open to inspect the result.
    store.close = async () => undefined;
    try {
      await store.ensureWorkspace('ovo');
      const credential = await new LocalAesGcmSecretManager(store, oldKey).create({
        workspaceId: 'ovo',
        label: 'Provider',
        provider: 'fixture',
        type: 'api-key',
        environment: 'test',
        value: 'provider-secret-value',
        createdBy: 'test',
      });
      const logs: Record<string, unknown>[] = [];
      const run = (argv: string[]) =>
        runSecretsRewrap({
          env: {
            DATABASE_URL: 'postgres://unused',
            OVO_ORGANIZATION_ID: 'ovo',
            OVO_SECRETS_BACKEND: 'local',
            OVO_SECRETS_MASTER_KEY: newKey.toString('hex'),
            OVO_SECRETS_MASTER_KEY_PREVIOUS: oldKey.toString('base64'),
          },
          argv,
          log: (entry) => logs.push(entry),
          openStore: async () => store as unknown as ControlStore,
        });

      await expect(run(['--dry-run'])).resolves.toBe(0);
      expect(logs[0]).toMatchObject({ dryRun: true, workspaceId: 'ovo', pending: 1, rewrapped: 0 });
      await expect(run([])).resolves.toBe(0);
      expect(logs[1]).toMatchObject({
        event: 'secrets_rewrap',
        dryRun: false,
        primaryKeyId: masterKeyId(newKey),
        previousKeyIds: [masterKeyId(oldKey)],
        rewrapped: 1,
        failed: [],
      });
      expect(JSON.stringify(logs)).not.toContain('provider-secret-value');
      await expect(
        new LocalAesGcmSecretManager(store, newKey).resolve('ovo', credential.id),
      ).resolves.toBe('provider-secret-value');
    } finally {
      await close();
    }
  });

  it('exits non-zero when a credential cannot be decrypted with the configured keys', async () => {
    const store = new NodeSqliteControlStore(':memory:');
    try {
      await store.ensureWorkspace('ovo');
      await new LocalAesGcmSecretManager(store, oldKey).create({
        workspaceId: 'ovo',
        label: 'Orphan',
        provider: 'fixture',
        type: 'api-key',
        environment: 'test',
        value: 'orphan',
        createdBy: 'test',
      });
      const logs: Record<string, unknown>[] = [];
      await expect(
        runSecretsRewrap({
          env: {
            DATABASE_URL: 'postgres://unused',
            OVO_SECRETS_BACKEND: 'local',
            OVO_SECRETS_MASTER_KEY: newKey.toString('hex'),
          },
          argv: ['--workspace', 'ovo'],
          log: (entry) => logs.push(entry),
          openStore: async () => store as unknown as ControlStore,
        }),
      ).resolves.toBe(1);
      expect(logs[0]).toMatchObject({ workspaceId: 'ovo', failed: [expect.anything()] });
    } finally {
      await store.close().catch(() => undefined);
    }
  });

  it('refuses the AWS backend and a missing workspace before opening the database', async () => {
    const openStore = async (): Promise<ControlStore> => {
      throw new Error('must not open');
    };
    const env = {
      DATABASE_URL: 'postgres://unused',
      OVO_SECRETS_MASTER_KEY: newKey.toString('hex'),
    };
    await expect(runSecretsRewrap({ env, argv: [], openStore })).rejects.toThrow('--workspace');
    await expect(
      runSecretsRewrap({
        env: { ...env, OVO_ORGANIZATION_ID: 'ovo', OVO_SECRETS_BACKEND: 'aws-secrets-manager' },
        argv: [],
        openStore,
      }),
    ).rejects.toThrow('stored secrets only');
  });
});
