/** Metadata visible to callers; secret material is stored separately. */
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

export type StoredSecret = Omit<SecretBlob, 'credentialId' | 'version' | 'backend'>;

/** The narrow credential persistence port shared by storage and secret managers. */
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
