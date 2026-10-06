import { Cap, outcomeFor, type EndReason } from '@winsendotai/ovo-contracts';
import {
  QueuedSessionEventSink,
  type CallOutcomeStore,
} from '@winsendotai/ovo-plugin-storage/outcomes';
import type { Composition } from '@winsendotai/ovo-runtime';
import type { WorkerSessionTelemetry } from './telemetry-runtime.ts';

/**
 * The call's event sink (AGT-8): routing verdicts, flow states, dispositions and guardrail verdicts
 * the behaviour records, written to the outcome store in the background. A failed write is audited
 * on the call, never raised into it.
 */
export function openSessionEvents(
  store: Pick<CallOutcomeStore, 'append'> | undefined,
  identity: { workspaceId: string; callId: string },
  telemetry: Pick<WorkerSessionTelemetry, 'audit'>,
): QueuedSessionEventSink | undefined {
  if (!store) return undefined;
  return new QueuedSessionEventSink(store, identity, {
    onError: (error) => telemetry.audit('outcome.write-failed', { message: error.message }),
  });
}

/** Records how the call ended, then writes what is queued. Runs after the engine is disposed. */
export async function closeSessionEvents(
  events: QueuedSessionEventSink | undefined,
  reason: EndReason,
): Promise<void> {
  if (!events) return;
  await events.append('call.outcome', { outcome: outcomeFor(reason), reason });
  await events.flush();
}

interface SpeculationMetrics {
  decision?: { started: number } & Record<string, number>;
  llm: { started: number } & Record<string, number>;
}

/**
 * What the reply guardrail checked on this call, and what the agent decided or asked the LLM ahead
 * of the caller (LAT-3, LAT-4: speculative calls, metered apart from answered turns), for the
 * per-call audit trail.
 */
export function auditGuardrail(
  composition: Pick<Composition, 'ctx'>,
  telemetry: Pick<WorkerSessionTelemetry, 'audit'>,
): void {
  const behavior = composition.ctx.get(Cap.behavior) as
    | {
        guardrailMetrics?: { snapshot(): { segments: number } & Record<string, unknown> };
        speculationMetrics?: SpeculationMetrics;
      }
    | undefined;
  const metrics = behavior?.guardrailMetrics?.snapshot();
  if (metrics?.segments) telemetry.audit('guardrail.summary', metrics);
  const ahead = behavior?.speculationMetrics;
  if (ahead && ((ahead.decision?.started ?? 0) > 0 || ahead.llm.started > 0))
    telemetry.audit('speculation.summary', {
      decision: { ...ahead.decision },
      llm: { ...ahead.llm },
    });
}
