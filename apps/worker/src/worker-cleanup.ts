import {
  ProtectionRenewal,
  type DurableJobStore,
  type DurableQueue,
  type QueueDelivery,
  type TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import { DeliveryVisibilityRenewal, JobLeaseRenewal } from './renewal.ts';
import type { DeliveryOutcome } from './worker-types.ts';

export async function terminateActiveSession(input: {
  active: Extract<DeliveryOutcome, { kind: 'accepted' }>;
  reason: string;
  workerId: string;
  store: DurableJobStore;
  telephony: TelephonyControl;
}): Promise<boolean> {
  const terminating = await input.store.requestSessionTermination(
    input.active.jobId,
    input.workerId,
    input.active.lease.ownerEpoch,
    input.reason,
  );
  if (!terminating) return false;
  await input.telephony
    .hangup(terminating.carrierCallId ?? input.active.carrierCallId)
    .catch(() => undefined);
  return true;
}

export async function failBeforeDial(input: {
  job: { id: string; ownerEpoch: number };
  workerId: string;
  store: DurableJobStore;
  queue: DurableQueue;
  delivery: QueueDelivery;
  lease: JobLeaseRenewal;
  visibility: DeliveryVisibilityRenewal;
  renewal: ProtectionRenewal;
  reason: string;
}): Promise<DeliveryOutcome> {
  await input.store.markFailed(input.job.id, input.workerId, input.job.ownerEpoch, input.reason);
  await input.queue.delete(input.delivery);
  input.lease.stop();
  input.visibility.stop();
  await input.renewal.release();
  return { kind: 'failed', reason: input.reason };
}
