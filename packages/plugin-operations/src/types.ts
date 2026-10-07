import type { Pool, PoolClient } from 'pg';
import type { ComplianceRefusalCode } from '@winsendotai/ovo-contracts';
import type { CallingWindow } from './calling-window.ts';
import type { CompliancePolicy } from './compliance/policy.ts';
import type { HandoffProviderPort } from './handoff-types.ts';
import type { ContactState } from './contact-state.ts';
export type { ContactState } from './contact-state.ts';
export type * from './handoff-types.ts';
export type {
  CampaignContactRecord,
  DoNotCallSource,
  SuppressionRecord,
  SuppressionScope,
} from './compliance-types.ts';

export type CampaignStatus = 'scheduled' | 'running' | 'paused' | 'cancelled' | 'completed';
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
  maxConcurrency?: number;
  carrierPluginId?: string;
  carrierId?: string;
  carrierBindingId?: string | null;
  bindingCps?: number | null;
  /** Calls are placed only inside this local window; absent places them at any hour. */
  callingWindow?: CallingWindow | null;
  /** The release's declared variables schema; each contact is checked against it at admission. */
  variablesSchema?: Record<string, unknown> | null;
  /** The agent's and the campaign's compliance choices; every dial is judged against them. */
  compliance?: CompliancePolicy | null;
}

export interface CampaignContactInput {
  sourceRow: number;
  phoneNumber: string;
  externalId?: string;
  variables: Record<string, string>;
}

export interface CampaignRecord extends Omit<
  CampaignConfig,
  'schedule' | 'variablesSchema' | 'compliance'
> {
  compliance: CompliancePolicy | null;
  id: string;
  status: CampaignStatus;
  scheduleAt: Date;
  timezone: string;
  version: number;
  driverError?: string;
}

export type CampaignCommandResult =
  { kind: 'applied'; campaign: CampaignRecord } | { kind: 'conflict'; campaign: CampaignRecord };

export type ContactAdmission =
  | { kind: 'admitted'; jobId: string; contactId: string; ownerEpoch: number; leaseExpiresAt: Date }
  | { kind: 'campaign_not_running'; status: CampaignStatus }
  | { kind: 'scheduled'; scheduleAt: Date }
  | { kind: 'quota_exhausted'; quota: 'total' | 'daily' }
  | { kind: 'capacity_exhausted' }
  | { kind: 'outside_calling_hours'; nextOpenAt: Date }
  | { kind: 'compliance_paused'; reason: ComplianceRefusalCode }
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
        | 'daily_quota'
        | 'outside_calling_hours'
        | ComplianceRefusalCode;
    };

export interface CampaignCounters {
  contacts: Record<ContactState, number>;
  attempts: Record<
    | 'authorized'
    | 'dialing'
    | 'connected'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'reconciling'
    | 'superseded',
    number
  >;
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

export type AttemptTerminalStatus = 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'superseded';

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

export interface OperationsServiceOptions {
  organizationId: string;
  pool: Pool;
  handoffProvider: HandoffProviderPort;
  ownsPool?: boolean;
}

export type Database = Pool | PoolClient;
