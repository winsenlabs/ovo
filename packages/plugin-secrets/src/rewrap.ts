import type { CredentialMetadata } from '@winsendotai/ovo-contracts';
import type { LocalAesGcmSecretManager } from './local.ts';

export interface CredentialLister {
  listCredentials(
    workspaceId: string,
    limit?: number,
    cursor?: string,
  ): Promise<{ items: CredentialMetadata[]; nextCursor: string | null }>;
}

export interface RewrapSummary {
  workspaceId: string;
  current: number;
  pending: number;
  rewrapped: number;
  skipped: number;
  failed: { credentialId: string; error: string }[];
}

/** Moves every active stored credential of one workspace onto the primary master key. */
export async function rewrapWorkspaceCredentials(input: {
  store: CredentialLister;
  secrets: Pick<LocalAesGcmSecretManager, 'rewrap'>;
  workspaceId: string;
  backend: 'local' | 'encrypted-store';
  dryRun?: boolean;
}): Promise<RewrapSummary> {
  const summary: RewrapSummary = {
    workspaceId: input.workspaceId,
    current: 0,
    pending: 0,
    rewrapped: 0,
    skipped: 0,
    failed: [],
  };
  let cursor: string | undefined;
  do {
    const page = await input.store.listCredentials(input.workspaceId, 100, cursor);
    for (const credential of page.items) {
      // Retired versions are never resolved again, and other backends hold no local ciphertext.
      if (credential.status !== 'active' || credential.backend !== input.backend) {
        summary.skipped += 1;
        continue;
      }
      try {
        summary[await input.secrets.rewrap(input.workspaceId, credential.id, input.dryRun)] += 1;
      } catch (error) {
        summary.failed.push({
          credentialId: credential.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return summary;
}
