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

/** One route fence before carrier control and local media teardown. */
export async function terminateOwnedJob(input: OwnedTermination): Promise<boolean> {
  const job = await input.store.get(input.jobId);
  const route = await input.store.getSessionRoute(input.jobId);
  if (!job || !route) return false;
  const reason: EndReason = asEndReason(input.reason);
  const fenced = await input.store.requestSessionTermination(
    input.jobId,
    input.workerId,
    input.ownerEpoch,
    reason,
  );
  if (!fenced) return false;
  let selected;
  try {
    selected = await input.carriers.forJob(job, false);
  } catch (error) {
    await input.media.terminate(route.sessionId).catch(() => undefined);
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
    media: { terminate: (sessionId) => input.media.terminate(sessionId) },
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
