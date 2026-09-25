import {
  ProtectionRenewal,
  type DurableJobStore,
  type DurableQueue,
  type QueueDelivery,
  type TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import { DeliveryVisibilityRenewal, JobLeaseRenewal } from './renewal.ts';
import type { DeliveryOutcome } from './worker-types.ts';
import type { WorkerCarrierRuntime } from './carrier-runtime.ts';
import type { WorkerMediaRuntime } from './media-runtime.ts';
import { terminateOwnedJob } from './worker-termination.ts';

export async function terminateActiveSession(input: {
  active: Extract<DeliveryOutcome, { kind: 'accepted' }>;
  reason: string;
  workerId: string;
  store: DurableJobStore;
  telephony: TelephonyControl;
  carriers?: WorkerCarrierRuntime;
  media?: Pick<WorkerMediaRuntime, 'terminate' | 'closeSession'>;
}): Promise<boolean> {
  if (input.carriers && input.media)
    return terminateOwnedJob({
      jobId: input.active.jobId,
      workerId: input.workerId,
      ownerEpoch: input.active.lease.ownerEpoch,
      reason: input.reason,
      store: input.store,
      carriers: input.carriers,
      media: input.media,
    });
  const terminating = await input.store.requestSessionTermination(
    input.active.jobId,
    input.workerId,
    input.active.lease.ownerEpoch,
    input.reason,
  );
  if (!terminating) return false;
  const carrierCallId = terminating.carrierCallId ?? input.active.carrierCallId;
  if (carrierCallId) await input.telephony.hangup(carrierCallId).catch(() => undefined);
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
