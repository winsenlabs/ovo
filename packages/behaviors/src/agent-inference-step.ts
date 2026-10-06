import type { ValidateFunction } from 'ajv';
import {
  END_CALL_TOOL_ID,
  type AgentConfig,
  type Execution,
  type Inference,
  type InferenceReply,
  type InferenceRequest,
  type OperationRecord,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';
import { streamAgentReply } from './agent-stream.ts';
import type { AgentTurnLog } from './agent-turn-log.ts';
import type { ToolConfirmation } from './confirmation.ts';
import type { ToolEvents } from './tool-events.ts';

export interface InferenceStepInput {
  config: AgentConfig;
  inference: Inference;
  execution: Execution;
  identity: { workspaceId: string; sessionId: string };
  tools: ToolDefinition[];
  validators: ReadonlyMap<string, ValidateFunction>;
  log: AgentTurnLog;
  confirmation: ToolConfirmation;
  events: ToolEvents;
  /** Records a line as generated and returns it for speaking. */
  publish: (text: string) => string;
  /** The LLM ended the call; its goodbye is this turn's reply. */
  endCall: (reason: string) => void;
  operationId: () => string;
  turn: number;
  /** False once a newer turn has superseded this one. */
  current: () => boolean;
  input: string;
  history: InferenceRequest['history'];
  context: string;
  /** Records settled this turn; appended to as tools run. */
  results: OperationRecord[];
  streaming: boolean;
  signal: AbortSignal;
  /** A previous write's outcome was never confirmed. */
  uncertainWrite: () => boolean;
  /** This turn already executed a confirmed write. */
  wrote: boolean;
}

/**
 * Ask the LLM, run the read tools it selects, and speak its answer. Bounded by `maxSteps`; a write
 * or a confirmation-gated tool is never executed here, only proposed for the caller to confirm.
 */
export async function* runInferenceSteps(step: InferenceStepInput): AsyncGenerator<string, void> {
  const { config, publish, signal } = step;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (!step.current()) throw new DOMException('stale agent turn', 'AbortError');
  };
  for (let index = 0; index < config.maxSteps; index += 1) {
    signal.throwIfAborted();
    const request = {
      input: step.input,
      history: step.history,
      context: step.context,
      uncertainty: config.uncertainty,
      tools: step.tools,
      results: step.results,
      signal,
    };
    let reply: InferenceReply;
    if (step.streaming && step.inference.stream) {
      const streamed = yield* streamAgentReply(
        step.inference.stream(request),
        config.locale,
        assertCurrent,
        publish,
        (input) => {
          const accepted = isEndCall(step, input);
          if (accepted) step.endCall(endReason(input));
          return accepted;
        },
      );
      if (!streamed) return;
      reply = streamed;
    } else {
      reply = await step.inference.generate(request);
    }
    assertCurrent();

    if (reply.kind === 'text') {
      yield publish(reply.text.trim() || config.uncertainty);
      return;
    }

    const tool = step.tools.find((candidate) => candidate.id === reply.toolId);
    if (!tool) {
      throw step.log.toolError(
        step.turn,
        reply.toolId,
        'unknown-or-unapproved',
        `Inference selected unknown or unapproved tool: ${reply.toolId}`,
      );
    }
    const validate = step.validators.get(tool.id)!;
    if (!validate(reply.input)) {
      const reason = validate.errors
        ?.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
        .join('; ');
      throw step.log.toolError(
        step.turn,
        tool.id,
        'invalid-input',
        `Inference supplied invalid input for ${tool.id}: ${reason ?? 'schema mismatch'}`,
      );
    }
    if (tool.id === END_CALL_TOOL_ID) {
      step.endCall(endReason(reply.input));
      yield publish((reply.input as { goodbye: string }).goodbye.trim());
      return;
    }

    if (tool.effect === 'write' && step.uncertainWrite()) {
      yield publish(
        'A previous change has an unconfirmed outcome. An operator must reconcile it before another change.',
      );
      return;
    }
    if (tool.effect === 'write' && step.wrote) {
      yield publish(
        'The confirmed action is complete. Please make a separate request for another change.',
      );
      return;
    }
    const operationId = step.operationId();
    if (tool.effect === 'write' || tool.confirmation) {
      yield publish(
        step.confirmation.request({ tool, input: reply.input, operationId }, config.locale),
      );
      return;
    }

    // Execution is the sole policy, durable-intent, acknowledgement, and connector boundary.
    const result = await step.events.execute(
      step.execution,
      {
        id: operationId,
        workspaceId: step.identity.workspaceId,
        sessionId: step.identity.sessionId,
        toolId: tool.id,
        input: reply.input,
        confirmed: false,
      },
      signal,
    );
    assertCurrent();
    step.results.push(result);
    // A fresh model-selected ID must never turn an uncertain effect into an
    // automatic retry. Surface failure and require explicit reconciliation.
    if (result.state !== 'succeeded') {
      yield publish(tool.processing?.failure ?? config.processing.failure);
      return;
    }
  }
  yield publish(config.uncertainty);
}

/** Only an offered `end_call` with valid input ends the call; anything else is a protocol error. */
function isEndCall(step: InferenceStepInput, input: unknown): boolean {
  const validate = step.validators.get(END_CALL_TOOL_ID);
  return Boolean(
    validate && step.tools.some((tool) => tool.id === END_CALL_TOOL_ID) && validate(input),
  );
}

function endReason(input: unknown): string {
  const reason = (input as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim()
    ? `llm:end_call:${reason.trim()}`
    : 'llm:end_call';
}
