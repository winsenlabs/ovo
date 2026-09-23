import type { DialRequest, DialResult as CarrierDialResult } from '@winsendotai/ovo-contracts';
import type {
  ClaimedJob,
  DurableQueue,
  PostgresOrchestrationStore,
  QueueDelivery,
  SessionRoute,
  ProtectionRenewal,
} from '@winsendotai/ovo-plugin-orchestration';
import type { CostAdmission } from './cost-runtime.ts';
import type { DeliveryVisibilityRenewal, JobLeaseRenewal } from './renewal.ts';
import type { DeliveryOutcome } from './worker-types.ts';
import type { SelectedJobCarrier } from './carrier-runtime.ts';

interface CarrierDialSettlementInput {
  job: ClaimedJob;
  workerId: string;
  delivery: QueueDelivery;
  payload: Record<string, unknown>;
  route: SessionRoute;
  queue: DurableQueue;
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
  request: DialRequest;
  dial: CarrierDialResult;
  store: PostgresOrchestrationStore;
  selected: SelectedJobCarrier;
  onCarrierAccepted(carrierCallId?: string): void;
}

/** V2 acceptance keeps request-only ids and treats terminal reconciliation as failure. */
export async function settleCarrierDial(
  input: CarrierDialSettlementInput,
): Promise<DeliveryOutcome> {
  const { job, request, dial, selected } = input;
  const accept = async (
    carrierCallId?: string,
    carrierRequestId?: string,
  ): Promise<DeliveryOutcome> => {
    if (!carrierCallId && !carrierRequestId)
      throw new Error('Carrier accepted without a correlation id');
    input.onCarrierAccepted(carrierCallId);
    const accepted = await input.store.markDialAccepted({
      jobId: job.id,
      workerId: input.workerId,
      ownerEpoch: job.ownerEpoch,
      dialRequestId: request.requestId,
      carrierCallId,
      carrierRequestId,
    });
    input.cost?.beginActiveCall();
    if (!accepted) {
      await selected.control.hangup({ carrierCallId, carrierRequestId }).catch(() => 'unsupported');
      await carrierStopAndDefer(input);
      return { kind: 'deferred', reason: 'dial-acceptance-ownership-lost' };
    }
    await input.queue.delete(input.delivery);
    input.visibility.stop();
    await input.recordAttempt(
      input.payload,
      `accepted:${carrierCallId ?? carrierRequestId}`,
      'dialing',
    );
    return {
      kind: 'accepted',
      jobId: job.id,
      carrierCallId,
      carrierRequestId,
      sessionId: input.route.sessionId,
      protection: input.protection,
      lease: input.lease,
    };
  };
  const fail = async (reason: string): Promise<DeliveryOutcome> => {
    await input.cost?.releaseBeforeStart();
    await input.recordAttempt(input.payload, `rejected:${request.requestId}`, 'failed', reason);
    await input.store.markFailed(job.id, input.workerId, job.ownerEpoch, reason);
    await input.store.releaseTerminalSession(job.id);
    await input.queue.delete(input.delivery);
    input.lease.stop();
    input.visibility.stop();
    await input.protection.release();
    return { kind: 'failed', reason };
  };
  if (dial.kind === 'accepted') return accept(dial.carrierCallId, dial.carrierRequestId);
  if (dial.kind === 'rejected') return fail(dial.reason);
  const persisted = await input.store.markDialUnknown(
    job.id,
    input.workerId,
    job.ownerEpoch,
    request.requestId,
    dial.reason,
  );
  if (!persisted) {
    input.cost?.beginActiveCall();
    await carrierStopAndDefer(input);
    return { kind: 'deferred', reason: 'dial-ownership-lost' };
  }
  const correlated = await input.store.get(job.id);
  const correlatedRoute = await input.store.getSessionRoute(job.id);
  const reconciled = await selected.control.reconcile({
    requestId: request.requestId,
    carrierCallId: correlated?.carrierCallId,
    carrierRequestId: correlatedRoute?.carrierRequestId,
  });
  if (reconciled.kind === 'live') {
    if (reconciled.carrierCallId || correlatedRoute?.carrierRequestId)
      return accept(reconciled.carrierCallId, correlatedRoute?.carrierRequestId);
  }
  if (reconciled.kind === 'rejected') return fail(reconciled.reason);
  if (reconciled.kind === 'ended') {
    if (reconciled.answeredBy === 'machine') return fail('voicemail');
    if (
      reconciled.state === 'busy' ||
      reconciled.state === 'no_answer' ||
      reconciled.state === 'failed' ||
      reconciled.state === 'canceled'
    )
      return fail(reconciled.state);
    const route = await input.store.getSessionRoute(job.id);
    if (reconciled.state === 'completed' && !route?.handshakeClaimedAt)
      return fail('completed_without_session');
  }
  const deferred = await input.store.deferReconciliation(
    job.id,
    input.workerId,
    job.ownerEpoch,
    'carrier-outcome-still-pending',
    new Date(Date.now() + input.deferSeconds * 1_000),
  );
  await carrierStopAndDefer(input);
  input.cost?.beginActiveCall();
  await input.recordAttempt(
    input.payload,
    `unknown:${request.requestId}`,
    'unknown',
    'carrier-outcome-still-pending',
  );
  return deferred
    ? { kind: 'reconcile_required', jobId: job.id, requestId: request.requestId }
    : { kind: 'deferred', reason: 'reconciliation-ownership-lost' };
}

async function carrierStopAndDefer(input: CarrierDialSettlementInput): Promise<void> {
  input.lease.stop();
  input.visibility.stop();
  await input.protection.release();
  await input.queue.changeVisibility(input.delivery, input.deferSeconds);
}
