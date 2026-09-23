import type { DialRequest } from '@winsendotai/ovo-contracts';
import type {
  ClaimedJob,
  DurableJobStore,
  DurableQueue,
  PostgresOrchestrationStore,
  QueueDelivery,
  TelephonyControl,
  TelephonyDialRequest,
  ProtectionRenewal,
} from '@winsendotai/ovo-plugin-orchestration';
import type { DeliveryVisibilityRenewal, JobLeaseRenewal } from './renewal.ts';
import type { DeliveryOutcome } from './worker-types.ts';
import type { WorkerRunnerOptions } from './worker-options.ts';
import type { SelectedJobCarrier } from './carrier-runtime.ts';
import { dialRequestFromJob, dialRequestV2 } from './dial-request.ts';
import { createSessionHandshake } from './session-handshake.ts';
import { failBeforeDial } from './worker-cleanup.ts';
import { settleDialAttempt } from './dial-settlement.ts';
import { settleCarrierDial } from './carrier-dial-settlement.ts';

export async function dialOwnedJob(input: {
  job: ClaimedJob;
  dialPayload: Record<string, unknown>;
  delivery: QueueDelivery;
  lease: JobLeaseRenewal;
  visibility: DeliveryVisibilityRenewal;
  renewal: ProtectionRenewal;
  workerId: string;
  store: DurableJobStore;
  queue: DurableQueue;
  telephony: TelephonyControl;
  options: WorkerRunnerOptions;
  recordAttempt(
    payload: Record<string, unknown>,
    eventId: string,
    status: 'dialing' | 'failed' | 'unknown',
    reason?: string,
  ): Promise<unknown>;
  onCarrierAccepted(carrierCallId?: string): void;
}): Promise<DeliveryOutcome> {
  const { job, dialPayload, delivery, lease, visibility, renewal } = input;
  let selected: SelectedJobCarrier | undefined;
  if (input.options.carriers) {
    try {
      selected = await input.options.carriers.forJob({ ...job, payload: dialPayload });
    } catch (error) {
      return failBeforeDial({
        job,
        workerId: input.workerId,
        store: input.store,
        queue: input.queue,
        delivery,
        lease,
        visibility,
        renewal,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const ringTimeoutSec = selected
    ? Number((dialPayload as Record<string, unknown>).ringTimeoutSec ?? 60)
    : undefined;
  if (
    ringTimeoutSec !== undefined &&
    (!Number.isSafeInteger(ringTimeoutSec) || ringTimeoutSec < 1 || ringTimeoutSec > 600)
  )
    return failBeforeDial({
      job,
      workerId: input.workerId,
      store: input.store,
      queue: input.queue,
      delivery,
      lease,
      visibility,
      renewal,
      reason: 'ringTimeoutSec must be an integer between 1 and 600',
    });
  const handshake = createSessionHandshake({
    job,
    workerEndpoint: input.options.workerEndpoint,
    ttlMs: input.options.handshakeTtlMs,
    ringTimeoutSec,
  });
  if (selected) {
    handshake.route.carrierId = selected.carrier.carrierId;
    handshake.route.bindingId = selected.carrier.bindingId;
  }
  const cost = await input.options.cost?.reserve(
    job,
    dialPayload,
    handshake.route.sessionId,
    selected,
  );
  if (cost && !cost.admitted) {
    return failBeforeDial({
      job,
      workerId: input.workerId,
      store: input.store,
      queue: input.queue,
      delivery,
      lease,
      visibility,
      renewal,
      reason: cost.reason ?? 'cost-admission-blocked',
    });
  }
  if (input.options.callRecorder) {
    try {
      await input.options.callRecorder.prepare(job, dialPayload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await input.recordAttempt(
        dialPayload,
        `pre-dial:${job.id}:${job.ownerEpoch}`,
        'failed',
        reason,
      );
      await cost?.releaseBeforeStart();
      return failBeforeDial({
        job,
        workerId: input.workerId,
        store: input.store,
        queue: input.queue,
        delivery,
        lease,
        visibility,
        renewal,
        reason,
      });
    }
  }

  let request: TelephonyDialRequest | DialRequest;
  try {
    request = selected
      ? dialRequestV2({
          job,
          payload: dialPayload,
          route: handshake.route,
          token: handshake.token,
          selected,
        })
      : dialRequestFromJob(dialPayload, job, {
          sessionId: handshake.route.sessionId,
          token: handshake.token,
        });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await input.recordAttempt(
      dialPayload,
      `pre-dial:${job.id}:${job.ownerEpoch}`,
      'failed',
      reason,
    );
    await cost?.releaseBeforeStart();
    await input.store.markFailed(job.id, input.workerId, job.ownerEpoch, reason);
    await input.store.releaseTerminalSession(job.id);
    await input.queue.delete(delivery);
    lease.stop();
    visibility.stop();
    await renewal.release();
    return { kind: 'failed', reason };
  }
  const route = await input.store.beginDialSession(handshake.route);
  if (!route) {
    await cost?.releaseBeforeStart();
    lease.stop();
    visibility.stop();
    await renewal.release();
    await input.queue.delete(delivery);
    return { kind: 'duplicate' };
  }

  if (selected) {
    const carrierRequest = request as DialRequest;
    const dial = await selected.control.dial(carrierRequest).catch((error: unknown) => ({
      kind: 'unknown' as const,
      requestId: carrierRequest.requestId,
      reason: error instanceof Error ? error.message : String(error),
    }));
    return settleCarrierDial({
      job,
      workerId: input.workerId,
      delivery,
      payload: dialPayload,
      route,
      request: carrierRequest,
      dial,
      store: input.store as PostgresOrchestrationStore,
      queue: input.queue,
      selected,
      lease,
      visibility,
      protection: renewal,
      cost,
      deferSeconds: input.options.deferSeconds,
      recordAttempt: (...args) => input.recordAttempt(...args),
      onCarrierAccepted: input.onCarrierAccepted,
    });
  }

  const legacyRequest = request as TelephonyDialRequest;
  const dial = await input.telephony.dial(legacyRequest).catch((error: unknown) => ({
    kind: 'unknown' as const,
    requestId: legacyRequest.requestId,
    reason: error instanceof Error ? error.message : String(error),
  }));
  return settleDialAttempt({
    job,
    workerId: input.workerId,
    delivery,
    payload: dialPayload,
    route,
    request: legacyRequest,
    dial,
    store: input.store,
    queue: input.queue,
    telephony: input.telephony,
    lease,
    visibility,
    protection: renewal,
    cost,
    deferSeconds: input.options.deferSeconds,
    recordAttempt: (...args) => input.recordAttempt(...args),
    onCarrierAccepted: input.onCarrierAccepted,
  });
}
