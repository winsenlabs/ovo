export * from './human-store.ts';

import type {
  AudioFormat,
  HandoffTransferMeta,
  HoldPolicy,
  RouteLines,
  RoutingHours,
  SegmentHandoffRequest,
} from '@winsendotai/ovo-contracts';

/*
 * Human queue design section 4 as the worker reads it. The contracts package (core lane, M1)
 * owns these shapes; until the worker rebases on it this file mirrors them type for type, so the
 * swap is one import path. Nothing here is a second source of truth: every name is the design's.
 */

export interface QueueContextPolicy {
  callerId: boolean;
  calledNumber: boolean;
  language: boolean;
  intent: boolean;
  summary: boolean;
  transcriptTurns: number;
  transcriptLink: boolean;
  /** `declared`: the captured variables the transferring agent's schema declares (managed only). */
  variables: 'declared' | readonly string[];
  summarize: 'agent_only' | 'generate';
}

export interface WebhookSpec {
  url: string;
  method: 'POST' | 'PUT';
  format: 'json' | 'form';
  credentialId: string;
  auth:
    | { kind: 'none' }
    | { kind: 'bearer'; credentialId: string }
    | { kind: 'header'; name: string; credentialId: string };
  headers: Readonly<Record<string, string>>;
  body?: Readonly<Record<string, unknown>>;
  timeoutMs: number;
  retry: { attempts: number; baseMs: number; maxMs: number; deadlineMs: number };
  response: {
    statusPath?: string;
    acceptedValues: readonly string[];
    queuedValues: readonly string[];
    rejectedValues: readonly string[];
    ticketRefPath?: string;
    destinationE164Path?: string;
    destinationSipUriPath?: string;
    destinationHeadersPath?: string;
  };
  cancel: boolean;
}

export interface DestinationPolicy {
  allowE164Prefixes: readonly string[];
  allowSipHosts: readonly string[];
  allowInsecureSip: boolean;
  allowedHeaders: readonly string[];
}

interface QueueBase {
  name: string;
  hours?: RoutingHours;
  announcement?: RouteLines;
  hold?: HoldPolicy;
  limits: { maxWaiting: number };
}

export interface ExternalQueue extends QueueBase {
  kind: 'external';
  webhook: WebhookSpec;
  destination: DestinationPolicy;
  context: QueueContextPolicy;
  callbackWindowHours: number;
}

export interface ManagedQueue extends QueueBase {
  kind: 'managed';
  assignment: 'AUTO_ASSIGN' | 'OPEN_PICKUP';
  teamIds: readonly string[];
  language: 'ignore' | 'prefer' | 'require';
  offerSeconds: number;
  joinSeconds: number;
  requireOnline: boolean;
  ai: { mode: 'out' | 'transcribe'; transcribeOperator: boolean };
  onOperatorLeave: 'end_call' | 'return_to_agent';
  returnTargets: readonly string[];
  returnDefault?: string;
  wrapUp: { required: boolean; dispositions: readonly string[] };
  context: QueueContextPolicy;
}

export type HumanQueueDefinition = ExternalQueue | ManagedQueue;

/** A queue as frozen into a routing release (`RoutingReleaseSnapshot.queues`, schema 3). */
export interface QueueSnapshot {
  id: string;
  version: number;
  key: string;
  priority: number;
  definition: HumanQueueDefinition;
}

/** The caller's identity in a room; an operator's is `op:<user id>` (design 11). */
export const CALLER_IDENTITY = 'caller';

/** `SegmentHandoffRequest` kind `human` (design 4.4 `runtime.ts`), until the contracts carry it. */
export interface HumanHandoff {
  kind: 'human';
  reason: 'route' | 'transfer';
  /** The routing point's binding key of the queue. */
  queueId: string;
  variables: Record<string, string>;
  route?: { path: string[]; poolId?: string; memberId?: string; claimId?: string };
  transfer?: HandoffTransferMeta;
}
export type WideHandoffRequest = SegmentHandoffRequest | HumanHandoff;

/** Capability `ovo.media-room`'s port (design 4.5), as the bridge reads it. */
export interface RoomSeat {
  sendAudio(frame: Uint8Array): void;
  onOperatorAudio(listener: (frame: Uint8Array) => void): () => void;
  onParticipant(
    listener: (event: { kind: 'joined' | 'left'; identity: string; role: string }) => void,
  ): () => void;
  operatorPresent(): boolean;
  sendData(topic: string, payload: Uint8Array, identities?: readonly string[]): void;
  stats(): {
    framesIn: number;
    framesOut: number;
    droppedIn: number;
    droppedOut: number;
    connectedMs: number;
  };
  close(): Promise<void>;
}

export interface MediaRoomProvider {
  readonly provider: string;
  readonly publicUrl: string;
  health(signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }>;
  ensureRoom(input: {
    name: string;
    maxParticipants: number;
    emptyTimeoutSeconds: number;
  }): Promise<void>;
  deleteRoom(name: string): Promise<void>;
  removeParticipant(room: string, identity: string): Promise<void>;
  join(input: {
    room: string;
    identity: string;
    format: AudioFormat;
    signal: AbortSignal;
  }): Promise<RoomSeat>;
}

/** The meters a human segment reports (design 4.4 `HUMAN_METER_KEYS`). */
export const HUMAN_METER_KEYS = Object.freeze({
  operatorSeconds: 'ovo.human.operator_seconds',
  roomSeconds: 'ovo.human.room_seconds',
});

/** Why a human handoff is refused at `begin`, before anything is announced (design 9.1). */
export type HumanRefusal =
  'queue_unknown' | 'queue_closed' | 'queue_unavailable' | 'queue_full' | 'no_operators';

/** Hold-timeout / step failures a chain records for a queue (design 9.2). */
export type HumanFailure = string;
