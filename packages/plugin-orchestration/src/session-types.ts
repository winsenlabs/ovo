export type SessionRouteStatus =
  'dialing' | 'accepted' | 'connected' | 'terminating' | 'completed' | 'failed' | 'cancelled';

export interface SessionRoute {
  sessionId: string;
  jobId: string;
  organizationId: string;
  workerId: string;
  workerEndpoint: string;
  ownerEpoch: number;
  generation: number;
  dialRequestId: string;
  carrierId?: string;
  bindingId?: string;
  carrierCallId?: string;
  carrierStreamCallId?: string;
  carrierRequestId?: string;
  status: SessionRouteStatus;
  handshakeExpiresAt: Date;
  handshakeClaimedAt?: Date;
  terminalAt?: Date;
  terminalReason?: string;
  releasedAt?: Date;
}

export type AuthenticatedSessionRoute = SessionRoute;

export interface BeginDialSessionInput {
  sessionId: string;
  jobId: string;
  organizationId: string;
  workerId: string;
  workerEndpoint: string;
  ownerEpoch: number;
  generation: number;
  dialRequestId: string;
  carrierId?: string;
  bindingId?: string;
  carrierRequestId?: string;
  handshakeTokenHash: string;
  handshakeExpiresAt: Date;
}

export interface MarkDialAcceptedInput {
  jobId: string;
  workerId: string;
  ownerEpoch: number;
  dialRequestId: string;
  carrierCallId?: string;
  carrierRequestId?: string;
}

export interface RouteLookup {
  sessionId?: string;
  carrierCallId?: string;
  dialRequestId?: string;
  carrierRequestId?: string;
}

export interface BindCarrierCallInput {
  sessionId?: string;
  dialRequestId?: string;
  carrierCallId: string;
}

export type BindCarrierCallResult =
  { kind: 'bound' | 'alias'; route: SessionRoute } | { kind: 'conflict' | 'unmatched' };

export interface IssueStreamGrantInput {
  dialRequestId?: string;
  carrierRequestId?: string;
  carrierCallId?: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface ReissueStreamInput {
  carrierCallId: string;
  tokenHash: string;
  expiresAt: Date;
  workerFreshSeconds: number;
}

export interface AdmissionSnapshot {
  readyIdleSlots: number;
  eligibleQueuedJobs: number;
  busySlots: number;
}

export interface CarrierCallbackInput {
  provider: string;
  eventId: string;
  dialRequestId?: string;
  carrierRequestId?: string;
  carrierCallId: string;
  status:
    | 'initiated'
    | 'ringing'
    | 'answered'
    | 'completed'
    | 'busy'
    | 'failed'
    | 'no_answer'
    | 'cancelled';
  occurredAt: Date;
  payload?: Record<string, unknown>;
}

export type CarrierCallbackCorrelationInput = Omit<CarrierCallbackInput, 'carrierCallId'> & {
  carrierCallId?: string;
};

export type CarrierCallbackResult =
  | { kind: 'applied' | 'duplicate' | 'ignored_out_of_order'; route: SessionRoute }
  | { kind: 'correlation_conflict'; route: SessionRoute }
  | { kind: 'unmatched' };
