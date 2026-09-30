import type { SecretResolver } from '@winsendotai/ovo-contracts';

export interface CredentialMetadata {
  id: string;
  workspaceId: string;
  label: string;
  provider: string;
  type: string;
  environment: string;
  backend: 'local' | 'encrypted-store' | 'aws-secrets-manager';
  currentVersion: number;
  status: 'active' | 'retired';
  permittedAgentIds: string[];
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  rotatedAt: string | null;
  retiredAt: string | null;
  fingerprint: string;
}
export interface SecretBlob {
  credentialId: string;
  version: number;
  backend: CredentialMetadata['backend'];
  ciphertext: Uint8Array | null;
  nonce: Uint8Array | null;
  authTag: Uint8Array | null;
  backendRef: string | null;
}
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

type StoredSecret = Omit<SecretBlob, 'credentialId' | 'version' | 'backend'>;

export interface CredentialStore {
  createCredential(input: {
    workspaceId: string;
    label: string;
    provider: string;
    type: string;
    environment: string;
    backend: CredentialMetadata['backend'];
    permittedAgentIds: string[];
    expiresAt?: string | null;
    createdBy: string;
    fingerprint: string;
    secret: StoredSecret;
    id?: string;
  }): Promise<CredentialMetadata>;
  rotateCredential(
    workspaceId: string,
    id: string,
    input: {
      fingerprint: string;
      secret: StoredSecret | ((version: number) => StoredSecret);
    },
  ): Promise<CredentialMetadata>;
  getCredential(workspaceId: string, id: string): Promise<CredentialMetadata | undefined>;
  getActiveSecretBlob(workspaceId: string, id: string): Promise<SecretBlob | undefined>;
  retireCredential(workspaceId: string, id: string): Promise<CredentialMetadata>;
}
