import type { Execution, OperationRecord } from '@winsendotai/ovo-contracts';
import type { ToolConfirmation } from './confirmation.ts';
import type { ToolEvents } from './tool-events.ts';

export interface ResumeConfirmationOptions {
  confirmation: ToolConfirmation;
  events: ToolEvents;
  execution: Execution;
  input: string;
  identity: { workspaceId: string; sessionId: string };
  /** Spoken when the approved operation does not succeed. */
  failure: string;
  signal: AbortSignal;
  setUncertainWrite: (value: boolean) => void;
}

export type ResumeConfirmationResult =
  | { kind: 'speak'; text: string; record?: OperationRecord }
  | { kind: 'continue'; wrote: boolean; record?: OperationRecord };

/**
 * Settle the confirmation this turn's words answer, before anything else looks at them.
 *
 * `uncertainWrite` is set BEFORE the call and cleared only on a settled outcome, so an operation
 * whose result never came back blocks the next change rather than being retried under a fresh id.
 */
export async function resumeConfirmation({
  confirmation,
  events,
  execution,
  input,
  identity,
  failure,
  signal,
  setUncertainWrite,
}: ResumeConfirmationOptions): Promise<ResumeConfirmationResult> {
  const decision = confirmation.accept(input);
  if (decision.kind === 'declined')
    return { kind: 'speak', text: 'Cancelled. No change was made.' };
  if (decision.kind === 'repeat') return { kind: 'speak', text: decision.prompt };
  const { tool, input: approvedInput, operationId } = decision.selection;
  if (tool.effect === 'write') setUncertainWrite(true);
  const outcome = await events.execute(
    execution,
    {
      id: operationId,
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      toolId: tool.id,
      input: approvedInput,
      confirmed: true,
    },
    signal,
  );
  if (tool.effect === 'write' && ['succeeded', 'failed'].includes(outcome.state))
    setUncertainWrite(false);
  signal.throwIfAborted();
  if (outcome.state !== 'succeeded')
    return { kind: 'speak', text: tool.processing?.failure ?? failure, record: outcome };
  return { kind: 'continue', wrote: tool.effect === 'write', record: outcome };
}
