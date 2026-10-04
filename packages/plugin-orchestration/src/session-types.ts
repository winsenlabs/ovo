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

interface CorrelationKeys {
  sessionId?: string;
  carrierCallId?: string;
  dialRequestId?: string;
  carrierRequestId?: string;
}

export type RouteLookup =
  | (CorrelationKeys & { organizationId: string; carrierId: string })
  | (CorrelationKeys & { carrierCallId: string; organizationId?: never; carrierId?: never });

export interface BindCarrierCallInput {
  organizationId: string;
  carrierId: string;
  sessionId?: string;
  dialRequestId?: string;
  carrierCallId: string;
}

export type BindCarrierCallResult =
  { kind: 'bound' | 'alias'; route: SessionRoute } | { kind: 'conflict' | 'unmatched' };

export interface IssueStreamGrantInput {
  organizationId: string;
  carrierId: string;
  dialRequestId?: string;
  carrierRequestId?: string;
  carrierCallId?: string;
  streamCallIdMatchesDial?: boolean | 'unknown';
  tokenHash: string;
  expiresAt: Date;
}

export interface ReissueStreamInput {
  organizationId: string;
  carrierId: string;
  carrierCallId: string;
  tokenHash: string;
  expiresAt: Date;
  workerFreshSeconds: number;
}

export interface CarrierCallIdMismatchInput {
  sessionId: string;
  organizationId: string;
  carrierId: string;
  dialCallId: string;
  streamCallId: string;
}

export interface SessionTerminationRequester {
  (
    jobId: string,
    workerId: string,
    epoch: number,
    reason: string,
  ): Promise<{ carrierCallId?: string; carrierRequestId?: string } | undefined>;
  (
    route: Pick<SessionRoute, 'sessionId' | 'jobId' | 'workerId' | 'ownerEpoch'>,
    reason: string,
  ): Promise<{ carrierCallId?: string; carrierRequestId?: string } | undefined>;
}

export interface AdmissionSnapshot {
  readyIdleSlots: number;
  eligibleQueuedJobs: number;
  busySlots: number;
}

interface CarrierCallbackFields {
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

export type CarrierCallbackInput =
  | (CarrierCallbackFields & { organizationId: string; carrierId: string })
  | (CarrierCallbackFields & { organizationId?: never; carrierId?: never });

export type CarrierCallbackCorrelationInput = Omit<CarrierCallbackFields, 'carrierCallId'> & {
  carrierCallId?: string;
} & ({ organizationId: string; carrierId: string } | { organizationId?: never; carrierId?: never });

export type CarrierCallbackResult =
  | { kind: 'applied' | 'duplicate' | 'ignored_out_of_order'; route: SessionRoute }
  | { kind: 'correlation_conflict'; route: SessionRoute }
  | { kind: 'unmatched' };
