import type {
  EndReason,
  MemberClaim,
  RoutingMemberCandidate,
  VoiceMediaTransport,
  HandoffTransferMeta,
  HoldPolicy,
  RoutingTransferPolicy,
  SegmentHandoffRequest,
  TransferTarget,
} from '@winsendotai/ovo-contracts';
import type { CallMemory, SegmentHistoryEntry } from './call-memory.ts';
import type { CallSegment } from './call-segment.ts';
import type { HoldClock, HoldPlayer } from './hold-player.ts';
import type { SegmentMediaLease } from './segment-media.ts';
import type { AttemptTarget, SegmentAttempt } from './transfer-attempt.ts';

/** Claim retries while a queued transfer holds for capacity (transfer design 7.4). */
export const TRANSFER_CLAIM_RETRY_MS = 3_000;
/** A started target that has not spoken yet stops the hold after this long anyway. */
export const HOLD_AFTER_START_MS = 5_000;
/** A timeout chain step that begins a target holds at most this long (or the policy's maxSeconds). */
export const STEP_HOLD_SECONDS = 60;
/** Ledger 005 keeps segment indexes 0-63; a call never composes more segments than that. */
export const MAX_SEGMENT_INDEX = 63;

/** A catalogue target resolved into a handoff request (its member claimed when it names a pool). */
export interface ResolvedTarget {
  request: SegmentHandoffRequest;
  target: TransferTarget;
  claimed: boolean;
}

/** A segment attached to the call's link, or one starting. */
export interface LiveSegment {
  segment: CallSegment;
  lease: SegmentMediaLease;
  entry: SegmentHistoryEntry;
}

export type HoldSource = 'target' | 'point' | 'default';

/** A transfer (or the router's handoff) from `begin` until it connects or the chain ends it. */
export interface TransferRun {
  id: string;
  request: SegmentHandoffRequest;
  /** 1-based per call; absent for the router's start-of-call handoff. */
  transfer?: number;
  meta?: HandoffTransferMeta;
  from: SegmentHistoryEntry;
  committed: boolean;
  begunAt: number;
  hold: { policy: HoldPolicy; source: HoldSource };
  attempt?: SegmentAttempt;
  queue?: { poolId: string; tiers: RoutingMemberCandidate[][]; since: number };
  /** The catalogue target the request named, for its label and handover. */
  target?: TransferTarget;
  /** The run took a member claim the call's previous one gave way to. */
  claimed: boolean;
}

export interface TransferControllerDeps {
  media: VoiceMediaTransport;
  format: { sampleRate: number; encoding: string };
  /** The routing snapshot's releaseIds: the only releases a call may hand off to. */
  allowed: ReadonlySet<string>;
  /** The routing release's default target (the chain's `default` step, then `release_default`). */
  fallback: { agentId: string; releaseId: string };
  /** The router release: what a re-route through a node composes. */
  router?: { agentId: string; releaseId: string };
  policy?: RoutingTransferPolicy;
  memory: CallMemory;
  /** Composes an attempt's target (an agent release, or the router with an entry) on `lease`. */
  compose(target: AttemptTarget, index: number, lease: SegmentMediaLease): Promise<CallSegment>;
  /** Session events of the call (`route.segment`, `transfer.*`, `segment.ended`, `disposition`). */
  record(type: string, payload: Record<string, unknown>): void;
  audit(type: string, payload: Record<string, unknown>): void;
  log(event: string, fields: Record<string, unknown>): void;
  /** The call's member claims: tiers in priority order, fail-open; release drops the call's. */
  claims: {
    claim(tiers: readonly (readonly RoutingMemberCandidate[])[]): Promise<MemberClaim>;
    release(): Promise<void>;
  };
  /** A catalogue key for a timeout chain's `target` step, gated as a transfer from `from`. */
  resolveTarget?(
    key: string,
    from: SegmentHistoryEntry,
  ): Promise<ResolvedTarget | { refusal: string }>;
  /** A hold player on its own live lease of the call's media. */
  holdPlayer(policy: HoldPolicy, tags: Record<string, unknown>): HoldPlayer;
  /** Ends the call when no engine is left to end it: the hang-up, then the link. */
  endCall(reason: EndReason): Promise<void>;
  /** When the call's time limit (the router policy's) is reached, epoch ms. */
  callEndsAt: number;
  defaultLanguage: string;
  /** The router release's timezone: a callback promise is kept in it (the API requires one). */
  timezone: string;
  prepareTimeoutMs?: number;
  clock?: HoldClock;
}

/** What the connect loop needs of its controller. */
export interface ConnectHost {
  readonly deps: TransferControllerDeps;
  readonly clock: HoldClock;
  readonly ended: boolean;
  readonly endedSignal: AbortSignal;
  attempt(run: TransferRun, target: AttemptTarget): SegmentAttempt | undefined;
  start(
    run: TransferRun,
    attempt: SegmentAttempt,
    gapFrom: number,
    hold: HoldPlayer,
  ): Promise<boolean>;
  /** The run is over (connected, ended or the call is gone): nothing hands off any more. */
  settle(run: TransferRun): void;
}
