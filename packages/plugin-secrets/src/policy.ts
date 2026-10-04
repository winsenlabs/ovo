import type { CredentialStore } from './types.ts';
export async function assertCredentialPolicy(
  store: CredentialStore,
  workspaceId: string,
  credentialId: string,
  agentId?: string,
) {
  const metadata = await store.getCredential(workspaceId, credentialId);
  if (!metadata || metadata.status !== 'active') throw new Error('Active credential not found');
  if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now())
    throw new Error('Credential expired');
  if (agentId && metadata.permittedAgentIds.length && !metadata.permittedAgentIds.includes(agentId))
    throw new Error('Credential is not permitted for this agent');
}
