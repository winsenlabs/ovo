import type { InboundWorkerRuntimeInput } from './inbound-runtime-input.ts';

/** The admitted inbound call a worker owns. */
export interface ActiveInboundSession {
  jobId: string;
  workerId: string;
  ownerEpoch: number;
  carrierCallId?: string;
}

/**
 * Ends an admitted inbound call: through the worker's owned-job termination when it has one, else
 * by fencing the job and hanging up the carrier leg only when the fence landed.
 */
export async function terminateInboundSession(
  input: Pick<InboundWorkerRuntimeInput, 'terminateOwned' | 'store' | 'telephony'>,
  active: ActiveInboundSession,
  reason: string,
): Promise<void> {
  if (input.terminateOwned) {
    await input.terminateOwned(active.jobId, active.ownerEpoch, reason);
    return;
  }
  const fenced = await input.store.requestSessionTermination(
    active.jobId,
    active.workerId,
    active.ownerEpoch,
    reason,
  );
  if (fenced && active.carrierCallId) await input.telephony.hangup(active.carrierCallId);
}
