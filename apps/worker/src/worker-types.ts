import type { ProtectionRenewal } from '@winsendotai/ovo-plugin-orchestration';
import type { ReconciliationOutcome } from './reconciliation.ts';
import type { JobLeaseRenewal } from './renewal.ts';

export type DeliveryOutcome =
  | { kind: 'duplicate' }
  | { kind: 'deferred'; reason: string }
  | {
      kind: 'accepted';
      jobId: string;
      carrierCallId?: string;
      carrierRequestId?: string;
      sessionId: string;
      protection: ProtectionRenewal;
      lease: JobLeaseRenewal;
    }
  | ReconciliationOutcome
  | { kind: 'failed'; reason: string };
