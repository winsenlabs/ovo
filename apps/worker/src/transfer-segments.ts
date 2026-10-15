import type { AgentConfig, EndReason, TransferHandover } from '@winsendotai/ovo-contracts';
import type { SegmentHistoryEntry } from './call-memory.ts';
import type { CallSegment } from './call-segment.ts';
import { realHoldClock, type HoldClock, type HoldPlayer } from './hold-player.ts';
import type { SegmentMediaLease } from './segment-media.ts';
import {
  disposeAttached,
  SegmentLinkOwner,
  ROUTING_PREPARE_TIMEOUT_MS,
  settleWithin,
  whenLinkCloses,
} from './segment-prepare.ts';
import {
  SegmentAttempt,
  type AttemptTarget,
  type StartableSegment,
  type TransferAttempt,
} from './transfer-attempt.ts';
import { connectTransfer } from './transfer-connect.ts';
import { endedMidTransfer, historyEntry, segmentEnded, segmentStarted } from './transfer-events.ts';
import { failStart } from './transfer-start.ts';
import { runHandover } from './transfer-handover.ts';
import {
  HOLD_AFTER_START_MS,
  MAX_SEGMENT_INDEX,
  type ConnectHost,
  type LiveSegment,
  type TransferControllerDeps,
  type TransferRun,
} from './transfer-types.ts';

/**
 * The segments of one routed call with in-call transfers on (transfer design 3, 7.1): R1's seam
 * (one engine attached to the call's link at a time, leases, the gap buffer, bounded composition)
 * and what happens between two segments. When the current engine closes its media into a
 * committed handoff, its graph is disposed (`segment.ended`) and the connect loop holds the caller
 * until the target is composed, starts it on its own lease (its first audio stops the hold, the gap
 * buffer only from its start) and attaches it, or runs the hold's timeout chain. Hang-up ends it
 * all: every segment, starting or composing, is disposed.
 */
export class TransferSegments extends SegmentLinkOwner implements ConnectHost {
  readonly clock: HoldClock;
  /** Transfers accepted on this call so far (the router's own handoff is not one). */
  transfers = 0;
  protected current?: LiveSegment;
  private incoming?: LiveSegment;
  protected run?: TransferRun;
  private attempts = 0;
  private startedCount = 0;
  protected isEnded = false;
  private readonly endedController = new AbortController();
  private readonly pending = new Set<TransferAttempt>();
  private readonly handovers = new Map<
    number,
    (target: Pick<AgentConfig, 'variables'>) => TransferHandover
  >();
  private readonly timeoutMs: number;

  constructor(readonly deps: TransferControllerDeps) {
    super(deps);
    this.clock = deps.clock ?? realHoldClock;
    this.timeoutMs = deps.prepareTimeoutMs ?? ROUTING_PREPARE_TIMEOUT_MS;
    whenLinkCloses(deps.media, () => this.end());
  }

  get ended(): boolean {
    return this.isEnded;
  }
  get endedSignal(): AbortSignal {
    return this.endedController.signal;
  }
  /** True once the current segment's engine will end into a committed handoff. */
  get handingOff(): boolean {
    return !this.isEnded && Boolean(this.run?.committed);
  }
  /** A transfer is begun, committed or connecting: a second one is `busy`. */
  get busy(): boolean {
    return Boolean(this.run || this.swapping);
  }
  /** The segment attached to the link. */
  get attached(): SegmentHistoryEntry | undefined {
    return this.current?.entry;
  }
  get segments(): number {
    return this.startedCount;
  }
  get composedSegments(): number {
    return this.attempts;
  }

  /** Makes `segment` the call's attached segment (segment 0: the router, or a degraded default). */
  attach(
    segment: StartableSegment,
    lease: SegmentMediaLease,
    info: Pick<SegmentHistoryEntry, 'role'> & Partial<SegmentHistoryEntry> = { role: 'router' },
  ): void {
    const entry: SegmentHistoryEntry = {
      ...{ agentId: segment.release.agentId, releaseId: segment.release.id },
      ...{ language: segment.release.config.language, startedAt: this.clock.now() },
      ...info,
      index: this.attempts,
    };
    this.current = { segment, lease, entry };
    this.startedCount += 1;
    if (segment.stats) segment.stats.startedAt = entry.startedAt;
    this.deps.memory.started(entry);
  }

  /**
   * What segment `index` inherits (its transfer port's `inbound`), its captured values filtered
   * by `target`'s variables schema; frozen when the segment starts.
   */
  handover(index: number, target: Pick<AgentConfig, 'variables'>): TransferHandover | undefined {
    return this.handovers.get(index)?.(target);
  }

  /** The call has ended: disposes every segment, attached, starting or composing. */
  async close(reason: EndReason): Promise<void> {
    this.end();
    const current = this.current;
    const live = [current, this.incoming].filter((item): item is LiveSegment => !!item);
    this.current = this.incoming = undefined;
    const run = this.run;
    if (run && !this.swapping) {
      this.run = undefined;
      // A committed transfer whose announcement never finished: the call ended first.
      if (run.committed && run.transfer !== undefined)
        this.deps.record('transfer.completed', endedMidTransfer(run, reason));
    }
    let failure: unknown;
    for (const item of live) {
      const failed = await disposeAttached(item, reason);
      failure ??= failed;
      if (item === current)
        this.deps.record('segment.ended', segmentEnded(item, 'call_end', reason, this.clock.now()));
    }
    await this.swapping;
    await settleWithin(
      [...this.pending].map((attempt) => attempt.drop().then(() => attempt.done)),
      this.timeoutMs,
    );
    if (failure !== undefined) throw failure;
  }

  /** ConnectHost: composes `target` on a fresh held lease as the next segment index. */
  attempt(run: TransferRun, target: AttemptTarget): TransferAttempt | undefined {
    if (this.attempts >= MAX_SEGMENT_INDEX) return undefined;
    const index = ++this.attempts;
    const lease = this.lease(false);
    this.handovers.set(index, runHandover(run, target, this.deps));
    const attempt = new SegmentAttempt(index, target, lease, {
      work: this.deps.compose(target, index, lease),
      timeoutMs: this.timeoutMs,
      signals: [this.endedSignal],
      now: () => this.clock.now(),
      dispose: (segment, reason) => segment.close(reason),
    });
    return this.track(attempt);
  }

  /** ConnectHost: a human queue's attempt as the next segment index, on a fresh held lease. */
  humanAttempt(
    run: TransferRun,
    make: (index: number, lease: SegmentMediaLease) => TransferAttempt,
  ): TransferAttempt | undefined {
    if (this.attempts >= MAX_SEGMENT_INDEX) return undefined;
    const index = ++this.attempts;
    return this.track(make(index, this.lease(false)));
  }

  private track(attempt: TransferAttempt): TransferAttempt {
    this.pending.add(attempt);
    void attempt.done.finally(() => this.pending.delete(attempt));
    return attempt;
  }

  /** ConnectHost: starts an attempt's segment and attaches it; false (and disposed) on failure. */
  async start(
    run: TransferRun,
    attempt: TransferAttempt,
    gapFrom: number,
    hold: HoldPlayer,
  ): Promise<boolean> {
    const segment = attempt.take();
    if (!segment) return false;
    const { target, lease } = attempt;
    const { index } = attempt;
    const human = target.role === 'human';
    const frozen = human
      ? undefined
      : this.handovers.get(index)?.(segment.release.config as Pick<AgentConfig, 'variables'>);
    if (frozen) this.handovers.set(index, () => frozen);
    const entry = historyEntry(run, attempt, segment, this.clock.now());
    const live: LiveSegment = { segment, lease, entry };
    this.incoming = live;
    // A human segment hears nothing from the hold: its operator never meets music (design 7.5).
    if (!human) {
      lease.beforeFirstAudio(() => hold.stop('target_audio'));
      lease.buffer();
    }
    try {
      if (this.isEnded) throw new Error('call ended');
      await segment.start();
      // A leg handed on to its destination may close the link before `start` returns: no failure.
      if (this.isEnded && !segment.handedOff) throw new Error('call ended');
    } catch (error) {
      this.incoming = undefined;
      await failStart({ deps: this.deps, live, run, error, ended: this.isEnded });
      return false;
    }
    this.incoming = undefined;
    // The operator is in the room: the hold ends now, with its carrier buffer cleared.
    if (human) await hold.stop('operator_joined');
    // Connected: the run is over before anything else can end this segment into it again.
    this.settle(run);
    this.current = live;
    this.startedCount += 1;
    if (segment.stats) segment.stats.startedAt = entry.startedAt;
    lease.open();
    this.deps.memory.started(entry);
    // A target with no member of its own frees the capacity the call held for the previous one.
    if (!entry.poolId && (run.from.poolId || run.claimed)) await this.deps.claims.release();
    if (!human)
      void this.clock
        .sleep(HOLD_AFTER_START_MS, this.endedSignal)
        .then(() => hold.stop(this.isEnded ? 'call_ended' : 'target_silent'));
    this.deps.record(
      'route.segment',
      segmentStarted(entry, target.reason, {
        ...(attempt.prepareMs !== undefined ? { prepareMs: attempt.prepareMs } : {}),
        gapMs: this.clock.now() - gapFrom,
        gapDroppedMs: lease.gapDropped.ms,
        fromIndex: run.from.index,
      }),
    );
    segment.attached?.();
    return true;
  }

  settle(run: TransferRun): void {
    if (this.run === run) this.run = undefined;
  }

  private end(): void {
    this.isEnded = true;
    this.endedController.abort();
  }

  protected get ownership() {
    return { ended: this.isEnded, attached: this.current?.lease, handingOff: this.handingOff };
  }

  protected async handOn(reason: EndReason): Promise<void> {
    const run = this.run!;
    const previous = this.current!;
    this.current = undefined;
    const gapFrom = this.clock.now();
    if ((await disposeAttached(previous, reason)) !== undefined)
      this.deps.audit('route.handoff.failed', { reason: 'router_dispose_failed' });
    this.deps.record('segment.ended', segmentEnded(previous, 'handoff', reason, gapFrom));
    await connectTransfer(this, run, gapFrom);
  }
}
