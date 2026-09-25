import { outcomeFor, type EndReason } from '@winsendotai/ovo-contracts';
import { asEndReason } from '@winsendotai/ovo-plugin-kit';
import type { DurableJobStore } from '@winsendotai/ovo-plugin-orchestration';
import { terminateCarrierLeg } from '@winsendotai/ovo-session-host';
import type { WorkerCarrierRuntime } from './carrier-runtime.ts';
import type { WorkerMediaRuntime } from './media-runtime.ts';

export interface OwnedTermination {
  jobId: string;
  workerId: string;
  ownerEpoch: number;
  reason: string;
  store: DurableJobStore;
  carriers: WorkerCarrierRuntime;
  media: Pick<WorkerMediaRuntime, 'terminate' | 'closeSession'>;
}

/** Forced exits can bypass onSessionClose, so settle their cost attachment here. */
export async function terminateOwnedJobAndFinalize(
  input: OwnedTermination & { finalizeCost(jobId: string): Promise<void> },
): Promise<boolean> {
  try {
    return await terminateOwnedJob(input);
  } finally {
    await input.finalizeCost(input.jobId);
  }
}

/** One route fence before carrier control and local media teardown. */
export async function terminateOwnedJob(input: OwnedTermination): Promise<boolean> {
  const job = await input.store.get(input.jobId);
  const route = await input.store.getSessionRoute(input.jobId);
  if (!job || !route) return false;
  const reason: EndReason = asEndReason(input.reason);
  const fenced = await input.store.requestSessionTermination(
    input.jobId, input.workerId, input.ownerEpoch, reason,
  );
  if (!fenced) throw new Error(`Session ${route.sessionId} termination fence failed`);
  let selected;
  try {
    selected = await input.carriers.forJob(job, false);
  } catch (error) {
    await input.media.terminate(route.sessionId, reason).catch(() => undefined);
    await input.media.closeSession(route.sessionId, reason).catch(() => undefined);
    throw error;
  }
  await terminateCarrierLeg({
    route: {
      sessionId: route.sessionId,
      jobId: input.jobId,
      workerId: input.workerId,
      ownerEpoch: input.ownerEpoch,
      carrierCallId: route.carrierCallId,
      carrierRequestId: route.carrierRequestId,
    },
    store: {
      requestSessionTermination: async () => fenced,
    },
    control: selected.control,
    capabilities: selected.carrier.capabilities,
    media: {
      terminate: (sessionId, terminatedReason) =>
        input.media.terminate(sessionId, terminatedReason),
    },
    engine: {
      dispose: async () => {
        await input.media.closeSession(route.sessionId, reason);
        return { reason, outcome: outcomeFor(reason) };
      },
    },
    reason,
  });
  return true;
}
