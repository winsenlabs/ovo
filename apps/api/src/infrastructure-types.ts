import type { InfrastructureSnapshot } from '@winsendotai/ovo-contracts';
export type {
  InfrastructureSnapshot,
  ProviderQuotaSnapshot,
  ProviderThrottleSnapshot,
} from '@winsendotai/ovo-contracts';

export interface InfrastructureService {
  readonly organizationId: string;
  snapshot(workspaceId: string, releaseId?: string): Promise<InfrastructureSnapshot>;
}
