import { randomUUID } from 'node:crypto';
import type {
  EndReason,
  HandoffPrepareFailure,
  HandoffPrepareResult,
  SegmentHandoffPort,
  SegmentHandoffRequest,
} from '@winsendotai/ovo-contracts';
import type { CallSegment } from './call-segment.ts';
import type { SegmentMediaLease } from './segment-media.ts';
import {
  composeWithin,
  discardUnattached,
  disposeAttached,
  SegmentLinkOwner,
  whenLinkCloses,
  ROUTING_PREPARE_TIMEOUT_MS,
  segmentStarted,
  settleWithin,
  type AgentHandoffRequest,
  type Attached,
  type CallSegmentControllerDeps,
  type Prepared,
} from './segment-prepare.ts';

export {
  ROUTING_PREPARE_TIMEOUT_MS,
  SegmentReleaseMissingError,
  type CallSegmentControllerDeps,
  type SegmentTarget,
} from './segment-prepare.ts';

/**
 * The segments of one routed call (routing design 7.4), and the seam R2's in-call transfer reuses.
 * Exactly one engine is attached to the call's media link at a time: a target is composed while
 * the router still speaks (`prepare`), and only once the router's engine has ended (its media
 * close kept the link open, because the handoff was committed) is the router graph disposed and
 * the target engine started, with the caller's words from the gap replayed into it.
 */
export class CallSegmentController extends SegmentLinkOwner implements SegmentHandoffPort {
  private current?: Attached;
  private prepared?: Prepared;
  /** A committed target between the router's end and its own start. */
  private incoming?: Attached;
  private preparing = false;
  private ended = false;
  private attempts = 0;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly endedSignal = new AbortController();
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: CallSegmentControllerDeps) {
    super(deps);
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.prepareTimeoutMs ?? ROUTING_PREPARE_TIMEOUT_MS;
    whenLinkCloses(deps.media, () => this.end());
  }

  /** True once the current segment's engine will end into a committed handoff. */
  get handingOff(): boolean {
    return !this.ended && Boolean(this.prepared?.committed);
  }

  /** Makes `segment` the call's attached segment (segment 0, or a degraded default). */
  attach(segment: CallSegment, lease: SegmentMediaLease): void {
    this.current = { segment, lease, index: this.attempts };
  }

  async prepare(
    request: SegmentHandoffRequest,
    signal: AbortSignal,
  ): Promise<HandoffPrepareResult> {
    // R1 composes agent releases only; queues and re-routes need `begin` (R2's controller).
    if (request.kind !== 'agent') return { ok: false, reason: 'unsupported' };
    const result = await this.prepareTarget(request, signal);
    // A failed prepare returns no handoff to abandon, so the member the router claimed for it is
    // released here (design 8.2); a later pool step claims again. `busy` leaves the claim to the
    // handoff already in progress.
    if (!result.ok && result.reason !== 'busy' && request.route?.claimId)
      await this.deps.releaseClaim();
    return result;
  }

  private async prepareTarget(
    request: AgentHandoffRequest,
    signal: AbortSignal,
  ): Promise<HandoffPrepareResult> {
    if (this.ended || signal.aborted) return this.refuse(request, 'call_ended');
    if (this.preparing || this.prepared?.committed || this.swapping)
      return this.refuse(request, 'busy');
    if (!this.deps.allowed.has(request.releaseId))
      return this.refuse(request, 'release_not_allowed');
    // One prepared graph at most. Its claim stays: the new request may already hold the call's.
    if (this.prepared) await discardUnattached(this.takePrepared(), 'behavior_completed');
    const index = ++this.attempts;
    const startedAt = this.now();
    const lease = this.lease(false);
    const target = {
      agentId: request.agentId,
      releaseId: request.releaseId,
      variables: request.variables,
    };
    this.preparing = true;
    const outcome = await this.bounded(this.deps.compose(target, index, lease), lease, signal);
    this.preparing = false;
    if (typeof outcome === 'string') return this.refuse(request, outcome);
    const prepareMs = this.now() - startedAt;
    const id = randomUUID();
    this.prepared = { id, request, segment: outcome, lease, index, prepareMs, committed: false };
    this.deps.audit('route.handoff.prepared', {
      handoffId: id,
      releaseId: request.releaseId,
      prepareMs,
    });
    return { ok: true, handoffId: id };
  }

  commit(handoffId: string): void {
    if (this.ended || this.prepared?.id !== handoffId)
      return this.deps.audit('route.handoff.failed', { handoffId, reason: 'commit_unknown' });
    this.prepared.committed = true;
  }

  async abandon(handoffId: string): Promise<void> {
    if (this.prepared?.id !== handoffId || this.prepared.committed) return;
    await discardUnattached(this.takePrepared(), 'behavior_completed');
    await this.deps.releaseClaim();
  }

  /** The call has ended: disposes every segment, attached, starting or prepared. */
  async close(reason: EndReason): Promise<void> {
    this.end();
    const segments = [this.current, this.incoming, this.prepared].filter(
      (item): item is Attached => item !== undefined,
    );
    this.current = this.incoming = this.prepared = undefined;
    let failure: unknown;
    for (const item of segments) {
      const failed = await disposeAttached(item, reason);
      failure ??= failed;
    }
    await this.swapping;
    // A composition still running when the call ended disposes itself; wait for it, bounded.
    await settleWithin([...this.inflight], this.timeoutMs);
    if (failure !== undefined) throw failure;
  }

  private end(): void {
    this.ended = true;
    this.endedSignal.abort();
  }

  protected get ownership() {
    return { ended: this.ended, attached: this.current?.lease, handingOff: this.handingOff };
  }

  protected async handOn(reason: EndReason): Promise<void> {
    const target = this.takePrepared();
    const previous = this.current!;
    this.current = undefined;
    this.incoming = target;
    const gapFrom = this.now();
    target.lease.buffer();
    if ((await disposeAttached(previous, reason)) !== undefined)
      this.deps.audit('route.handoff.failed', { reason: 'router_dispose_failed' });
    if ((await this.start(target, 'route', gapFrom)) || this.ended) return;
    // One attempt with the routing release's default target, then the call ends.
    const { fallback } = this.deps;
    const index = ++this.attempts;
    const lease = this.lease(false);
    lease.buffer();
    const work = this.deps.compose(
      { ...fallback, variables: target.request.variables },
      index,
      lease,
    );
    const segment = await this.bounded(work, lease, new AbortController().signal);
    if (
      typeof segment !== 'string' &&
      (await this.start({ segment, lease, index }, 'fallback', gapFrom))
    )
      return;
    if (this.ended) return;
    this.deps.audit('route.handoff.failed', {
      reason: 'fallback_failed',
      releaseId: fallback.releaseId,
    });
    await this.deps.endCall('error:route-handoff-failed');
  }

  /** Starts an incoming segment and attaches it; false (and disposed) when it cannot start. */
  private async start(item: Attached | Prepared, reason: 'route' | 'fallback', gapFrom: number) {
    this.incoming = item;
    try {
      if (this.ended) throw new Error('call ended');
      await item.segment.start();
      if (this.ended) throw new Error('call ended');
    } catch {
      this.incoming = undefined;
      if (!this.ended)
        this.deps.audit('route.handoff.failed', {
          reason: 'start_failed',
          releaseId: item.segment.release.id,
        });
      await disposeAttached(item, 'error:route-handoff-failed');
      return false;
    }
    this.incoming = undefined;
    this.current = item;
    item.lease.open();
    this.deps.record('route.segment', segmentStarted(item, reason, this.now() - gapFrom));
    return true;
  }

  /** Waits for a composition within the bound, for as long as the call lasts. */
  private async bounded(
    work: Promise<CallSegment>,
    lease: SegmentMediaLease,
    signal: AbortSignal,
  ): Promise<CallSegment | HandoffPrepareFailure> {
    const signals = [signal, this.endedSignal.signal];
    const { outcome, composed } = composeWithin(work, this.timeoutMs, signals);
    const taken = await outcome;
    const late = composed.then(async (segment) => {
      if (typeof segment === 'string') return lease.release();
      if (segment !== taken || this.ended)
        await discardUnattached({ segment, lease }, 'error:route-handoff-failed');
    });
    this.inflight.add(late);
    // swallow-ok: a late composition's disposal failure has no call left to fail.
    void late.finally(() => this.inflight.delete(late)).catch(() => undefined);
    return typeof taken !== 'string' && this.ended ? 'call_ended' : taken;
  }

  private refuse(
    request: AgentHandoffRequest,
    reason: HandoffPrepareFailure,
  ): HandoffPrepareResult {
    this.deps.audit('route.handoff.failed', { reason, releaseId: request.releaseId });
    return { ok: false, reason };
  }

  private takePrepared(): Prepared {
    const prepared = this.prepared!;
    this.prepared = undefined;
    return prepared;
  }
}
