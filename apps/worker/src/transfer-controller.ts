import type {
  HandoffBeginResult,
  HandoffPrepareFailure,
  HandoffPrepareResult,
  SegmentHandoffPort,
  SegmentHandoffRequest,
} from '@winsendotai/ovo-contracts';
import { beginRun, type BeginOptions } from './transfer-begin.ts';
import { TransferSegments } from './transfer-segments.ts';
import type { TransferRun } from './transfer-types.ts';

/**
 * The handoff seam of a routed call with in-call transfers on (transfer design 4.3, 7): `begin`,
 * which validates, claims and composes a target in the background while the requester announces,
 * `commit`, `abandon`, and R1's blocking `prepare` for kind `agent`. The router's start-of-call
 * handoff, an agent's `transfer_to_agent` (through its transfer port), a flow node and a re-route
 * all come through here; the segments and the swap are `TransferSegments`'.
 */
export class TransferController extends TransferSegments implements SegmentHandoffPort {
  begin(request: SegmentHandoffRequest, signal: AbortSignal): Promise<HandoffBeginResult> {
    return this.beginWith(request, signal, {});
  }

  /** `begin` with what an agent's transfer port knows: the catalogue target and the LLM's words. */
  async beginWith(
    request: SegmentHandoffRequest,
    signal: AbortSignal,
    options: BeginOptions,
  ): Promise<HandoffBeginResult> {
    const from = this.current?.entry;
    if (this.isEnded || signal.aborted || !from) return this.refuse(request, 'call_ended');
    if (this.busy) return this.refuse(request, 'busy');
    const begun = await beginRun(this, request, from, options);
    if (!begun.ok) return this.refuse(request, begun.reason);
    this.run = begun.run;
    return { ok: true, handoffId: begun.run.id, state: begun.state };
  }

  /** R1's blocking prepare, for kind `agent`: begin, then wait for the composition. */
  async prepare(
    request: SegmentHandoffRequest,
    signal: AbortSignal,
  ): Promise<HandoffPrepareResult> {
    if (request.kind !== 'agent') return { ok: false, reason: 'unsupported' };
    // One prepared graph at most (R1): an uncommitted one is replaced, its claim kept.
    if (this.run && !this.run.committed && !this.swapping) await this.discard(this.run);
    const begun = await this.begin(request, signal);
    if (!begun.ok) return { ok: false, reason: begun.reason as HandoffPrepareFailure };
    const run = this.run!;
    const outcome = run.attempt ? await run.attempt.result : 'unsupported';
    if (typeof outcome !== 'string' && this.run === run) {
      this.deps.audit('route.handoff.prepared', {
        ...{ handoffId: run.id, releaseId: outcome.release.id },
        prepareMs: run.attempt!.prepareMs,
      });
      return { ok: true, handoffId: run.id };
    }
    if (this.run === run) await this.discard(run);
    const reason = (typeof outcome === 'string' ? outcome : 'call_ended') as HandoffPrepareFailure;
    if (request.route?.claimId) await this.deps.claims.release();
    this.deps.audit('route.handoff.failed', { reason, releaseId: request.releaseId });
    return { ok: false, reason };
  }

  commit(handoffId: string): void {
    if (this.isEnded || this.run?.id !== handoffId)
      return this.deps.audit('route.handoff.failed', { handoffId, reason: 'commit_unknown' });
    this.run.committed = true;
  }

  /** The begun, uncommitted run `handoffId` names (what a transfer port may still cancel). */
  uncommitted(handoffId: string): TransferRun | undefined {
    return this.run?.id === handoffId && !this.run.committed ? this.run : undefined;
  }

  async abandon(handoffId: string): Promise<void> {
    const run = this.run;
    if (run?.id !== handoffId || run.committed) return;
    await this.discard(run);
    await this.deps.claims.release();
  }

  private refuse(
    request: SegmentHandoffRequest,
    reason: Exclude<HandoffBeginResult, { ok: true }>['reason'],
  ): Promise<HandoffBeginResult> | HandoffBeginResult {
    this.deps.audit('route.handoff.failed', {
      reason,
      ...(request.kind === 'agent' ? { releaseId: request.releaseId } : { kind: request.kind }),
    });
    // A refused handoff has nothing to abandon: the member claimed for it is released (R1 8.2).
    if (reason === 'busy' || request.kind === 'node' || !request.route?.claimId)
      return { ok: false, reason };
    return this.deps.claims.release().then(() => ({ ok: false, reason }));
  }

  /** Drops an uncommitted run and its composition; claims are the caller's business. */
  private async discard(run: TransferRun): Promise<void> {
    this.settle(run);
    await run.attempt?.drop();
  }
}
