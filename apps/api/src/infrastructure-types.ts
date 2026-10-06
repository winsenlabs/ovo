import type { InfrastructureSnapshot } from '@winsendotai/ovo-contracts';
import type { InboundReadinessReport } from './inbound-readiness.ts';
export type {
  InfrastructureSnapshot,
  ProviderQuotaSnapshot,
  ProviderThrottleSnapshot,
} from '@winsendotai/ovo-contracts';

export interface InfrastructureService {
  readonly organizationId: string;
  snapshot(workspaceId: string, releaseId?: string): Promise<InfrastructureSnapshot>;
  /** The dispatcher's latest inbound readiness; null before a dispatcher has published one. */
  inboundReadiness?(): Promise<InboundReadinessReport | null>;
}
