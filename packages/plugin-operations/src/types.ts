import type { Pool, PoolClient } from 'pg';

export type CampaignStatus = 'scheduled' | 'running' | 'paused' | 'cancelled' | 'completed';
export type ContactState =
  | 'queued'
  | 'admitted'
  | 'dialing'
  | 'active'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'suppressed'
  | 'exhausted';

export interface CampaignSchedule {
  localDateTime: string;
  timezone: string;
}

export interface CampaignConfig {
  operationId: string;
  name: string;
  agentReleaseId: string;
  fromNumber: string;
  schedule: CampaignSchedule;
  perNumberAttemptLimit: number;
  maxAttemptsTotal: number;
  maxAttemptsPerLocalDay: number;
  activeCallPolicy: 'continue' | 'request_end';
}

export interface CampaignContactInput {
  sourceRow: number;
  phoneNumber: string;
  externalId?: string;
  variables: Record<string, string>;
}

export interface CampaignRecord extends Omit<CampaignConfig, 'schedule'> {
  id: string;
  status: CampaignStatus;
  scheduleAt: Date;
  timezone: string;
  version: number;
}

export type CampaignCommandResult =
  { kind: 'applied'; campaign: CampaignRecord } | { kind: 'conflict'; campaign: CampaignRecord };

export type ContactAdmission =
  | { kind: 'admitted'; jobId: string; contactId: string; ownerEpoch: number; leaseExpiresAt: Date }
  | { kind: 'campaign_not_running'; status: CampaignStatus }
  | { kind: 'scheduled'; scheduleAt: Date }
  | { kind: 'quota_exhausted'; quota: 'total' | 'daily' }
  | { kind: 'empty' };

export interface DialAuthorization {
  kind: 'authorized';
  attemptId: string;
  requestId: string;
  campaignId: string;
  contactId: string;
  to: string;
  from: string;
  agentReleaseId: string;
  variables: Record<string, string>;
}

export interface CampaignDialJob {
  kind: 'campaign_dial_candidate';
  jobId: string;
  campaignId: string;
  contactId: string;
  admissionOwnerId: string;
  admissionEpoch: number;
}

export type DialAuthorizationResult =
  | DialAuthorization
  | {
      kind: 'blocked';
      reason:
        | 'campaign_not_running'
        | 'lease_lost'
        | 'suppressed'
        | 'attempt_limit'
        | 'total_quota'
        | 'daily_quota';
    };

export interface CampaignCounters {
  contacts: Record<ContactState, number>;
  attempts: Record<
    'authorized' | 'dialing' | 'connected' | 'succeeded' | 'failed' | 'cancelled' | 'unknown',
    number
  >;
}

export interface SuppressionRecord {
  phoneNumber: string;
  reason: string;
  createdAt: Date;
}

export interface OperationsServiceConfig {
  permittedFromNumbers: readonly string[];
  liveEnabled?: boolean;
}

export interface DispatchRecord {
  id: string;
  topic: 'campaign.dial.candidate';
  aggregateId: string;
  dedupKey: string;
  payload: CampaignDialJob;
}

export interface CampaignJobPort {
  enqueue(input: {
    jobId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    notBefore?: Date;
  }): Promise<void>;
}

export type AttemptTerminalStatus = 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export type InboundOverflowPolicy =
  | { kind: 'busy'; reason: string }
  | { kind: 'wait'; maxWaitMs: number; announcement: string }
  | { kind: 'callback'; queue: string; announcement: string }
  | { kind: 'human'; target: string; announcement: string };

export type InboundAdmission =
  | {
      kind: 'reserved';
      admissionId: string;
      slotId: string;
      workerId: string;
      generation: number;
      protectedUntil: Date;
    }
  | ({ admissionId: string } & InboundOverflowPolicy);

export interface InboundPolicyRecord {
  policy: InboundOverflowPolicy;
  version: number;
  updatedAt: Date;
}

export interface InboundDecisionRecord {
  admissionId: string;
  callId: string;
  decision: InboundAdmission['kind'];
  slotId?: string;
  detail: Record<string, unknown>;
  releasedAt?: Date;
  createdAt: Date;
}

export interface InboundRoute {
  organizationId: string;
  phoneNumber: string;
  releaseId: string;
  variables: Record<string, string>;
  enabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface InboundRouteInput {
  phoneNumber: string;
  releaseId: string;
  variables?: Record<string, string>;
  enabled?: boolean;
  expectedVersion: number | null;
}

export type InboundGatewayDecision =
  | {
      kind: 'reserved';
      admissionId: string;
      jobId: string;
      sessionId: string;
      workerId: string;
      workerEndpoint: string;
      releaseId: string;
      routeVersion: number;
    }
  | { kind: 'busy'; admissionId: string; reason: string }
  | {
      kind: 'wait';
      admissionId: string;
      announcement: string;
      expiresAt: Date;
      pollAfterMs: number;
    }
  | {
      kind: 'callback';
      admissionId: string;
      state: 'prompt' | 'queued' | 'declined' | 'suppressed';
      announcement: string;
      campaignId?: string;
      contactId?: string;
      jobId?: string;
    }
  | { kind: 'human'; admissionId: string; target: string; announcement: string };

export interface InboundGatewayCall {
  carrierCallId: string;
  fromNumber: string;
  toNumber: string;
  routeTokenHash: string;
  handshakeTtlMs: number;
}

export interface OwnedCallBinding {
  internalCallId: string;
  carrierCallId: string;
  releaseId: string;
  bindingReceiptId: string;
  status: 'active' | 'terminal';
}

export type HandoffTarget = { kind: 'phone'; value: string } | { kind: 'queue'; value: string };
export type HandoffFallback =
  | { kind: 'resume'; message: string }
  | { kind: 'human'; target: string; message: string }
  | { kind: 'end'; message: string };

export type HandoffProviderResult =
  | { kind: 'confirmed'; receiptId: string }
  | { kind: 'rejected'; reason: string; retryable: boolean }
  | { kind: 'unknown'; reason: string };

export type HandoffReconciliation =
  | { kind: 'confirmed'; receiptId: string }
  | { kind: 'rejected'; reason: string; retryable: boolean }
  | { kind: 'pending' }
  | { kind: 'not_found' };

export interface HandoffProviderPort {
  request(input: {
    requestId: string;
    carrierCallId: string;
    target: HandoffTarget;
  }): Promise<HandoffProviderResult>;
  reconcile(requestId: string): Promise<HandoffReconciliation>;
  fallback(input: {
    requestId: string;
    carrierCallId: string;
    fallback: HandoffFallback;
  }): Promise<HandoffProviderResult>;
}

export type HandoffStatus =
  | 'awaiting_confirmation'
  | 'ready'
  | 'submitting'
  | 'confirmed'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'fallback_submitting'
  | 'fallback_completed'
  | 'fallback_failed'
  | 'fallback_unknown';

export interface HandoffRecord {
  id: string;
  operationId: string;
  sessionId: string;
  carrierCallId: string;
  target: HandoffTarget;
  fallback: HandoffFallback;
  status: HandoffStatus;
  attempt: number;
  requestId?: string;
  fallbackAttempt: number;
  fallbackRequestId?: string;
  providerReceiptId?: string;
  retryable: boolean;
  lastError?: string;
}

export interface OperationsServiceOptions {
  organizationId: string;
  pool: Pool;
  handoffProvider: HandoffProviderPort;
  ownsPool?: boolean;
}

export type Database = Pool | PoolClient;
