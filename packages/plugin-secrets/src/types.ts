import type { CredentialMetadata, SecretResolver } from '@winsendotai/ovo-contracts';
export type { CredentialMetadata, CredentialStore, SecretBlob } from '@winsendotai/ovo-contracts';

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
