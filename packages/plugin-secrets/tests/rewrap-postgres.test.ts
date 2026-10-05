import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { PostgresControlStore } from '../../plugin-storage/src/index.ts';
import {
  LocalAesGcmSecretManager,
  masterKeyRing,
  rewrapWorkspaceCredentials,
} from '../src/index.ts';

it.skipIf(!process.env.OVO_TEST_POSTGRES_URL)(
  'rewraps encrypted-store credentials so the new key alone resolves them',
  async () => {
    const store = await PostgresControlStore.open(process.env.OVO_TEST_POSTGRES_URL!);
    try {
      const workspaceId = `rewrap-${randomUUID()}`,
        oldKey = Buffer.alloc(32, 3),
        newKey = Buffer.alloc(32, 4);
      await store.ensureWorkspace(workspaceId);
      const before = new LocalAesGcmSecretManager(store, oldKey, 'encrypted-store');
      const ids = [];
      for (const value of ['first', 'second', 'third'])
        ids.push(
          (
            await before.create({
              workspaceId,
              label: value,
              provider: 'fixture',
              type: 'api-key',
              environment: 'test',
              value,
              createdBy: 'test',
            })
          ).id,
        );
      const secrets = new LocalAesGcmSecretManager(
        store,
        masterKeyRing(newKey, [oldKey]),
        'encrypted-store',
      );
      expect(
        await rewrapWorkspaceCredentials({
          store,
          secrets,
          workspaceId,
          backend: 'encrypted-store',
        }),
      ).toMatchObject({ rewrapped: 3, current: 0, failed: [] });
      const after = new LocalAesGcmSecretManager(store, newKey, 'encrypted-store');
      expect(await Promise.all(ids.map((id) => after.resolve(workspaceId, id)))).toEqual([
        'first',
        'second',
        'third',
      ]);
    } finally {
      await store.close();
    }
  },
);
