import type { HandoffTarget } from '@winsendotai/ovo-contracts';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { CarrierJob, WorkerCarrierRuntime } from './carrier-runtime.ts';
import type { CarrierHandoffResult, DynamicHandoffTarget } from './human-runtime.ts';

/**
 * Where a session that ends `transferred` goes, by session id (human queue design 7.8): the
 * target a human queue's destination named, or `handedOff` once the worker already moved the
 * carrier leg and only the session is left to end. A session with no entry falls back to the
 * agent release's static transfer target (AGT-15), exactly as before R3.
 */
export type TransferTargets = Map<string, HandoffTarget | { handedOff: true }>;

type HandoffInput = {
  carriers: Pick<WorkerCarrierRuntime, 'forJob'>;
  store: { getSessionRoute(jobId: string): Promise<SessionRoute | undefined> };
};

/** The handoff the worker asks of the carrier, with the request id `human:<ticket>` (idempotent). */
export type CarrierHandoff = (
  job: DurableJob,
  route: SessionRoute,
  target: DynamicHandoffTarget,
  ticketId: string,
) => Promise<CarrierHandoffResult>;

/** A code a carrier's refusal is recorded with: a short token, never carrier text. */
function code(reason: string): string {
  return (
    reason
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 40) || 'rejected'
  );
}

/**
 * Moves the live carrier leg to `target` before the session ends (design 7.8). The job's own
 * carrier is asked only for a kind its capabilities list; `confirmed` and `unknown` (a carrier
 * that may have moved the call) are both handed on, never retried; `rejected` keeps the caller on
 * the line for the hold's chain. Nothing here hangs up or fences the route.
 */
export function carrierHandoffFor(input: HandoffInput): CarrierHandoff {
  return async (job, route, target, ticketId) => {
    let selected;
    try {
      selected = await input.carriers.forJob(job as CarrierJob, false);
    } catch {
      // swallow-ok: a carrier that cannot be selected cannot take a handoff; the chain moves on.
      return { kind: 'rejected', reason: 'carrier_unavailable' };
    }
    const kinds: readonly string[] = selected.carrier.capabilities.control.handoff;
    if (!kinds.includes(target.kind)) return { kind: 'rejected', reason: 'unsupported_kind' };
    const current = await input.store.getSessionRoute(route.jobId).catch(() => undefined);
    const carrierCallId = current?.carrierCallId ?? route.carrierCallId;
    if (!carrierCallId) return { kind: 'rejected', reason: 'no_carrier_call' };
    try {
      const result = await selected.control.handoff(
        carrierCallId,
        target as HandoffTarget,
        `human:${ticketId}`,
      );
      return result.kind === 'rejected'
        ? { kind: 'rejected', reason: code(result.reason) }
        : { kind: result.kind };
    } catch {
      // swallow-ok: a control call that throws may have moved the call; it is not retried.
      return { kind: 'unknown' };
    }
  };
}
