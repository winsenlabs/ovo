import type {
  AgentConfig,
  EndReason,
  HandoffPrepareFailure,
  RouterEntry,
} from '@winsendotai/ovo-contracts';
import type { SegmentHistoryEntry } from './call-memory.ts';
import type { CallSegment } from './call-segment.ts';
import type { SegmentMediaLease } from './segment-media.ts';
import { composeWithin, type SegmentTarget } from './segment-prepare.ts';
import type { SegmentStats } from './segment-telemetry.ts';

/** Why a segment started: R1's reasons and R2's transfer, return and re-route. */
export type SegmentReason =
  'start' | 'route' | 'degraded' | 'fallback' | 'transfer' | 'return' | 'reroute';

/** What a transfer composes: an agent release, or the router re-entering its tree (`entry`). */
export interface AttemptTarget extends SegmentTarget {
  role: 'agent' | 'router';
  reason: SegmentReason;
  poolId?: string;
  memberId?: string;
  claimId?: string;
  /** The call's captured values; the composer keeps those the target's schema accepts. */
  captured?: Readonly<Record<string, unknown>>;
  entry?: RouterEntry;
}

/** What a human queue attempt stands for: not a release, a queue (R3, human queue design 7.1). */
export interface HumanTarget {
  role: 'human';
  reason: SegmentReason;
  kind: 'external' | 'managed';
  queueKey: string;
  queueId: string;
  /** `queue:<key>`, as the segment history names it. */
  agentId: string;
  /** The queue's id: a human segment has no release. */
  releaseId: string;
}

/** A segment the controller can start and attach: an agent graph, or a human queue's segment. */
export interface StartableSegment {
  readonly kind?: 'agent' | 'human';
  readonly release: {
    id: string;
    agentId: string;
    config: { language: string } & Partial<Pick<AgentConfig, 'variables'>>;
  };
  readonly stats?: SegmentStats;
  /** Human only: what the history entry records beyond the queue (`ticketId`, `operatorId`). */
  readonly entryInfo?: Pick<SegmentHistoryEntry, 'ticketId' | 'operatorId' | 'queueKind'>;
  /** Human only: the carrier leg already left OVO, so a call that ended meanwhile is no failure. */
  readonly handedOff?: boolean;
  /** Human only: how its `segment.ended` says it ended, when not by the usual reason. */
  readonly ending?: 'carrier_transfer' | 'operator_end';
  start(): Promise<void>;
  /** Called once the controller has attached it, opened its lease and recorded `route.segment`. */
  attached?(): void;
  close(reason: EndReason): Promise<unknown | undefined>;
}

/**
 * What the controller needs of a candidate for the next segment (human queue design 7.1): an
 * agent graph composing on a held lease (`SegmentAttempt`), or a human queue's ticket waiting to
 * connect (`HumanAttempt`). Its outcome is readable at once once `settled`; `take` hands the
 * segment over once; `drop` is idempotent and gives back whatever it held.
 */
export interface TransferAttempt {
  readonly index: number;
  readonly lease: SegmentMediaLease;
  readonly target: AttemptTarget | HumanTarget;
  /** The segment, or why there is none: a `HandoffPrepareFailure` or a human queue's code. */
  settled?: StartableSegment | string;
  prepareMs?: number;
  readonly ready: boolean;
  readonly result: Promise<StartableSegment | string>;
  readonly done: Promise<void>;
  /** Human only: the requester's announcement is going out, so the attempt begins (ticket, webhook). */
  commit?(): void;
  take(): StartableSegment | undefined;
  drop(): Promise<void>;
}

/**
 * One composition of a transfer's target on its own held lease (transfer design 7.1): bounded by
 * the prepare timeout and the call, its outcome readable at once once settled (`settled`). A graph
 * nobody takes (dropped, superseded, or arriving after the bound) is disposed when it lands, and a
 * failed composition gives its lease back. `take` hands the composed segment to the controller.
 */
export class SegmentAttempt implements TransferAttempt {
  settled?: CallSegment | HandoffPrepareFailure;
  prepareMs?: number;
  readonly result: Promise<CallSegment | HandoffPrepareFailure>;
  /** Settles once whatever the composition came to has been kept or disposed. */
  readonly done: Promise<void>;
  private state: 'pending' | 'taken' | 'dropped' = 'pending';
  private disposal?: Promise<unknown>;
  private readonly dispose: (segment: CallSegment) => Promise<unknown>;

  constructor(
    readonly index: number,
    readonly target: AttemptTarget,
    readonly lease: SegmentMediaLease,
    input: {
      work: Promise<CallSegment>;
      timeoutMs: number;
      signals: readonly AbortSignal[];
      now: () => number;
      dispose(segment: CallSegment, reason: EndReason): Promise<unknown>;
    },
  ) {
    const startedAt = input.now();
    const { outcome, composed } = composeWithin(input.work, input.timeoutMs, input.signals);
    this.result = outcome.then((settled) => {
      this.settled = settled;
      if (typeof settled !== 'string') this.prepareMs = input.now() - startedAt;
      return settled;
    });
    // Its lease goes first: the graph never held the link, so its engine closing reaches nothing.
    this.dispose = (segment) => {
      this.lease.release();
      return (this.disposal ??= input.dispose(segment, 'error:route-handoff-failed'));
    };
    this.done = composed.then(async (segment) => {
      const taken = await this.result;
      if (typeof segment === 'string') {
        this.lease.release();
        return;
      }
      if (segment !== taken || this.state === 'dropped') await this.dispose(segment);
    });
    // swallow-ok: a late composition's disposal failure has no call left to fail.
    this.done.catch(() => undefined);
  }

  /** True once the composition succeeded within its bound. */
  get ready(): boolean {
    return this.settled !== undefined && typeof this.settled !== 'string';
  }

  /** The composed segment, now owned by the caller; undefined unless ready and not dropped. */
  take(): CallSegment | undefined {
    if (this.state !== 'pending' || !this.ready) return undefined;
    this.state = 'taken';
    return this.settled as CallSegment;
  }

  /** Nobody will start it: disposes the graph now, or when it lands. Idempotent. */
  async drop(): Promise<void> {
    if (this.state !== 'pending') return;
    this.state = 'dropped';
    // swallow-ok: the graph is gone either way; a disposal failure has no segment left to fail.
    if (this.ready) await this.dispose(this.settled as CallSegment).catch(() => undefined);
  }
}
