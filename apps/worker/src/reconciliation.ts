import type {
  ClaimedJob,
  DurableJobStore,
  DurableQueue,
  QueueDelivery,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';

export type ReconciliationOutcome =
  | { kind: 'reconciled'; jobId: string; carrierCallId: string }
  | { kind: 'reconcile_required'; jobId: string; requestId: string }
  | { kind: 'deferred'; reason: string }
  | { kind: 'failed'; reason: string };

export async function reconcileClaimedDial(input: {
  workerId: string;
  job: ClaimedJob;
  delivery: QueueDelivery;
  store: DurableJobStore;
  queue: DurableQueue;
  telephony: TelephonyControl;
  deferSeconds: number;
}): Promise<ReconciliationOutcome> {
  const requestId = input.job.dialRequestId;
  if (!requestId) {
    const reason = 'reconciliation claim has no persisted dial request ID';
    const fenced = await input.store.markFailed(
      input.job.id,
      input.workerId,
      input.job.ownerEpoch,
      reason,
    );
    if (!fenced) return deferLostOwnership(input);
    await input.queue.delete(input.delivery);
    return { kind: 'failed', reason };
  }

  const outcome = await input.telephony.reconcile(requestId, input.job.carrierCallId);
  if (outcome.kind === 'accepted') {
    const fenced = await input.store.markDialAccepted(
      input.job.id,
      input.workerId,
      input.job.ownerEpoch,
      requestId,
      outcome.carrierCallId,
    );
    if (!fenced) return deferLostOwnership(input);
    await input.queue.delete(input.delivery);
    return { kind: 'reconciled', jobId: input.job.id, carrierCallId: outcome.carrierCallId };
  }
  if (outcome.kind === 'rejected') {
    const fenced = await input.store.markFailed(
      input.job.id,
      input.workerId,
      input.job.ownerEpoch,
      outcome.reason,
    );
    if (!fenced) return deferLostOwnership(input);
    await input.queue.delete(input.delivery);
    return { kind: 'failed', reason: outcome.reason };
  }

  const notBefore = new Date(Date.now() + input.deferSeconds * 1_000);
  const deferred = await input.store.deferReconciliation(
    input.job.id,
    input.workerId,
    input.job.ownerEpoch,
    'carrier-outcome-still-pending',
    notBefore,
  );
  await input.queue.changeVisibility(input.delivery, input.deferSeconds);
  if (!deferred) return { kind: 'deferred', reason: 'reconciliation-ownership-lost' };
  return { kind: 'reconcile_required', jobId: input.job.id, requestId };
}

async function deferLostOwnership(input: {
  queue: DurableQueue;
  delivery: QueueDelivery;
  deferSeconds: number;
}): Promise<ReconciliationOutcome> {
  await input.queue.changeVisibility(input.delivery, input.deferSeconds);
  return { kind: 'deferred', reason: 'reconciliation-ownership-lost' };
}
