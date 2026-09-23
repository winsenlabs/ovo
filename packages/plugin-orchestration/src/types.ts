import type {
  AuthenticatedSessionRoute,
  BeginDialSessionInput,
  CarrierCallbackInput,
  CarrierCallbackCorrelationInput,
  CarrierCallbackResult,
  SessionRoute,
  RouteLookup,
} from './session-types.ts';

export type JobStatus =
  | 'queued'
  | 'owned'
  | 'dialing'
  | 'reconcile_required'
  | 'accepted'
  | 'connected'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JobReference {
  schemaVersion: 1;
  jobId: string;
}

export interface DurableJob {
  id: string;
  workspaceId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  ownerId?: string;
  ownerEpoch: number;
  leaseExpiresAt?: Date;
  dialRequestId?: string;
  carrierCallId?: string;
  lastError?: string;
}

export interface ClaimedJob extends DurableJob {
  ownerId: string;
  leaseExpiresAt: Date;
}

export type JobClaimResult =
  | { kind: 'execute'; job: ClaimedJob }
  | { kind: 'reconcile'; job: ClaimedJob }
  | { kind: 'defer'; reason: 'currently_leased' | 'not_before'; retryAt?: Date }
  | { kind: 'settled' }
  | { kind: 'missing' };

export interface OutboxRecord {
  id: string;
  topic: string;
  aggregateId: string;
  payload: JobReference;
}

export interface QueueDelivery {
  messageId: string;
  receiptHandle: string;
  reference: JobReference;
  receiveCount: number;
}

export interface DurableQueue {
  send(reference: JobReference): Promise<{ messageId: string }>;
  receive(options?: {
    maxMessages?: number;
    waitSeconds?: number;
    visibilitySeconds?: number;
  }): Promise<QueueDelivery[]>;
  delete(delivery: QueueDelivery): Promise<void>;
  changeVisibility(delivery: QueueDelivery, seconds: number): Promise<void>;
}

export interface DurableJobStore {
  enqueue(input: {
    id: string;
    workspaceId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    notBefore?: Date;
  }): Promise<{ job: DurableJob; created: boolean }>;
  claim(jobId: string, workerId: string, leaseMs: number): Promise<JobClaimResult>;
  heartbeat(jobId: string, workerId: string, epoch: number, leaseMs: number): Promise<boolean>;
  release(
    jobId: string,
    workerId: string,
    epoch: number,
    reason: string,
    notBefore?: Date,
  ): Promise<boolean>;
  updateOwnedPayload(
    jobId: string,
    workerId: string,
    epoch: number,
    payload: Record<string, unknown>,
  ): Promise<boolean>;
  beginDialSession(input: BeginDialSessionInput): Promise<SessionRoute | undefined>;
  markDialAccepted(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    carrierCallId: string,
  ): Promise<boolean>;
  markDialUnknown(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    reason: string,
  ): Promise<boolean>;
  prepareReconciledTermination(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    carrierCallId: string,
    reason: string,
  ): Promise<boolean>;
  deferReconciliation(
    jobId: string,
    workerId: string,
    epoch: number,
    reason: string,
    notBefore: Date,
  ): Promise<boolean>;
  markFailed(jobId: string, workerId: string, epoch: number, reason: string): Promise<boolean>;
  get(jobId: string): Promise<DurableJob | undefined>;
  getSessionRoute(jobId: string): Promise<SessionRoute | undefined>;
  resolveSessionRoute(input: RouteLookup): Promise<SessionRoute | undefined>;
  authenticateSessionRoute(
    sessionId: string,
    token: string,
  ): Promise<AuthenticatedSessionRoute | undefined>;
  applyCarrierCallback(input: CarrierCallbackInput): Promise<CarrierCallbackResult>;
  requestSessionTermination(
    jobId: string,
    workerId: string,
    epoch: number,
    reason: string,
  ): Promise<{ carrierCallId?: string; carrierRequestId?: string } | undefined>;
  releaseTerminalSession(jobId: string): Promise<boolean>;
}

export type { CarrierRouteStore } from './carrier-route-store.ts';

export type {
  SessionRouteStatus,
  SessionRoute,
  AuthenticatedSessionRoute,
  BeginDialSessionInput,
  MarkDialAcceptedInput,
  RouteLookup,
  BindCarrierCallInput,
  BindCarrierCallResult,
  IssueStreamGrantInput,
  ReissueStreamInput,
  AdmissionSnapshot,
  CarrierCallbackInput,
  CarrierCallbackCorrelationInput,
  CarrierCallbackResult,
} from './session-types.ts';

export interface ReadinessProbe {
  check(): Promise<{ ready: true } | { ready: false; reason: string }>;
}

export interface TaskProtection {
  establish(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export interface TelephonyDialRequest {
  requestId: string;
  jobId: string;
  workspaceId: string;
  to: string;
  from: string;
  streamUrl: string;
  streamParameters?: Record<string, string>;
  statusCallbackUrl: string;
}

export type DialResult =
  | { kind: 'accepted'; requestId: string; carrierCallId: string }
  | { kind: 'rejected'; requestId: string; reason: string; retryable: boolean }
  | { kind: 'unknown'; requestId: string; reason: string };

export type DialReconciliation =
  | { kind: 'accepted'; carrierCallId: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'pending' };

export interface TelephonyControl {
  dial(request: TelephonyDialRequest): Promise<DialResult>;
  reconcile(requestId: string, carrierCallId?: string): Promise<DialReconciliation>;
  hangup(carrierCallId: string): Promise<void>;
  transfer(carrierCallId: string, target: { twiml?: string; url?: string }): Promise<void>;
}

export interface DesiredCountWriter {
  readonly authorityId: string;
  write(serviceKey: string, desiredCount: number, epoch: number): Promise<void>;
  reconcile?(serviceKey: string): Promise<boolean>;
}

export interface CapacityLeaseStore {
  acquire(
    serviceKey: string,
    authorityId: string,
    leaseMs: number,
  ): Promise<{ epoch: number } | undefined>;
  renew(serviceKey: string, authorityId: string, epoch: number, leaseMs: number): Promise<boolean>;
}

export interface CapacityWriteAttempt {
  attemptId: string;
  serviceKey: string;
  authorityId: string;
  epoch: number;
  desiredCount: number;
  status: 'inflight' | 'unknown';
}

export type CapacityWritePermit =
  | { kind: 'permitted'; attempt: CapacityWriteAttempt }
  | { kind: 'stale_authority' }
  | { kind: 'unresolved'; attempt: CapacityWriteAttempt };

export interface CapacityWriteGuard {
  begin(input: {
    serviceKey: string;
    authorityId: string;
    epoch: number;
    desiredCount: number;
  }): Promise<CapacityWritePermit>;
  markApplied(attemptId: string): Promise<boolean>;
  markUnknown(attemptId: string, error: string): Promise<boolean>;
  pending(serviceKey: string): Promise<CapacityWriteAttempt | undefined>;
}

/**
 * Carrier contracts v2 (§2.8). The legacy `TelephonyControl`, `DialResult` and `TelephonyDialRequest`
 * above stay until wave 3; the v2 names that collide are re-exported with a `Carrier` prefix.
 */
export type {
  CallState,
  CarrierCapabilities,
  CarrierControlFactory,
  CarrierHostPorts,
  CarrierHttpReply,
  CarrierHttpRequest,
  CarrierHttpRoute,
  CarrierIngress,
  CarrierMediaEvent,
  DialRequest,
  DialResult as CarrierDialResult,
  HandoffTarget,
  HangupQuery,
  InboundAdmission,
  InboundDecision,
  MediaCodecSession,
  MediaCommand,
  MediaSerializer,
  NormalizedCallEvent,
  Reconciliation,
  ResolvedBinding,
  StreamGrant,
  TelephonyControl as CarrierTelephonyControl,
  UpgradeRequest,
} from '@winsendotai/ovo-contracts';
export { CarrierProtocolError } from '@winsendotai/ovo-contracts';
