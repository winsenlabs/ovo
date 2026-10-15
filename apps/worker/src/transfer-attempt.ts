import type { EndReason, HandoffPrepareFailure, RouterEntry } from '@winsendotai/ovo-contracts';
import type { CallSegment } from './call-segment.ts';
import type { SegmentMediaLease } from './segment-media.ts';
import { composeWithin, type SegmentTarget } from './segment-prepare.ts';

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

/**
 * One composition of a transfer's target on its own held lease (transfer design 7.1): bounded by
 * the prepare timeout and the call, its outcome readable at once once settled (`settled`). A graph
 * nobody takes (dropped, superseded, or arriving after the bound) is disposed when it lands, and a
 * failed composition gives its lease back. `take` hands the composed segment to the controller.
 */
export class SegmentAttempt {
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
