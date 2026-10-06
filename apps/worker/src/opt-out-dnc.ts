import { Cap } from '@winsendotai/ovo-contracts';
import {
  OPERATIONS_SERVICE_KEY,
  type DoNotCallService,
  type OperationsService,
} from '@winsendotai/ovo-plugin-operations';
import type { DurableJob } from '@winsendotai/ovo-plugin-orchestration';
import type { Composition } from '@winsendotai/ovo-runtime';
import type { WorkerSessionTelemetry } from './telemetry-runtime.ts';

/**
 * After a call in which the caller opted out (the agent's `optedOut`), puts the caller's number on
 * the do-not-call list with the call id, so no campaign or manual dial reaches it again. The caller
 * is the dialed number on an outbound call and the calling number on an inbound one. A failed
 * write is audited for the operator, never raised into the call's cleanup.
 */
export async function recordOptOut(input: {
  composition: Pick<Composition, 'ctx'>;
  doNotCall?: Pick<DoNotCallService, 'add'>;
  payload: Readonly<Record<string, unknown>>;
  callId: string;
  telemetry: Pick<WorkerSessionTelemetry, 'audit'>;
}): Promise<void> {
  const behavior = input.composition.ctx.get(Cap.behavior) as { optedOut?: boolean } | undefined;
  if (behavior?.optedOut !== true) return;
  const number = callerNumber(input.payload);
  if (!input.doNotCall || !number) {
    input.telemetry.audit('compliance.opt-out.unrecorded', {
      reason: input.doNotCall ? 'caller-number-unknown' : 'do-not-call-unavailable',
    });
    return;
  }
  try {
    await input.doNotCall.add(number, 'Caller asked not to be called again', {
      source: 'opt_out',
      callId: input.callId,
    });
    input.telemetry.audit('compliance.opt-out.recorded', { callId: input.callId });
  } catch (error) {
    input.telemetry.audit('compliance.opt-out.unrecorded', {
      reason: 'write-failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function callerNumber(payload: Readonly<Record<string, unknown>>): string | undefined {
  const value = payload.kind === 'inbound_call' ? payload.from : payload.to;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * The session cleanup step for a live call: lists the caller when the agent heard an opt-out. The
 * do-not-call list comes from the worker's process composition (its operations service), read
 * when the call ends; a worker without operations audits the opt-out as unrecorded.
 */
export function optOutRecorder(
  host: { parent: Pick<Composition, 'ctx'> },
  session: { composition: Pick<Composition, 'ctx'> },
  job: Pick<DurableJob, 'id' | 'payload'>,
  telemetry: Pick<WorkerSessionTelemetry, 'audit'>,
): () => Promise<void> {
  return () => {
    let doNotCall: Pick<DoNotCallService, 'add'> | undefined;
    try {
      doNotCall = (host.parent.ctx.get(OPERATIONS_SERVICE_KEY) as OperationsService | undefined)
        ?.campaigns.doNotCall;
    } catch {
      doNotCall = undefined;
    }
    const callId =
      typeof job.payload.callId === 'string' && job.payload.callId ? job.payload.callId : job.id;
    const { composition } = session;
    return recordOptOut({ composition, doNotCall, payload: job.payload, callId, telemetry });
  };
}
