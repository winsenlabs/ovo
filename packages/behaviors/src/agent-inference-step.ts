import type { ValidateFunction } from 'ajv';
import type {
  AgentConfig,
  Execution,
  Inference,
  InferenceReply,
  InferenceRequest,
  OperationRecord,
  ToolDefinition,
} from '@winsendotai/ovo-contracts';
import { streamAgentReply } from './agent-stream.ts';
import type { AgentTurnLog } from './agent-turn-log.ts';
import type { ToolConfirmation } from './confirmation.ts';
import type { PlaybackConversation } from './history.ts';
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
  conversation: PlaybackConversation;
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
  const { config, conversation, signal } = step;
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
        (text) => conversation.generated(text),
      );
      if (!streamed) return;
      reply = streamed;
    } else {
      reply = await step.inference.generate(request);
    }
    assertCurrent();

    if (reply.kind === 'text') {
      yield conversation.generated(reply.text.trim() || config.uncertainty);
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

    if (tool.effect === 'write' && step.uncertainWrite()) {
      yield conversation.generated(
        'A previous change has an unconfirmed outcome. An operator must reconcile it before another change.',
      );
      return;
    }
    if (tool.effect === 'write' && step.wrote) {
      yield conversation.generated(
        'The confirmed action is complete. Please make a separate request for another change.',
      );
      return;
    }
    const operationId = step.operationId();
    if (tool.effect === 'write' || tool.confirmation) {
      yield conversation.generated(
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
      yield conversation.generated(tool.processing?.failure ?? config.processing.failure);
      return;
    }
  }
  yield conversation.generated(config.uncertainty);
}
