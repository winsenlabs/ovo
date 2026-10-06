import type { Logger } from '@winsendotai/ovo-contracts';
import { errorFields } from '@winsendotai/ovo-plugin-kit';
import type { DurableJobStore, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { DeliveryOutcome } from './worker-types.ts';

/**
 * Settles an outbound job whose session route went terminal: stops its lease and protection,
 * closes media, finalizes cost, finishes the control-plane call and releases the route.
 * Returns false, a second later, when finishCall failed: the caller then retries the settlement.
 */
export async function settleTerminalSession(input: {
  active: Extract<DeliveryOutcome, { kind: 'accepted' }>;
  route: SessionRoute;
  store: Pick<DurableJobStore, 'get' | 'releaseTerminalSession'>;
  media: { closeSession(sessionId: string, reason: string): Promise<void> };
  costs: { finalize(jobId: string): Promise<void> };
  controlStore: { finishCall(workspaceId: string, id: string, status: string): Promise<unknown> };
  log: Logger;
}): Promise<boolean> {
  const { active, route, store, log } = input;
  active.lease.stop();
  await active.protection.release();
  await input.media.closeSession(route.sessionId, `carrier terminal: ${route.status}`);
  await input.costs.finalize(active.jobId);
  const job = await store.get(active.jobId);
  if (job) {
    const callId =
      typeof job.payload.callId === 'string' && job.payload.callId ? job.payload.callId : job.id;
    try {
      await input.controlStore.finishCall(job.workspaceId, callId, route.status);
    } catch (error) {
      // Retried every second until it lands; without this line the loop spins silently.
      log.warn('call_finish_failed', {
        jobId: job.id,
        callId,
        sessionId: route.sessionId,
        status: route.status,
        ...errorFields(error),
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return false;
    }
  }
  await store.releaseTerminalSession(active.jobId);
  log.info('session_released', { jobId: active.jobId, status: route.status });
  return true;
}
