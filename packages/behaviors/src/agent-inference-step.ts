import type { ValidateFunction } from 'ajv';
import {
  END_CALL_TOOL_ID,
  FLOW_RESUME_TOOL_ID,
  type AgentConfig,
  type Execution,
  type Inference,
  type InferenceReply,
  type InferenceRequest,
  type OperationRecord,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';
import { streamAgentReply, stripInternalNotes } from './agent-stream.ts';
import { EndCallRefusal } from './agent-end-gate.ts';
import { endCallReason, isEndCall } from './agent-tools.ts';
import type { AgentTurnLog } from './agent-turn-log.ts';
import type { ToolConfirmation } from './confirmation.ts';
import { applyFlowResume, interceptLateResume, readFlowResume } from './flow-rejoin.ts';
import type { FlowSession } from './flow-session.ts';
import { recovered, recoveryLine, repeatGuard, uncertaintyAgain } from './inference-recovery.ts';
import { inferenceRequest, rejoinOffer, type Rejoin } from './inference-request.ts';
import type { ToolEvents } from './tool-events.ts';

export * from './flow-rejoin.ts';
export { firstInferenceRequest } from './inference-request.ts';

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
  /** N1: why the LLM may not end the call on this turn (`EndCallGate`); undefined when it may. */
  endRefused?: () => string | undefined;
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
  /** The session's flow, when the agent routes by one: the LLM may hand the call back to it. */
  flow?: FlowSession;
  /** The reply guardrail from the pre-reply step: the text to speak, or undefined to drop it. */
  guard?: (segment: string) => string | undefined;
  /** The caller cut off the agent's previous reply (P7); the LLM is told so in its instructions. */
  replyCut?: boolean;
  /** What the agent said in its previous turn, so the uncertainty line is not said twice (P10). */
  previous?: readonly string[];
}

/**
 * Ask the LLM, run the read tools it selects, and speak its answer. Bounded by `maxSteps`; a write
 * or a confirmation-gated tool is never executed here, only proposed for the caller to confirm.
 *
 * A model that misuses a tool (an unknown tool, input that fails its schema, a tool call after its
 * text), or on the voice path a provider that fails, is recorded and answered with the uncertainty
 * line, never thrown to the engine: a turn that fails ends the call (P8, see `recovered`).
 */
export async function* runInferenceSteps(step: InferenceStepInput): AsyncGenerator<string, void> {
  const flow = step.flow;
  const endAllowed = Boolean(step.config.ending?.llmTool);
  const offer = rejoinOffer(step);
  let spoke = false;
  let rejoined = false;
  const counted = {
    ...step,
    publish: (text: string) => {
      spoke = true;
      return step.publish(text);
    },
  };
  try {
    yield* inferenceSteps(
      counted,
      flow && offer
        ? {
            ...offer,
            resume: (resume) => {
              rejoined = true;
              if (applyFlowResume(flow, resume, endAllowed)) step.endCall('llm:resume_flow:end');
            },
          }
        : undefined,
    );
  } catch (error) {
    if (!recovered(step, error)) throw error;
    if (!spoke) yield step.publish(recoveryLine(step));
  }
  // Answered in plain text: the flow stays where it was, and the path records that the LLM spoke.
  if (flow && offer && !rejoined) flow.rejoin(undefined, endAllowed);
}

async function* inferenceSteps(
  step: InferenceStepInput,
  rejoin?: Rejoin,
): AsyncGenerator<string, void> {
  const { config, signal } = step;
  const ending = new EndCallRefusal(step);
  const publish = ending.publish;
  // A streamed reply drops the repeated sentences; a whole one that is only the uncertainty line
  // again becomes the clarification.
  const repeated = repeatGuard(step);
  const streamGuard =
    repeated && step.guard
      ? (text: string) => {
          const kept = repeated(text);
          return kept === undefined ? undefined : step.guard!(kept);
        }
      : (repeated ?? step.guard);
  const fresh = (text: string) => (uncertaintyAgain(step, text) ? config.clarification : text);
  const checked = (text: string) => {
    const spoken = stripInternalNotes(text);
    return spoken === undefined || !step.guard ? spoken : step.guard(spoken);
  };
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (!step.current()) throw new DOMException('stale agent turn', 'AbortError');
  };
  for (let index = 0; index < config.maxSteps; index += 1) {
    signal.throwIfAborted();
    const request = { ...inferenceRequest(step, rejoin), signal };
    let reply: InferenceReply;
    if (step.streaming && step.inference.stream) {
      const events = step.inference.stream(request);
      const streamed = yield* streamAgentReply(
        rejoin
          ? interceptLateResume(events, (input) => {
              // A superseded turn must not move the flow or arm the next turn's ending.
              assertCurrent();
              const resume = readFlowResume(input, true);
              if (resume) rejoin.resume(resume);
            })
          : events,
        config.locale,
        assertCurrent,
        publish,
        (input) => {
          const accepted = isEndCall(step.tools, step.validators, input);
          // A refused goodbye already streamed stays said; the call stays open.
          if (accepted && !ending.refused(true)) step.endCall(endCallReason(input));
          return accepted;
        },
        streamGuard,
        config.reply?.minFirstWords,
      );
      if (!streamed) return;
      reply = streamed;
    } else {
      reply = await step.inference.generate(request);
    }
    assertCurrent();

    if (reply.kind === 'text') {
      const text = checked(fresh(stripInternalNotes(reply.text) ?? recoveryLine(step)));
      if (text !== undefined) yield publish(text);
      return;
    }

    // A reply put inside `resume_flow` is spoken only once the whole call has arrived: the inference
    // port delivers a tool call whole (`InferenceStreamEvent` has no argument deltas), so it cannot
    // stream. That is why the model is told to say its answer as text first, which streams.
    if (rejoin && reply.toolId === FLOW_RESUME_TOOL_ID) {
      // P8: a resume with no reply is taken as the late resume it is; the caller still hears
      // something, the uncertainty line, rather than silence or a dropped call.
      const resume = readFlowResume(reply.input, true);
      if (!resume)
        throw step.log.toolError(
          step.turn,
          FLOW_RESUME_TOOL_ID,
          'invalid-input',
          `Inference supplied invalid input for ${FLOW_RESUME_TOOL_ID}`,
        );
      rejoin.resume(resume);
      const said = stripInternalNotes(resume.reply);
      const spoken = said === undefined ? recoveryLine(step) : checked(fresh(said));
      if (spoken !== undefined) yield publish(spoken);
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
      const why = ending.refused(false);
      // Refused: the model hears why, and answers the caller instead in its next step.
      if (why) {
        step.results.push(ending.record(reply.input, why));
        continue;
      }
      step.endCall(endCallReason(reply.input));
      const goodbye = checked((reply.input as { goodbye: string }).goodbye.trim());
      if (goodbye !== undefined) yield publish(goodbye);
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
  yield publish(recoveryLine(step));
}
