import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NodeSqliteControlStore } from '../../plugin-storage/src/index.ts';
import {
  LocalAesGcmSecretManager,
  masterKeyId,
  masterKeyRing,
  masterKeyRingFromEnv,
  rewrapWorkspaceCredentials,
  secretsPlugin,
  type CredentialStore,
} from '../src/index.ts';

const oldKey = Buffer.alloc(32, 1),
  newKey = Buffer.alloc(32, 2);

async function withStore(run: (store: NodeSqliteControlStore) => Promise<void>) {
  const store = new NodeSqliteControlStore(':memory:');
  try {
    await store.ensureWorkspace('workspace');
    await run(store);
  } finally {
    await store.close();
  }
}

/** A credential exactly as written before key ids existed: no key header. */
async function createLegacyCredential(store: NodeSqliteControlStore, key: Buffer, value: string) {
  const id = 'legacy-credential',
    nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`workspace:${id}:1`));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return store.createCredential({
    id,
    workspaceId: 'workspace',
    label: 'Legacy',
    provider: 'fixture',
    type: 'api-key',
    environment: 'test',
    backend: 'local',
    permittedAgentIds: [],
    createdBy: 'test',
    fingerprint: 'sha256:legacy',
    secret: { ciphertext, nonce, authTag: cipher.getAuthTag(), backendRef: null },
  });
}

const input = (value: string) => ({
  workspaceId: 'workspace',
  label: value,
  provider: 'fixture',
  type: 'api-key',
  environment: 'test',
  value,
  createdBy: 'test',
});

describe('master key versioning', () => {
  it('tags new ciphertext with the primary key id', async () => {
    await withStore(async (store) => {
      const secrets = new LocalAesGcmSecretManager(store, newKey);
      const credential = await secrets.create(input('tagged'));
      const blob = await store.getActiveSecretBlob('workspace', credential.id);
      expect(blob?.backendRef).toBeNull();
      expect(Buffer.from(blob!.ciphertext!).subarray(0, 12)).toEqual(
        Buffer.concat([Buffer.from('ovk1'), Buffer.from(masterKeyId(newKey), 'hex')]),
      );
      expect(masterKeyId(newKey)).toMatch(/^[a-f\d]{16}$/);
      expect(masterKeyId(newKey)).not.toBe(masterKeyId(oldKey));
    });
  });

  it('round-trips an empty value, whose ciphertext is the key header alone', async () => {
    await withStore(async (store) => {
      const secrets = new LocalAesGcmSecretManager(store, masterKeyRing(newKey, [oldKey]));
      const credential = await secrets.create(input(''));
      const blob = await store.getActiveSecretBlob('workspace', credential.id);
      expect(blob!.ciphertext!.length).toBe(12);
      await expect(secrets.resolve('workspace', credential.id)).resolves.toBe('');
    });
  });

  it('keeps unversioned ciphertext readable with the same key and after rotation', async () => {
    await withStore(async (store) => {
      const legacy = await createLegacyCredential(store, oldKey, 'legacy-value');
      await expect(
        new LocalAesGcmSecretManager(store, oldKey).resolve('workspace', legacy.id),
      ).resolves.toBe('legacy-value');
      const rotated = new LocalAesGcmSecretManager(store, masterKeyRing(newKey, [oldKey]));
      await expect(rotated.resolve('workspace', legacy.id)).resolves.toBe('legacy-value');
      await expect(
        new LocalAesGcmSecretManager(store, newKey).resolve('workspace', legacy.id),
      ).rejects.toThrow('cannot be decrypted with any configured master key');
    });
  });

  it('still reads a legacy ciphertext whose first bytes happen to look like a key header', async () => {
    await withStore(async (store) => {
      const id = 'header-lookalike',
        nonce = randomBytes(12),
        header = Buffer.concat([Buffer.from('ovk1'), Buffer.from(masterKeyId(newKey), 'hex')]);
      // GCM is a stream cipher: XOR the keystream so the legacy ciphertext starts with the header.
      const stream = createCipheriv('aes-256-gcm', oldKey, nonce).update(Buffer.alloc(16));
      const value = Buffer.concat([
        Buffer.from(header.map((byte, index) => byte ^ stream[index]!)),
        Buffer.from('-tail'),
      ]);
      const cipher = createCipheriv('aes-256-gcm', oldKey, nonce);
      cipher.setAAD(Buffer.from(`workspace:${id}:1`));
      const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
      expect(ciphertext.subarray(0, 12)).toEqual(header);
      await store.createCredential({
        id,
        workspaceId: 'workspace',
        label: 'Lookalike',
        provider: 'fixture',
        type: 'api-key',
        environment: 'test',
        backend: 'local',
        permittedAgentIds: [],
        createdBy: 'test',
        fingerprint: 'sha256:lookalike',
        secret: { ciphertext, nonce, authTag: cipher.getAuthTag(), backendRef: null },
      });
      await expect(
        new LocalAesGcmSecretManager(store, masterKeyRing(newKey, [oldKey])).resolve(
          'workspace',
          id,
        ),
      ).resolves.toBe(value.toString('utf8'));
    });
  });

  it('names the missing key instead of orphaning a key-tagged credential', async () => {
    await withStore(async (store) => {
      const credential = await new LocalAesGcmSecretManager(store, oldKey).create(input('old'));
      const rotated = new LocalAesGcmSecretManager(store, masterKeyRing(newKey, [oldKey]));
      await expect(rotated.resolve('workspace', credential.id)).resolves.toBe('old');
      await expect(
        new LocalAesGcmSecretManager(store, newKey).resolve('workspace', credential.id),
      ).rejects.toThrow(`master key ${masterKeyId(oldKey)}, which is not configured`);
    });
  });

  it('rewraps every active credential so the previous key can be dropped', async () => {
    await withStore(async (store) => {
      const before = new LocalAesGcmSecretManager(store, oldKey);
      const tagged = await before.create(input('tagged-old'));
      const legacy = await createLegacyCredential(store, oldKey, 'legacy-old');
      const retired = await before.create(input('retired'));
      await before.retire('workspace', retired.id);
      const rotated = new LocalAesGcmSecretManager(store, masterKeyRing(newKey, [oldKey]));
      const fresh = await rotated.create(input('already-new'));

      const dryRun = await rewrapWorkspaceCredentials({
        store,
        secrets: rotated,
        workspaceId: 'workspace',
        backend: 'local',
        dryRun: true,
      });
      expect(dryRun).toMatchObject({ pending: 2, current: 1, rewrapped: 0, skipped: 1 });
      expect((await store.getCredential('workspace', tagged.id))?.currentVersion).toBe(1);

      const summary = await rewrapWorkspaceCredentials({
        store,
        secrets: rotated,
        workspaceId: 'workspace',
        backend: 'local',
      });
      expect(summary).toMatchObject({ rewrapped: 2, current: 1, skipped: 1, failed: [] });
      const after = await store.getCredential('workspace', tagged.id);
      expect(after?.currentVersion).toBe(2);
      expect(after?.fingerprint).toBe(tagged.fingerprint);

      const newOnly = new LocalAesGcmSecretManager(store, newKey);
      await expect(newOnly.resolve('workspace', tagged.id)).resolves.toBe('tagged-old');
      await expect(newOnly.resolve('workspace', legacy.id)).resolves.toBe('legacy-old');
      await expect(newOnly.resolve('workspace', fresh.id)).resolves.toBe('already-new');
      expect(
        await rewrapWorkspaceCredentials({
          store,
          secrets: newOnly,
          workspaceId: 'workspace',
          backend: 'local',
        }),
      ).toMatchObject({ current: 3, rewrapped: 0, failed: [] });
    });
  });

  it('reports a credential whose key is missing without stopping the batch', async () => {
    await withStore(async (store) => {
      const orphan = await new LocalAesGcmSecretManager(store, oldKey).create(input('orphan'));
      const secrets = new LocalAesGcmSecretManager(store, newKey);
      await secrets.create(input('fine'));
      const summary = await rewrapWorkspaceCredentials({
        store,
        secrets,
        workspaceId: 'workspace',
        backend: 'local',
      });
      expect(summary.current).toBe(1);
      expect(summary.failed).toEqual([
        { credentialId: orphan.id, error: expect.stringContaining('not configured') },
      ]);
    });
  });

  it('refuses a rewrap that would overwrite a concurrent rotation', async () => {
    await withStore(async (store) => {
      const credential = await new LocalAesGcmSecretManager(store, oldKey).create(input('one'));
      const rotated = new LocalAesGcmSecretManager(store, masterKeyRing(newKey, [oldKey]));
      // The operator rotates to a new value between the rewrap's read and its write.
      const racing: CredentialStore = {
        createCredential: store.createCredential.bind(store),
        getCredential: store.getCredential.bind(store),
        getActiveSecretBlob: store.getActiveSecretBlob.bind(store),
        retireCredential: store.retireCredential.bind(store),
        rotateCredential: async (...args) => {
          await rotated.rotate('workspace', credential.id, 'two');
          return store.rotateCredential(...args);
        },
      };
      await expect(
        new LocalAesGcmSecretManager(racing, masterKeyRing(newKey, [oldKey])).rewrap(
          'workspace',
          credential.id,
        ),
      ).rejects.toThrow('rotated during rewrap');
      await expect(rotated.resolve('workspace', credential.id)).resolves.toBe('two');
      expect((await store.getCredential('workspace', credential.id))?.currentVersion).toBe(2);
    });
  });
});

describe('master key configuration', () => {
  it('reads the previous keys from the environment, newest first, ignoring blanks', () => {
    const ring = masterKeyRingFromEnv({
      OVO_SECRETS_MASTER_KEY: newKey.toString('hex'),
      OVO_SECRETS_MASTER_KEY_PREVIOUS: ` ${oldKey.toString('base64')}, ,${newKey.toString('hex')}`,
    });
    expect(ring.primary.id).toBe(masterKeyId(newKey));
    expect(ring.previous.map((key) => key.id)).toEqual([masterKeyId(oldKey)]);
    expect(masterKeyRingFromEnv({ OVO_SECRETS_MASTER_KEY: newKey.toString('hex') })).toEqual({
      primary: { id: masterKeyId(newKey), key: newKey },
      previous: [],
    });
    expect(() =>
      masterKeyRingFromEnv({
        OVO_SECRETS_MASTER_KEY: newKey.toString('hex'),
        OVO_SECRETS_MASTER_KEY_PREVIOUS: 'short',
      }),
    ).toThrow('OVO_SECRETS_MASTER_KEY_PREVIOUS must decode to exactly 32 bytes');
  });

  it('declares the previous keys as a secret plugin field', () => {
    expect(secretsPlugin.manifest.secretFields).toContain('previousMasterKeys');
  });
});
