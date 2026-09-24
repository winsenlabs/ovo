import type {
  ClaimedJob,
  DurableJobStore,
  DurableQueue,
  QueueDelivery,
  TelephonyControl,
  PostgresOrchestrationStore,
} from '@winsendotai/ovo-plugin-orchestration';
import type { WorkerCarrierRuntime } from './carrier-runtime.ts';
import { outcomeFor } from '@winsendotai/ovo-contracts';
import { terminateCarrierLeg } from '@winsendotai/ovo-session-host';
import { completedWithoutSession } from './carrier-completion.ts';

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
    const fenced = await input.store.prepareReconciledTermination(
      input.job.id,
      input.workerId,
      input.job.ownerEpoch,
      requestId,
      outcome.carrierCallId,
      'accepted-dial-found-after-session-owner-loss',
    );
    if (!fenced) return deferLostOwnership(input);
    await input.telephony.hangup(outcome.carrierCallId).catch(() => undefined);
    const notBefore = new Date(Date.now() + input.deferSeconds * 1_000);
    const deferred = await input.store.deferReconciliation(
      input.job.id,
      input.workerId,
      input.job.ownerEpoch,
      'awaiting-terminal-callback-after-owner-loss',
      notBefore,
    );
    await input.queue.changeVisibility(input.delivery, input.deferSeconds);
    if (!deferred) return { kind: 'deferred', reason: 'terminal-callback-won-race' };
    return { kind: 'reconcile_required', jobId: input.job.id, requestId };
  }
  if (outcome.kind === 'rejected') {
    const fenced = await input.store.markFailed(
      input.job.id,
      input.workerId,
      input.job.ownerEpoch,
      outcome.reason,
    );
    if (!fenced) return deferLostOwnership(input);
    await input.store.releaseTerminalSession(input.job.id);
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

/** Reconcile the selected v2 carrier; terminal non-sessions never become accepted. */
export async function reconcileClaimedCarrierDial(input: {
  workerId: string;
  job: ClaimedJob;
  delivery: QueueDelivery;
  store: DurableJobStore;
  queue: DurableQueue;
  carriers: WorkerCarrierRuntime;
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
  let selected: Awaited<ReturnType<WorkerCarrierRuntime['forJob']>>;
  try {
    selected = await input.carriers.forJob(input.job);
  } catch (error) {
    await input.queue.changeVisibility(input.delivery, input.deferSeconds);
    return {
      kind: 'deferred',
      reason: `carrier-reconciliation-unavailable:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const route = await input.store.getSessionRoute(input.job.id);
  const outcome = await selected.control.reconcile({
    requestId,
    carrierCallId: input.job.carrierCallId,
    carrierRequestId: route?.carrierRequestId,
  });
  const fail = async (reason: string): Promise<ReconciliationOutcome> => {
    const fenced = await input.store.markFailed(
      input.job.id,
      input.workerId,
      input.job.ownerEpoch,
      reason,
    );
    if (!fenced) return deferLostOwnership(input);
    await input.store.releaseTerminalSession(input.job.id);
    await input.queue.delete(input.delivery);
    return { kind: 'failed', reason };
  };
  if (outcome.kind === 'rejected') return fail(outcome.reason);
  if (outcome.kind === 'ended') {
    if (outcome.answeredBy === 'machine') return fail('voicemail');
    if (['busy', 'no_answer', 'failed', 'canceled'].includes(outcome.state))
      return fail(outcome.state);
    if (completedWithoutSession(outcome.state, route)) return fail('completed_without_session');
  }
  if (outcome.kind === 'live') {
    const carrierCallId = outcome.carrierCallId ?? input.job.carrierCallId;
    const carrierRequestId = route?.carrierRequestId;
    if (carrierCallId || carrierRequestId) {
      const store = input.store as PostgresOrchestrationStore;
      const accepted = await store.markDialAccepted({
        jobId: input.job.id,
        workerId: input.workerId,
        ownerEpoch: input.job.ownerEpoch,
        dialRequestId: requestId,
        carrierCallId,
        carrierRequestId,
      });
      if (!accepted) return deferLostOwnership(input);
      if (!route) return deferLostOwnership(input);
      await terminateCarrierLeg({
        route: {
          sessionId: route.sessionId,
          jobId: input.job.id,
          workerId: input.workerId,
          ownerEpoch: input.job.ownerEpoch,
          carrierCallId,
          carrierRequestId,
        },
        store: {
          requestSessionTermination: async (_route, reason) => {
            const fenced = await input.store.requestSessionTermination(
              input.job.id,
              input.workerId,
              input.job.ownerEpoch,
              reason,
            );
            return fenced ? { carrierCallId, carrierRequestId } : undefined;
          },
        },
        control: selected.control,
        capabilities: selected.carrier.capabilities,
        // No local media session was opened by this worker during reconciliation.
        media: { terminate: async () => undefined },
        engine: {
          dispose: async () => ({
            reason: 'ownership_lost',
            outcome: outcomeFor('ownership_lost'),
          }),
        },
        reason: 'ownership_lost',
      });
    }
  }
  const deferred = await input.store.deferReconciliation(
    input.job.id,
    input.workerId,
    input.job.ownerEpoch,
    outcome.kind === 'live'
      ? 'awaiting-terminal-callback-after-owner-loss'
      : 'carrier-outcome-still-pending',
    new Date(Date.now() + input.deferSeconds * 1_000),
  );
  await input.queue.changeVisibility(input.delivery, input.deferSeconds);
  return deferred
    ? { kind: 'reconcile_required', jobId: input.job.id, requestId }
    : { kind: 'deferred', reason: 'reconciliation-ownership-lost' };
}
