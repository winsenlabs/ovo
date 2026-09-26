import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { SecretResolver } from '@winsendotai/ovo-contracts';
import type { CredentialStore, CreateCredentialInput, SecretManager } from './types.ts';
import { fingerprint } from './crypto.ts';
import { assertCredentialPolicy } from './policy.ts';
export class LocalAesGcmSecretManager implements SecretManager {
  constructor(
    private readonly store: CredentialStore,
    private readonly key: Uint8Array,
    private readonly backend: 'local' | 'encrypted-store' = 'local',
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
      backend: this.backend,
      permittedAgentIds: input.permittedAgentIds ?? [],
      fingerprint: fingerprint(input.value),
      secret,
    });
  }
  async rotate(workspaceId: string, credentialId: string, value: string) {
    const metadata = await this.store.getCredential(workspaceId, credentialId);
    if (!metadata || metadata.status !== 'active') throw new Error('Active credential not found');
    return this.store.rotateCredential(workspaceId, credentialId, {
      fingerprint: fingerprint(value),
      secret: this.encrypt(workspaceId, credentialId, metadata.currentVersion + 1, value),
    });
  }
  async resolve(workspaceId: string, credentialId: string) {
    await assertCredentialPolicy(this.store, workspaceId, credentialId);
    const secret = await this.store.getActiveSecretBlob(workspaceId, credentialId);
    if (
      !secret ||
      secret.backend !== this.backend ||
      !secret.ciphertext ||
      !secret.nonce ||
      !secret.authTag
    )
      throw new Error('Active encrypted secret not found');
    const decipher = createDecipheriv('aes-256-gcm', this.key, secret.nonce);
    decipher.setAAD(Buffer.from(`${workspaceId}:${credentialId}:${secret.version}`));
    decipher.setAuthTag(secret.authTag);
    return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
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
