import type {
  EndReason,
  HandoffPrepareFailure,
  SegmentHandoffRequest,
  VoiceMediaTransport,
} from '@winsendotai/ovo-contracts';
import type { CallSegment } from './call-segment.ts';
import { SegmentMediaLease } from './segment-media.ts';

/** The default bound on composing a target graph before the router's connecting line. */
export const ROUTING_PREPARE_TIMEOUT_MS = 2_500;

/** A segment's release is not installed for the call's workspace. */
export class SegmentReleaseMissingError extends Error {
  constructor(releaseId: string) {
    super(`segment release not found: ${releaseId}`);
    this.name = 'SegmentReleaseMissingError';
  }
}

type Composed = CallSegment | HandoffPrepareFailure;

/**
 * A composition raced against its bound and the call: `outcome` is what the caller waits for,
 * `composed` what the composition itself came to, which is disposed if nobody took it.
 */
export function composeWithin(
  work: Promise<CallSegment>,
  timeoutMs: number,
  signals: readonly AbortSignal[],
): { outcome: Promise<Composed>; composed: Promise<Composed> } {
  const composed = work.then(
    (segment): Composed => segment,
    (error: unknown): Composed =>
      error instanceof SegmentReleaseMissingError ? 'release_missing' : 'compose_failed',
  );
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<Composed>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    const ended = () => resolve('call_ended');
    for (const signal of signals) {
      if (signal.aborted) ended();
      signal.addEventListener('abort', ended, { once: true });
    }
  });
  const outcome = Promise.race([composed, stopped]).finally(() => clearTimeout(timer));
  return { outcome, composed };
}

/** A lease of the call's media whose engine closing asks `intercept` first (a handoff keeps the link). */
export function interceptedLease(
  call: { media: VoiceMediaTransport; format: { sampleRate: number; encoding: string } },
  live: boolean,
  intercept: (lease: SegmentMediaLease, reason: string) => boolean,
): SegmentMediaLease {
  const lease: SegmentMediaLease = new SegmentMediaLease(call.media, {
    format: call.format,
    live,
    interceptClose: (reason) => intercept(lease, reason),
  });
  return lease;
}

/** Calls `end` once, when the call's link closes (the caller or the carrier ended the call). */
export function whenLinkCloses(media: VoiceMediaTransport, end: () => void): void {
  const stop = media.onClose(() => {
    stop();
    end();
  });
}

/** Disposes a segment, then drops its lease; resolves the first failure. */
export async function disposeAttached(
  item: { segment: Pick<CallSegment, 'close'>; lease: SegmentMediaLease },
  reason: EndReason,
): Promise<unknown> {
  try {
    return await item.segment.close(reason);
  } finally {
    item.lease.release();
  }
}

/**
 * Disposes a segment that never held the call's link (composed, then dropped, superseded or
 * arriving late): its lease goes first, so its engine closing its media reaches nothing.
 */
export async function discardUnattached(
  item: { segment: CallSegment; lease: SegmentMediaLease },
  reason: EndReason,
): Promise<unknown> {
  item.lease.release();
  return item.segment.close(reason);
}

/** What decides whether a segment's engine closing its media may end the call. */
export interface LinkOwnership {
  ended: boolean;
  /** The lease of the segment attached to the link, if any (none between two segments). */
  attached?: SegmentMediaLease;
  handingOff: boolean;
}

/**
 * True when `lease`'s engine closing may end the call, its hang-up and the link's close: only the
 * attached segment's, and not while it hands on (transfer design 7.1). A graph never attached
 * (composing, dropped, superseded, failing to start) never ends the live call; once the call has
 * ended, closing again is harmless.
 */
export function linkMayEnd(owner: LinkOwnership, lease: SegmentMediaLease): boolean {
  return owner.ended || (lease === owner.attached && !owner.handingOff);
}

/**
 * What a routed call's segment controller shares (transfer design 7.1): the leases of the call's
 * media for its segments, and who may end the call through them. The attached segment's engine
 * ending into a committed handoff starts `handOn` and keeps the link; any other segment's engine
 * closing keeps it untouched; once the call has ended, any close goes through.
 */
export abstract class SegmentLinkOwner {
  protected swapping?: Promise<void>;

  constructor(
    private readonly link: {
      media: VoiceMediaTransport;
      format: { sampleRate: number; encoding: string };
      audit(type: string, payload: Record<string, unknown>): void;
    },
  ) {}

  /** Whether the call has ended, which lease is attached, and whether it is handing off. */
  protected abstract get ownership(): LinkOwnership;
  /** The attached segment's engine ended into a committed handoff: swap to the next one. */
  protected abstract handOn(reason: EndReason): Promise<void>;

  /**
   * True when the engine on `lease` may end the call (its hang-up, then the link): only the
   * attached segment's, never a composing, prepared, dropped or starting one's, and not while it
   * hands on.
   */
  mayEndCall(lease: SegmentMediaLease): boolean {
    return linkMayEnd(this.ownership, lease);
  }

  /** A lease of the call's media for a segment; `live: false` for one not yet started. */
  lease(live: boolean): SegmentMediaLease {
    return interceptedLease(this.link, live, (lease, reason) => {
      const owner = this.ownership;
      if (linkMayEnd(owner, lease)) return false;
      if (lease === owner.attached)
        this.swapping = this.handOn(reason as EndReason)
          // swallow-ok: logged by code only; the call ends through its media link either way.
          .catch(() => this.link.audit('route.handoff.failed', { reason: 'swap_failed' }))
          .finally(() => (this.swapping = undefined));
      return true;
    });
  }
}

/** Waits for `work` to settle, at most `ms`. */
export async function settleWithin(work: readonly Promise<unknown>[], ms: number): Promise<void> {
  if (!work.length) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(work),
    new Promise((resolve) => (timer = setTimeout(resolve, ms))),
  ]);
  clearTimeout(timer);
}

export interface SegmentTarget {
  agentId: string;
  releaseId: string;
  variables: Readonly<Record<string, string>>;
}

export interface CallSegmentControllerDeps {
  media: VoiceMediaTransport;
  format: { sampleRate: number; encoding: string };
  /** The routing snapshot's releaseIds: the only releases a call may hand off to. */
  allowed: ReadonlySet<string>;
  /** The routing release's default target: one attempt when a target fails to start. */
  fallback: { agentId: string; releaseId: string };
  /** Loads the release, starts its early work under `<job id>:s<index>`, composes it on `lease`. */
  compose(target: SegmentTarget, index: number, lease: SegmentMediaLease): Promise<CallSegment>;
  /** `route.segment` (and the route path's other worker events), on the call's outcome log. */
  record(type: 'route.segment', payload: Record<string, unknown>): void;
  audit(type: string, payload: Record<string, unknown>): void;
  /** Releases the call's member claim. */
  releaseClaim(): Promise<void>;
  /** Ends the call when no engine is left to end it: the hang-up, then the link. */
  endCall(reason: EndReason): Promise<void>;
  prepareTimeoutMs?: number;
  now?: () => number;
}

export interface Attached {
  segment: CallSegment;
  lease: SegmentMediaLease;
  index: number;
}

/** The one kind of handoff R1's blocking prepare composes: an agent release. */
export type AgentHandoffRequest = Extract<SegmentHandoffRequest, { kind: 'agent' }>;

export interface Prepared extends Attached {
  id: string;
  request: AgentHandoffRequest;
  prepareMs: number;
  committed: boolean;
}

/** The `route.segment` event of a segment that has just started (routing design 4.9). */
export function segmentStarted(
  item: Attached | Prepared,
  reason: 'route' | 'fallback',
  gapMs: number,
): Record<string, unknown> {
  const route = 'request' in item ? item.request.route : undefined;
  return {
    index: item.index,
    role: 'agent',
    agentId: item.segment.release.agentId,
    releaseId: item.segment.release.id,
    reason,
    ...(route?.poolId ? { poolId: route.poolId } : {}),
    ...(route?.memberId ? { memberId: route.memberId } : {}),
    ...('prepareMs' in item ? { prepareMs: item.prepareMs } : {}),
    gapMs,
    gapDroppedMs: item.lease.gapDropped.ms,
  };
}
