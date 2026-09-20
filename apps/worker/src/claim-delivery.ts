import type {
  ClaimedJob,
  DurableJobStore,
  DurableQueue,
  QueueDelivery,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import { reconcileClaimedDial } from './reconciliation.ts';
import type { DeliveryOutcome } from './worker-types.ts';

export async function claimWorkerDelivery(input: {
  workerId: string;
  delivery: QueueDelivery;
  store: DurableJobStore;
  queue: DurableQueue;
  telephony: TelephonyControl;
  leaseMs: number;
  deferSeconds: number;
}): Promise<{ kind: 'owned'; job: ClaimedJob } | { kind: 'outcome'; outcome: DeliveryOutcome }> {
  const claim = await input.store.claim(
    input.delivery.reference.jobId,
    input.workerId,
    input.leaseMs,
  );
  if (claim.kind === 'defer') {
    const delay = claim.retryAt
      ? Math.max(1, Math.min(43_200, Math.ceil((claim.retryAt.getTime() - Date.now()) / 1_000)))
      : input.deferSeconds;
    await input.queue.changeVisibility(input.delivery, delay);
    return { kind: 'outcome', outcome: { kind: 'deferred', reason: claim.reason } };
  }
  if (claim.kind === 'missing' || claim.kind === 'settled') {
    await input.queue.delete(input.delivery);
    return { kind: 'outcome', outcome: { kind: 'duplicate' } };
  }
  if (claim.kind === 'reconcile') {
    const outcome = await reconcileClaimedDial({
      ...input,
      job: claim.job,
    });
    return { kind: 'outcome', outcome };
  }
  return { kind: 'owned', job: claim.job };
}
