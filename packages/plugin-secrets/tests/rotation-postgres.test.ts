import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { PostgresControlStore } from '../../plugin-storage/src/index.ts';
import { LocalAesGcmSecretManager, type CredentialStore } from '../src/index.ts';

it.skipIf(!process.env.OVO_TEST_POSTGRES_URL)(
  'encrypts eight concurrent rotations with versions allocated inside the Postgres lock',
  async () => {
    const store = await PostgresControlStore.open(process.env.OVO_TEST_POSTGRES_URL!);
    try {
      const workspaceId = `rotation-${randomUUID()}`;
      await store.ensureWorkspace(workspaceId);
      // All requests reach storage before any takes the real row lock. An encrypted blob
      // prepared by the manager before this boundary therefore cannot know the allocated version.
      const rotate = store.rotateCredential.bind(store);
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requests = 0;
      const rotateCredential: CredentialStore['rotateCredential'] = async (...args) => {
        requests += 1;
        if (requests === 8) release();
        await ready;
        return rotate(...args);
      };
      const adapter: CredentialStore = {
        createCredential: store.createCredential,
        getCredential: store.getCredential,
        getActiveSecretBlob: store.getActiveSecretBlob,
        retireCredential: store.retireCredential,
        rotateCredential,
      };
      const secrets = new LocalAesGcmSecretManager(adapter, Buffer.alloc(32, 8), 'encrypted-store');
      const credential = await secrets.create({
        workspaceId,
        label: 'Concurrent',
        provider: 'fixture',
        type: 'api-key',
        environment: 'test',
        value: 'initial',
        createdBy: 'test',
      });
      const rotations = await Promise.all(
        Array.from({ length: 8 }, (_, index) => `rotation-${index + 2}`).map(async (value) => ({
          value,
          metadata: await secrets.rotate(workspaceId, credential.id, value),
        })),
      );
      expect(
        rotations.map(({ metadata }) => metadata.currentVersion).sort((a, b) => a - b),
      ).toEqual(Array.from({ length: 8 }, (_, index) => index + 2));
      const final = rotations.find(({ metadata }) => metadata.currentVersion === 9)!;
      await expect(secrets.resolve(workspaceId, credential.id)).resolves.toBe(final.value);
    } finally {
      await store.close();
    }
  },
);
