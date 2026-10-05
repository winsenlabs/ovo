import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { SecretResolver } from '@winsendotai/ovo-contracts';
import type { CredentialStore, CreateCredentialInput, SecretBlob, SecretManager } from './types.ts';
import { fingerprint, masterKeyRing, type MasterKey, type MasterKeyRing } from './crypto.ts';
import { assertCredentialPolicy } from './policy.ts';

/**
 * Ciphertext written since key versioning starts with `ovk1` and the 8-byte id of the key that
 * produced it. Storage requires `backendRef` to stay null for local blobs, so the id travels in
 * the ciphertext column. Older blobs have no header and are tried against every configured key.
 */
const KEY_HEADER = Buffer.from('ovk1'),
  KEY_ID_BYTES = 8;

function keyHeader(id: string) {
  return Buffer.concat([KEY_HEADER, Buffer.from(id, 'hex')]);
}

function splitKeyHeader(ciphertext: Uint8Array) {
  const bytes = Buffer.from(ciphertext),
    length = KEY_HEADER.length + KEY_ID_BYTES;
  if (bytes.length < length || !bytes.subarray(0, KEY_HEADER.length).equals(KEY_HEADER))
    return undefined;
  return {
    id: bytes.subarray(KEY_HEADER.length, length).toString('hex'),
    ciphertext: bytes.subarray(length),
  };
}

export type RewrapOutcome = 'current' | 'pending' | 'rewrapped';

export class LocalAesGcmSecretManager implements SecretManager {
  private readonly keys: MasterKeyRing;
  constructor(
    private readonly store: CredentialStore,
    key: Uint8Array | MasterKeyRing,
    private readonly backend: 'local' | 'encrypted-store' = 'local',
  ) {
    this.keys = key instanceof Uint8Array ? masterKeyRing(key) : key;
  }
  private encrypt(workspaceId: string, credentialId: string, version: number, value: string) {
    const { id, key } = this.keys.primary,
      nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`${workspaceId}:${credentialId}:${version}`));
    const ciphertext = Buffer.concat([keyHeader(id), cipher.update(value, 'utf8'), cipher.final()]);
    return { ciphertext, nonce, authTag: cipher.getAuthTag(), backendRef: null };
  }
  private decryptWith(
    key: MasterKey,
    workspaceId: string,
    credentialId: string,
    blob: SecretBlob,
    ciphertext: Uint8Array,
  ) {
    const decipher = createDecipheriv('aes-256-gcm', key.key, blob.nonce!);
    decipher.setAAD(Buffer.from(`${workspaceId}:${credentialId}:${blob.version}`));
    decipher.setAuthTag(blob.authTag!);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
  private decrypt(workspaceId: string, credentialId: string, blob: SecretBlob) {
    const ring = [this.keys.primary, ...this.keys.previous],
      tagged = splitKeyHeader(blob.ciphertext!);
    const key = tagged && ring.find((item) => item.id === tagged.id);
    if (tagged && key) {
      try {
        return this.decryptWith(key, workspaceId, credentialId, blob, tagged.ciphertext);
      } catch {
        /* A legacy ciphertext can begin with the header bytes by chance. */
      }
    }
    // Unversioned blobs predate key ids: the GCM tag identifies the key that wrote them.
    for (const item of ring) {
      try {
        return this.decryptWith(item, workspaceId, credentialId, blob, blob.ciphertext!);
      } catch {
        /* Try the next configured key. */
      }
    }
    throw new Error(
      tagged
        ? `Secret is encrypted with master key ${tagged.id}, which is not configured; ` +
            'set it in OVO_SECRETS_MASTER_KEY_PREVIOUS'
        : 'Secret cannot be decrypted with any configured master key',
    );
  }
  private async activeBlob(workspaceId: string, credentialId: string) {
    const secret = await this.store.getActiveSecretBlob(workspaceId, credentialId);
    if (
      !secret ||
      secret.backend !== this.backend ||
      !secret.ciphertext ||
      !secret.nonce ||
      !secret.authTag
    )
      throw new Error('Active encrypted secret not found');
    return secret;
  }
  async create(input: CreateCredentialInput) {
    const id = randomUUID(),
      secret = this.encrypt(input.workspaceId, id, 1, input.value);
    return this.store.createCredential({
      ...input,
      id,
      backend: this.backend,
      permittedAgentIds: input.permittedAgentIds ?? [],
      fingerprint: fingerprint(input.value),
      secret,
    });
  }
  async rotate(workspaceId: string, credentialId: string, value: string) {
    return this.store.rotateCredential(workspaceId, credentialId, {
      fingerprint: fingerprint(value),
      secret: (version) => this.encrypt(workspaceId, credentialId, version, value),
    });
  }
  async resolve(workspaceId: string, credentialId: string) {
    await assertCredentialPolicy(this.store, workspaceId, credentialId);
    return this.decrypt(
      workspaceId,
      credentialId,
      await this.activeBlob(workspaceId, credentialId),
    );
  }
  /**
   * Re-encrypts the active version under the primary key as a new version with the same value,
   * so the previous key can be removed. A dry run still decrypts, proving the key is present.
   */
  async rewrap(workspaceId: string, credentialId: string, dryRun = false): Promise<RewrapOutcome> {
    const blob = await this.activeBlob(workspaceId, credentialId);
    const value = this.decrypt(workspaceId, credentialId, blob);
    if (splitKeyHeader(blob.ciphertext!)?.id === this.keys.primary.id) return 'current';
    if (dryRun) return 'pending';
    await this.store.rotateCredential(workspaceId, credentialId, {
      fingerprint: fingerprint(value),
      secret: (version) => {
        // Versions are allocated under the store's row lock; a concurrent rotation wins.
        if (version !== blob.version + 1)
          throw new Error('Credential was rotated during rewrap; rerun the rewrap');
        return this.encrypt(workspaceId, credentialId, version, value);
      },
    });
    return 'rewrapped';
  }
  forAgent(agentId: string): SecretResolver {
    return {
      resolve: async (workspaceId, credentialId) => {
        await assertCredentialPolicy(this.store, workspaceId, credentialId, agentId);
        return this.resolve(workspaceId, credentialId);
      },
    };
  }

  async retire(workspaceId: string, credentialId: string) {
    return this.store.retireCredential(workspaceId, credentialId);
  }
}
