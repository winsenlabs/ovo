import type {
  ClaimedJob,
  DialResult,
  DurableJobStore,
  DurableQueue,
  QueueDelivery,
  SessionRoute,
  TelephonyControl,
  TelephonyDialRequest,
} from '@winsendotai/ovo-plugin-orchestration';
import type { CostAdmission } from './cost-runtime.ts';
import type { DeliveryVisibilityRenewal, JobLeaseRenewal } from './renewal.ts';
import type { DeliveryOutcome } from './worker-types.ts';
import type { ProtectionRenewal } from '@winsendotai/ovo-plugin-orchestration';

interface DialSettlementInput {
  job: ClaimedJob;
  workerId: string;
  delivery: QueueDelivery;
  payload: Record<string, unknown>;
  route: SessionRoute;
  request: TelephonyDialRequest;
  dial: DialResult;
  store: DurableJobStore;
  queue: DurableQueue;
  telephony: TelephonyControl;
  lease: JobLeaseRenewal;
  visibility: DeliveryVisibilityRenewal;
  protection: ProtectionRenewal;
  cost?: CostAdmission;
  deferSeconds: number;
  recordAttempt(
    payload: Record<string, unknown>,
    eventId: string,
    status: 'dialing' | 'failed' | 'unknown',
    reason?: string,
  ): Promise<unknown>;
  onCarrierAccepted(carrierCallId: string): void;
}

export async function settleDialAttempt(input: DialSettlementInput): Promise<DeliveryOutcome> {
  const { job, request, dial } = input;
  if (dial.kind === 'accepted') return accept(input, dial.carrierCallId);
  if (dial.kind === 'rejected') return reject(input, dial.reason);

  const persisted = await input.store.markDialUnknown(
    job.id,
    input.workerId,
    job.ownerEpoch,
    request.requestId,
    dial.reason,
  );
  if (!persisted) {
    input.cost?.beginActiveCall();
    await stopAndDefer(input);
    return { kind: 'deferred', reason: 'dial-ownership-lost' };
  }
  const correlated = await input.store.get(job.id);
  const reconciled = await input.telephony.reconcile(request.requestId, correlated?.carrierCallId);
  if (reconciled.kind === 'accepted') return accept(input, reconciled.carrierCallId);
  if (reconciled.kind === 'rejected') return reject(input, reconciled.reason);

  const deferred = await input.store.deferReconciliation(
    job.id,
    input.workerId,
    job.ownerEpoch,
    'carrier-outcome-still-pending',
    new Date(Date.now() + input.deferSeconds * 1_000),
  );
  await stopAndDefer(input);
  input.cost?.beginActiveCall();
  await input.recordAttempt(
    input.payload,
    `unknown:${request.requestId}`,
    'unknown',
    'carrier-outcome-still-pending',
  );
  if (!deferred) return { kind: 'deferred', reason: 'reconciliation-ownership-lost' };
  return { kind: 'reconcile_required', jobId: job.id, requestId: request.requestId };
}

async function accept(input: DialSettlementInput, carrierCallId: string): Promise<DeliveryOutcome> {
  input.onCarrierAccepted(carrierCallId);
  const accepted = await input.store.markDialAccepted(
    input.job.id,
    input.workerId,
    input.job.ownerEpoch,
    input.request.requestId,
    carrierCallId,
  );
  input.cost?.beginActiveCall();
  if (!accepted) {
    await input.store.prepareReconciledTermination(
      input.job.id,
      input.workerId,
      input.job.ownerEpoch,
      input.request.requestId,
      carrierCallId,
      'dial-acceptance-ownership-lost',
    );
    await input.telephony.hangup(carrierCallId);
    await stopAndDefer(input);
    return { kind: 'deferred', reason: 'dial-acceptance-ownership-lost' };
  }
  await input.queue.delete(input.delivery);
  input.visibility.stop();
  await input.recordAttempt(input.payload, `accepted:${carrierCallId}`, 'dialing');
  return {
    kind: 'accepted',
    jobId: input.job.id,
    carrierCallId,
    sessionId: input.route.sessionId,
    protection: input.protection,
    lease: input.lease,
  };
}

async function reject(input: DialSettlementInput, reason: string): Promise<DeliveryOutcome> {
  await input.cost?.releaseBeforeStart();
  await input.recordAttempt(input.payload, `rejected:${input.request.requestId}`, 'failed', reason);
  await input.store.markFailed(input.job.id, input.workerId, input.job.ownerEpoch, reason);
  await input.store.releaseTerminalSession(input.job.id);
  await input.queue.delete(input.delivery);
  input.lease.stop();
  input.visibility.stop();
  await input.protection.release();
  return { kind: 'failed', reason };
}

async function stopAndDefer(input: DialSettlementInput): Promise<void> {
  input.lease.stop();
  input.visibility.stop();
  await input.protection.release();
  await input.queue.changeVisibility(input.delivery, input.deferSeconds);
}
