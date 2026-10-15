import {
  END_CALL_TOOL_ID,
  FLOW_RESUME_TOOL_ID,
  TRANSFER_TO_AGENT_TOOL_ID,
  type InferenceReply,
} from '@winsendotai/ovo-contracts';
import { streamAgentReply, stripInternalNotes } from './agent-stream.ts';
import { EndCallRefusal } from './agent-end-refusal.ts';
import { endCallReason, isEndCall, selectedTool } from './agent-tools.ts';
import { applyFlowResume, interceptLateResume, readFlowResume } from './flow-rejoin.ts';
import { recovered, recoveryLine, replyFallbacks, uncertaintyRetry } from './inference-recovery.ts';
import { normalizeUtterance } from './rules-lexicons.ts';
import { inferenceRequest, rejoinOffer, type Rejoin } from './inference-request.ts';
import type { InferenceStepInput } from './inference-step-input.ts';

export * from './flow-rejoin.ts';
export { firstInferenceRequest } from './inference-request.ts';

export type { InferenceStepInput } from './inference-step-input.ts';

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
  const ending = new EndCallRefusal({ ...step, language: config.language });
  const publish = ending.publish;
  // Fallback lines the caller should not hear (P10, call-3 #3), sentence by sentence or whole.
  const fallbacks = replyFallbacks(step);
  const streamGuard = (text: string) => {
    const kept = fallbacks.segment(text);
    return kept === undefined || !step.guard ? kept : step.guard(kept);
  };
  const fresh = fallbacks.whole;
  const checked = (text: string) => {
    const spoken = stripInternalNotes(text);
    return spoken === undefined || !step.guard ? spoken : step.guard(spoken);
  };
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (!step.current()) throw new DOMException('stale agent turn', 'AbortError');
  };
  // Wave 12 (F1): a reply that was only the uncertainty line, asked once more (`uncertaintyRetry`).
  let again: { providerTools: true; note: string } | undefined;
  let retried = false;
  for (let index = 0; index < config.maxSteps + Number(retried); index += 1) {
    signal.throwIfAborted();
    const asked = inferenceRequest(step, rejoin);
    const request = {
      ...asked,
      ...(again
        ? { context: `${asked.context}\n\n${again.note}`, providerTools: again.providerTools }
        : {}),
      signal,
    };
    again = undefined;
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
        (input, last) => {
          if (!isEndCall(step.tools, step.validators, input)) return false;
          // A refused goodbye already streamed stays said; the call stays open.
          return (
            ending.afterText(input, () => step.endCall(endCallReason(input)), last) || 'refused'
          );
        },
        streamGuard,
        config.reply,
        // Call-3 #7: the long-answer cap reads the reply language, not the locale; a turn the flow
        // may take back is left uncapped, so no offer of more is said before the flow's question.
        rejoin ? undefined : config.language,
        {
          lastSaid: step.previous ?? [],
          ...(step.recentSaid ? { recentSaid: step.recentSaid } : {}),
          history: step.history ?? [],
        },
      );
      if (!streamed) {
        const ask = ending.takeAsk();
        if (ask !== undefined) yield publish(ask);
        return;
      }
      reply = streamed;
    } else {
      reply = await step.inference.generate(request);
    }
    assertCurrent();

    if (reply.kind === 'text') {
      const unsure = fallbacks.held();
      const said = unsure ?? stripInternalNotes(reply.text);
      const uncertain =
        unsure !== undefined ||
        (said !== undefined && normalizeUtterance(said) === normalizeUtterance(config.uncertainty));
      again = uncertain && !retried ? uncertaintyRetry(step, request) : undefined;
      if (again) {
        retried = true;
        continue;
      }
      const text = checked(fresh(said ?? recoveryLine(step)));
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

    // R2: `transfer_to_agent` withdrawn by the call's limits; the host records the refusal.
    const unoffered =
      reply.toolId === TRANSFER_TO_AGENT_TOOL_ID &&
      !step.tools.some((candidate) => candidate.id === reply.toolId);
    const withdrawn = unoffered ? step.transferToAgent?.withdrawn?.(reply.input) : undefined;
    if (withdrawn) {
      step.results.push(failedRecord(step, reply.toolId, reply.input, await withdrawn));
      continue;
    }

    const tool = selectedTool(step, reply);
    if (tool.id === END_CALL_TOOL_ID) {
      const why = ending.refused(false);
      // Wave 8b: an ending the caller did not clearly ask for is asked about, and waits for them.
      const ask = why && ending.ask(why, reply.input);
      if (ask) return yield publish(ask);
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

    // R2: an accepted transfer's announcement or the confirm question is the whole reply, said by
    // the behaviour; a refusal is a record the model reads in its next step.
    if (tool.id === TRANSFER_TO_AGENT_TOOL_ID && step.transferToAgent) {
      const answer = await step.transferToAgent(reply.input);
      if (answer.kind === 'say') return yield publish(answer.text);
      step.results.push(failedRecord(step, tool.id, reply.input, answer.error));
      continue;
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

function failedRecord(step: InferenceStepInput, toolId: string, input: unknown, error: string) {
  return {
    id: step.operationId(),
    ...step.identity,
    toolId,
    input,
    state: 'failed' as const,
    error,
    createdAt: new Date().toISOString(),
  };
}
