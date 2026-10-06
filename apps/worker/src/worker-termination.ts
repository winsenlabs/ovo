import {
  outcomeFor,
  type EndReason,
  type HandoffTarget,
  type Reconciliation,
} from '@winsendotai/ovo-contracts';
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
  /** Asks the carrier for the final status when its terminal callback does not arrive (OBS-11). */
  reconcile?: TerminalReconcile;
  /** AGT-15: the agent's transfer target, for a call it ended `transferred`. */
  transfer?: HandoffTarget;
}

type EndedState = Extract<Reconciliation, { kind: 'ended' }>['state'];
type CallbackStatus = 'completed' | 'busy' | 'failed' | 'no_answer' | 'cancelled';

export interface TerminalReconcile {
  /** How long the carrier's own terminal callback gets first; default 15 s. */
  afterMs?: number;
  /** Runs after this check made the route terminal, e.g. to release inbound capacity. */
  onTerminal?(input: { carrierCallId: string; status: CallbackStatus }): Promise<void>;
}

const CALLBACK_STATUS: Readonly<Record<EndedState, CallbackStatus>> = {
  completed: 'completed',
  busy: 'busy',
  failed: 'failed',
  no_answer: 'no_answer',
  canceled: 'cancelled',
};

/** Forced exits can bypass onSessionClose, so settle their cost attachment here. */
export async function terminateOwnedJobAndFinalize(
  input: OwnedTermination & { finalizeCost(jobId: string): Promise<void> },
): Promise<boolean> {
  try {
    return await terminateOwnedJob(input);
  } finally {
    await input.finalizeCost(input.jobId);
  }
}

/** Fence carrier control first; local resources must still close if the fence fails. */
export async function terminateOwnedJob(input: OwnedTermination): Promise<boolean> {
  const job = await input.store.get(input.jobId);
  const route = await input.store.getSessionRoute(input.jobId);
  if (!job || !route) return false;
  const reason: EndReason = asEndReason(input.reason);
  let fenced;
  try {
    fenced = await input.store.requestSessionTermination(
      input.jobId,
      input.workerId,
      input.ownerEpoch,
      reason,
    );
  } catch (error) {
    await closeLocalAfterFenceFailure(input, route.sessionId, reason, error);
    throw error;
  }
  if (!fenced) {
    const error = new Error(`Session ${route.sessionId} termination fence failed`);
    await closeLocalAfterFenceFailure(input, route.sessionId, reason, error);
    throw error;
  }
  let selected;
  try {
    selected = await input.carriers.forJob(job, false);
  } catch (error) {
    await input.media.terminate(route.sessionId, reason).catch(() => undefined);
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
    media: {
      terminate: (sessionId, terminatedReason) =>
        input.media.terminate(sessionId, terminatedReason),
    },
    engine: {
      dispose: async () => {
        await input.media.closeSession(route.sessionId, reason);
        return { reason, outcome: outcomeFor(reason) };
      },
    },
    reason,
    ...(input.transfer
      ? { transfer: { target: input.transfer, workspaceId: job.workspaceId } }
      : {}),
  });
  if (input.reconcile) {
    const reconcile = input.reconcile;
    const timer = setTimeout(() => {
      void reconcileTerminalRoute({ ...input, control: selected.control }, reconcile).catch(
        (error: unknown) =>
          console.error(
            JSON.stringify({
              event: 'terminal_reconcile_failed',
              jobId: input.jobId,
              error: String(error),
            }),
          ),
      );
    }, reconcile.afterMs ?? 15_000);
    timer.unref?.();
  }
  return true;
}

/**
 * A terminated call whose carrier sent no terminal status callback (an inbound number with no
 * status URL pasted, a lost webhook) stays `terminating`, and its inbound capacity stays reserved.
 * This asks the carrier once and records an ended call as a `reconcile` callback, which the
 * route's state rules order like any other: a real callback that already landed wins.
 */
export async function reconcileTerminalRoute(
  input: Pick<OwnedTermination, 'jobId' | 'store'> & {
    control: {
      reconcile(query: { requestId: string; carrierCallId?: string }): Promise<Reconciliation>;
    };
  },
  options: Pick<TerminalReconcile, 'onTerminal'> = {},
): Promise<'already_terminal' | 'applied' | 'not_ended' | 'unidentified'> {
  const route = await input.store.getSessionRoute(input.jobId);
  if (!route || route.terminalAt) return 'already_terminal';
  if (!route.carrierCallId || !route.carrierId) return 'unidentified';
  const result = await input.control.reconcile({
    requestId: route.dialRequestId,
    carrierCallId: route.carrierCallId,
  });
  if (result.kind !== 'ended') return 'not_ended';
  const status = CALLBACK_STATUS[result.state];
  const carrierCallId = route.carrierCallId;
  const applied = await input.store.applyCarrierCallback({
    organizationId: route.organizationId,
    carrierId: route.carrierId,
    provider: 'ovo.reconcile',
    eventId: `${carrierCallId}:reconcile:${status}`,
    carrierCallId,
    status,
    occurredAt: new Date(),
    payload: {
      source: 'reconcile',
      ...(result.answeredBy ? { answeredBy: result.answeredBy } : {}),
    },
  });
  if (applied.kind !== 'applied') return 'already_terminal';
  await options.onTerminal?.({ carrierCallId, status });
  return 'applied';
}

async function closeLocalAfterFenceFailure(
  input: OwnedTermination,
  sessionId: string,
  reason: EndReason,
  error: unknown,
): Promise<void> {
  const cleanupErrors: string[] = [];
  try {
    await input.media.terminate(sessionId, reason);
  } catch (cleanupError) {
    cleanupErrors.push(String(cleanupError));
  }
  try {
    await input.media.closeSession(sessionId, reason);
  } catch (cleanupError) {
    cleanupErrors.push(String(cleanupError));
  }
  console.error(
    JSON.stringify({
      event: 'termination_fence_failed',
      jobId: input.jobId,
      sessionId,
      workerId: input.workerId,
      ownerEpoch: input.ownerEpoch,
      error: String(error),
      cleanupErrors,
    }),
  );
}
