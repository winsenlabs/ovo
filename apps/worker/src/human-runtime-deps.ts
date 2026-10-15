import type {
  AudioFormat,
  RoutingTransferPolicy,
  SecretResolver,
  UsageSink,
} from '@winsendotai/ovo-contracts';
import type { WebhookDeps } from '@winsendotai/ovo-session-host';
import type { CallMemory, SegmentHistoryEntry } from './call-memory.ts';
import type { HumanShared } from './human-breaker.ts';
import type { HumanQueuePort, MediaRoomProvider, QueueSnapshot } from './human-contract.ts';
import type { HoldClock } from './hold-player.ts';
import type { OpenStt, TranscriptSink } from './human-transcriber.ts';
import type { SegmentMediaLease } from './segment-media.ts';

/** What a carrier handoff came to (design 7.8): `rejected` keeps the caller on the line. */
export type CarrierHandoffResult =
  { kind: 'confirmed' | 'unknown' } | { kind: 'rejected'; reason: string };

/** A dynamic handoff target: R3 adds the SIP URI to the carrier contract. */
export type DynamicHandoffTarget =
  { kind: 'phone'; e164: string } | { kind: 'sip'; uri: string; headers?: Record<string, string> };

export interface HumanRuntimeDeps {
  /** The release's queues by the binding key a `human` step or target names. */
  queues: ReadonlyMap<string, QueueSnapshot>;
  service: HumanQueuePort;
  rooms?: MediaRoomProvider;
  shared: HumanShared;
  /** `OVO_HUMAN_QUEUE_WEBHOOK_ENABLED`. */
  webhookEnabled: boolean;
  clock: HoldClock;
  /** Aborted when the call is over; read lazily (the controller exists after this). */
  ended: () => AbortSignal;
  call: {
    workspaceId: string;
    jobId: string;
    sessionId: string;
    callId: string;
    routingReleaseId: string;
    routerAgentId: string;
    direction: 'inbound' | 'outbound';
    startedAt: number;
    numbers: { from?: string; to?: string };
  };
  format: AudioFormat;
  policy?: RoutingTransferPolicy;
  memory: CallMemory;
  secrets: SecretResolver;
  /** `<origin>`: ticket callback and context links are `<origin>/api/v1/human-queue/...`. */
  callbackBaseUrl: string;
  /** `OVO_HUMAN_QUEUE_POLL_MS`. */
  pollMs: number;
  contextRetentionHours: number;
  network?: WebhookDeps['network'];
  random?: () => number;
  record(type: string, payload: Record<string, unknown>): void;
  audit(type: string, payload: Record<string, unknown>): void;
  log(event: string, fields: Record<string, unknown>): void;
  /** Hands the carrier leg on before the session ends (design 7.8); absent: no external queue. */
  carrierHandoff?(target: DynamicHandoffTarget, ticketId: string): Promise<CarrierHandoffResult>;
  /** The leg left OVO: ends the session `transferred` without a hang-up. */
  endHandedOff(): Promise<void>;
  /** A human segment ends the call (operator hang-up, operator gone): hang-up, then the lease. */
  endCall(lease: SegmentMediaLease, reason: 'behavior_completed' | 'caller_hangup'): Promise<void>;
  /** The captured values the transferring agent's variables schema declares. */
  declaredValues(from: SegmentHistoryEntry): Promise<Record<string, unknown>>;
  /**
   * `context.summarize: 'generate'` (P2): one LLM call on the router's model for a note on the
   * call; absent, or any failure, the transferring agent's own summary stands.
   */
  summarize?(input: {
    lines: ReturnType<CallMemory['recent']>;
    hint?: string;
    signal: AbortSignal;
  }): Promise<string | undefined>;
  /** The operator sends the caller back to an agent (design 7.5 `return_to_agent`). */
  returnToAgent?(input: {
    key: string;
    from: SegmentHistoryEntry;
    lease: SegmentMediaLease;
    signal: AbortSignal;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Opens the call's STT for captions and the transcript (design 7.5); absent: no captions. */
  openStt?: OpenStt;
  /** A caption or transcript line becomes a transcript event, under the call's text policy. */
  transcript?: TranscriptSink;
  /** The STT language of the router release. */
  sttLanguage: string;
  /** The call's usage sink for segment `index` (STT of the transcriber is its usage). */
  usageFor(index: number): UsageSink;
  /** The segment attached to the call's link now. */
  attachedEntry(): SegmentHistoryEntry | undefined;
}
