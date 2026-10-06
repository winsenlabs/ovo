import { flowFacts } from './agent-decision-step.ts';
import { runPreReplySteps } from './agent-pre-reply.ts';
import { resumeConfirmation } from './agent-confirmation-step.ts';
import { firstInferenceRequest, runInferenceSteps } from './agent-inference-step.ts';
import { AgentSession } from './agent-session.ts';
import type { AgentBehaviorOptions } from './agent-tools.ts';
import type { AgentSpeculationOptions } from './speculation.ts';
import type {
  AgentConfig,
  Execution,
  Inference,
  OperationRecord,
} from '@winsendotai/ovo-contracts';
export {
  AgentToolSelectionError,
  type AgentBehaviorOptions,
  type AgentToolErrorRecord,
} from './agent-tools.ts';
export { AgentSession } from './agent-session.ts';
export * from './speculation.ts';
export type { LlmSpeculationMetrics } from './speculation-llm.ts';
export type { PartialWords } from './speculation-turn.ts';

export class AgentBehavior extends AgentSession {
  async respond(input: string, variables: Record<string, unknown> = {}): Promise<string> {
    const segments: string[] = [];
    for await (const segment of this.runResponse(input, false, variables)) segments.push(segment);
    return segments.join(' ');
  }

  respondStream(input: string, variables: Record<string, unknown> = {}): AsyncIterable<string> {
    return this.runResponse(input, true, variables);
  }

  private async *runResponse(
    input: string,
    streaming: boolean,
    variables: Record<string, unknown> = {},
  ): AsyncIterable<string> {
    this.ending.startTurn();
    this.lines.startTurn();
    this.ahead.heardTurn(variables);
    if (variables.inputEvent === 'opening') return yield* this.lines.opening(variables, this.flow);
    if (variables.inputEvent === 'idle') return yield* this.lines.silence(variables);
    this.lines.heard();
    this.gate?.closePrepared();
    this.active?.abort(new DOMException('superseded by a newer turn', 'AbortError'));
    const controller = new AbortController();
    const turn = ++this.turn;
    this.active = controller;
    const results: OperationRecord[] = [];
    const history = this.conversation.user(input);
    let wrote = false;
    // LAT-3: the LLM's first step, asked alongside the decision when the agent speculates.
    const early = this.ahead.llmTurn(this.inference, streaming, controller.signal, (context) =>
      firstInferenceRequest({
        config: this.config,
        input,
        history,
        context,
        tools: this.tools,
        results,
        ...(this.flow ? { flow: this.flow } : {}),
      }),
    );

    try {
      if (this.confirmation.waiting) {
        const resumed = await resumeConfirmation({
          confirmation: this.confirmation,
          events: this.events,
          execution: this.execution,
          input,
          identity: {
            workspaceId: this.options.workspaceId,
            sessionId: this.options.sessionId,
          },
          failure: this.config.processing.failure,
          signal: controller.signal,
          setUncertainWrite: (value) => {
            this.uncertainWrite = value;
          },
        });
        if (resumed.record) results.push(resumed.record);
        if (resumed.kind === 'speak') {
          yield this.say(resumed.text);
          return;
        }
        wrote = resumed.wrote;
      }
      // A turn that never asks the gate (a knowledge refusal) must not be judged by the last verdict.
      if (this.gate) this.gate.last = undefined;
      const route = await this.lines.route({
        input,
        llm: this.inference !== undefined,
        verdict: () => this.gate?.last,
        prepare: () =>
          runPreReplySteps({
            config: this.config,
            grounding: this.grounding,
            gate: this.gate,
            // AGT-5: until a flow confirms identity, neither carries this call's variable values.
            briefing: this.briefing(variables),
            facts: flowFacts(this.flow, this.variables.facts(variables)),
            turnInput: { input, history, variables, today: this.variables.today() },
            signal: controller.signal,
            log: this.log,
            turn,
            stale: () => turn !== this.turn,
            render: (line) => this.variables.render(line, variables),
            ...this.guard.input(results),
            ...(early ? { speculateLlm: early.start } : {}),
          }),
      });
      this.outcomes.routed(turn, route);
      if (route.kind === 'recover') return yield* this.lines.speak(route.plan, variables);
      const { prepared } = route;
      if (route.end !== undefined) this.ending.arm(`decision:${route.end}`);
      if (route.say !== undefined) {
        // A flow node's lines are separate segments, so each one is cached and played on its own.
        for (const line of prepared.lines ?? [route.say]) yield this.say(line, turn);
        this.ending.seal();
        return;
      }
      if (!this.inference) return;
      yield* runInferenceSteps({
        config: this.config,
        inference: early?.inference() ?? this.inference,
        execution: this.execution,
        identity: { workspaceId: this.options.workspaceId, sessionId: this.options.sessionId },
        tools: this.tools,
        validators: this.validators,
        log: this.log,
        confirmation: this.confirmation,
        events: this.events,
        publish: (text) => this.say(text, turn),
        endCall: (reason) => this.ending.arm(reason),
        operationId: this.operationId,
        turn,
        current: () => turn === this.turn,
        input,
        history,
        context: prepared.context,
        results,
        streaming,
        signal: controller.signal,
        uncertainWrite: () => this.uncertainWrite,
        wrote,
        ...(this.flow ? { flow: this.flow } : {}),
        guard: prepared.guard,
      });
      this.ending.seal();
    } finally {
      early?.finish();
      if (this.active === controller) this.active = undefined;
    }
  }
}

export function createAgentBehavior(
  config: AgentConfig,
  inference: Inference | undefined,
  execution: Execution,
  options: AgentBehaviorOptions & AgentSpeculationOptions,
): AgentBehavior {
  return new AgentBehavior(config, inference, execution, options);
}
