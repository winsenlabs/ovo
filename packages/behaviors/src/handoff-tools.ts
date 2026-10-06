import {
  SCHEDULE_CALLBACK_TOOL_ID,
  TRANSFER_CALL_TOOL_ID,
  type AgentHandoff,
  type CallbackWhen,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';

/**
 * Offered to the LLM when `handoff.transfer.llmTool` is on. Like `end_call` it never reaches a
 * connector: the behaviour arms the transfer and the host carries it out once the reply has played.
 * Streamed text before a tool call is refused, so the model is told to call it first.
 */
export const TRANSFER_CALL_TOOL: ToolDefinition = {
  id: TRANSFER_CALL_TOOL_ID,
  description:
    'Transfer the caller to a human colleague. Call this first, before saying anything, when the ' +
    'caller asks for a person or you cannot help; then say one short sentence that you are ' +
    'connecting them. The call is transferred once that sentence has played.',
  connector: 'native',
  inputSchema: {
    type: 'object',
    properties: { reason: { type: 'string', maxLength: 200 } },
    additionalProperties: false,
  },
  effect: 'read',
  confirmation: false,
  timeoutMs: 1_000,
};

/** Offered when `handoff.callback.llmTool` is on: records the promise, then the call ends. */
export const SCHEDULE_CALLBACK_TOOL: ToolDefinition = {
  id: SCHEDULE_CALLBACK_TOOL_ID,
  description:
    'Schedule a call back when the caller asks to be called later. Call this first, before saying ' +
    'anything. Give `in_minutes`, or `local_time` (24-hour HH:MM) with `day`, when the caller named ' +
    'a time; give neither when they did not. Then confirm the time in one short sentence and say ' +
    'goodbye; the call ends after it.',
  connector: 'native',
  inputSchema: {
    type: 'object',
    properties: {
      in_minutes: { type: 'integer', minimum: 5, maximum: 43_200 },
      local_time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
      day: { type: 'string', enum: ['today', 'tomorrow'] },
      reason: { type: 'string', maxLength: 200 },
    },
    additionalProperties: false,
  },
  effect: 'read',
  confirmation: false,
  timeoutMs: 1_000,
};

/** The built-in handoff tools this agent offers the LLM, beside its authored ones. */
export function handoffTools(handoff: AgentHandoff | undefined): ToolDefinition[] {
  return [
    ...(handoff?.transfer?.llmTool ? [TRANSFER_CALL_TOOL] : []),
    ...(handoff?.callback?.llmTool ? [SCHEDULE_CALLBACK_TOOL] : []),
  ];
}

/** The time the LLM asked for, in the policy's terms; an absent one uses the default delay. */
export function requestedCallback(input: Record<string, unknown>): CallbackWhen | undefined {
  if (typeof input.in_minutes === 'number') return { inMinutes: input.in_minutes };
  if (typeof input.local_time === 'string')
    return { at: input.local_time, day: input.day === 'tomorrow' ? 'tomorrow' : 'today' };
  return undefined;
}

export function toolReason(input: Record<string, unknown>): string | undefined {
  return typeof input.reason === 'string' && input.reason.trim()
    ? input.reason.trim().slice(0, 200)
    : undefined;
}
