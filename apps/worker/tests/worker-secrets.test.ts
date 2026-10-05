import { LocalAesGcmSecretManager, type CredentialStore } from '@winsendotai/ovo-plugin-secrets';
import { NodeSqliteControlStore } from '@winsendotai/ovo-plugin-storage';
import { expect, it } from 'vitest';
import { workerSecretManager } from '../src/worker-secrets.ts';

const oldKey = Buffer.alloc(32, 1).toString('base64'),
  newKey = Buffer.alloc(32, 2).toString('base64');

/** SQLite stores only the `local` backend; the worker's `encrypted-store` rows live in Postgres. */
function asEncryptedStore(store: NodeSqliteControlStore): CredentialStore {
  return new Proxy(
    {},
    {
      get(_, key) {
        if (key === 'createCredential')
          return (input: Parameters<CredentialStore['createCredential']>[0]) =>
            store.createCredential({ ...input, backend: 'local' });
        if (key === 'getActiveSecretBlob')
          return async (workspaceId: string, credentialId: string) => {
            const blob = await store.getActiveSecretBlob(workspaceId, credentialId);
            return blob && { ...blob, backend: 'encrypted-store' as const };
          };
        const value: unknown = Reflect.get(store, key);
        return typeof value === 'function' ? value.bind(store) : value;
      },
    },
  ) as unknown as CredentialStore;
}

it('resolves a credential still under the previous master key during a rotation', async () => {
  const sqlite = new NodeSqliteControlStore(':memory:');
  try {
    await sqlite.ensureWorkspace('workspace');
    const store = asEncryptedStore(sqlite);
    const credential = await new LocalAesGcmSecretManager(
      store,
      Buffer.from(oldKey, 'base64'),
      'encrypted-store',
    ).create({
      workspaceId: 'workspace',
      label: 'stt',
      provider: 'fixture',
      type: 'api-key',
      environment: 'test',
      value: 'written-before-rotation',
      createdBy: 'test',
    });
    const rotated = { OVO_SECRETS_MASTER_KEY: newKey };
    // The worker's old reader: the primary key only.
    await expect(
      workerSecretManager(store, rotated).resolve('workspace', credential.id),
    ).rejects.toThrow('not configured; set it in OVO_SECRETS_MASTER_KEY_PREVIOUS');
    await expect(
      workerSecretManager(store, { ...rotated, OVO_SECRETS_MASTER_KEY_PREVIOUS: oldKey }).resolve(
        'workspace',
        credential.id,
      ),
    ).resolves.toBe('written-before-rotation');
  } finally {
    await sqlite.close();
  }
});
