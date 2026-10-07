import { flowFacts } from './agent-decision-step.ts';
import { runPreReplySteps } from './agent-pre-reply.ts';
import { resumeConfirmation } from './agent-confirmation-step.ts';
import { firstInferenceRequest, runInferenceSteps } from './agent-inference-step.ts';
import { AgentSession } from './agent-session.ts';
import { OPT_OUT_COMPLETION } from './opt-out.ts';
import type { AgentBehaviorOptions } from './agent-tools.ts';
import { AgentHandoffs } from './handoff.ts';
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
export * from './handoff.ts';
export type { LlmSpeculationMetrics } from './speculation-llm.ts';
export type { PartialWords } from './speculation-turn.ts';

export class AgentBehavior extends AgentSession {
  /** Transfer and callback turns (AGT-15); inert without a `handoff` block. */
  private readonly handoffs: AgentHandoffs;
  /** Execution with the built-in handoff tools answered in the behaviour. */
  private readonly toolExecution: Execution;

  constructor(
    config: AgentConfig,
    inference: Inference | undefined,
    execution: Execution,
    options: AgentBehaviorOptions & AgentSpeculationOptions,
  ) {
    super(config, inference, execution, options);
    this.handoffs = new AgentHandoffs(
      this.config,
      {
        ...(options.events ? { events: options.events } : {}),
        now: options.now ?? (() => new Date()),
        turn: () => this.turn,
        arm: (reason) => this.ending.arm(reason),
      },
      this.variables.schema,
    );
    this.handoffs.offer(this.tools, this.validators);
    this.handoffs.follow(this.flow);
    this.toolExecution = this.handoffs.execution(execution);
  }

  /** A flow node that transfers completes with a `transfer:` reason, ending as `transferred`. */
  override completionReason(): string | undefined {
    return this.handoffs.completionReason(super.completionReason());
  }

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
    if (variables.inputEvent === 'idle')
      return yield* this.flow?.state.ended ? this.closeFlow('') : this.lines.silence(variables);
    this.lines.heard();
    this.gate?.closePrepared();
    this.active?.abort(new DOMException('superseded by a newer turn', 'AbortError'));
    // The caller withdrew consent: no decision, LLM or pending confirmation answers this turn.
    if (this.optOut.heard(input, this.turn + 1)) {
      this.turn += 1;
      this.confirmation.expire();
      this.conversation.user(input);
      this.ending.arm(OPT_OUT_COMPLETION);
      yield this.say(this.optOut.closingLine);
      this.ending.seal();
      return;
    }
    if (this.flow?.state.ended) return yield* this.closeFlow(input);
    // What the agent said last turn, read before this turn says anything (P10).
    const previous = [...this.lines.recovery.lastSaid];
    const controller = new AbortController();
    const turn = ++this.turn;
    this.active = controller;
    const results: OperationRecord[] = [];
    const history = this.conversation.user(input);
    const replyCut = this.conversation.replyCut;
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
        replyCut,
        previous,
      }),
    );

    try {
      const disclosure = this.disclosureAgain();
      if (disclosure !== undefined) yield disclosure;
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
      const diverted = this.handoffs.divert(route, this.gate?.last);
      if (diverted) return yield* this.lines.speak(diverted, variables);
      if (route.kind === 'recover') return yield* this.lines.speak(route.plan, variables);
      const { prepared } = route;
      // A flow that has reached its end node is final (P4): a barge-in cannot reopen it.
      if (route.end !== undefined)
        this.ending.arm(`decision:${route.end}`, { terminal: this.flow?.state.ended });
      if (route.say !== undefined) {
        // A flow node's lines are separate segments, so each one is cached and played on its own.
        for (const [index, line] of (prepared.lines ?? [route.say]).entries()) {
          const mandatory = prepared.mandatory?.[index];
          if (mandatory !== undefined) this.mustHear.expect(this.epoch, mandatory, line);
          yield this.say(line, prepared.replay ? undefined : turn);
        }
        this.ending.seal();
        return;
      }
      if (!this.inference) return;
      yield* runInferenceSteps({
        config: this.config,
        inference: early?.inference() ?? this.inference,
        execution: this.toolExecution,
        identity: { workspaceId: this.options.workspaceId, sessionId: this.options.sessionId },
        tools: this.tools,
        validators: this.validators,
        log: this.log,
        confirmation: this.confirmation,
        events: this.events,
        publish: (text) => this.say(text, turn),
        endCall: (reason) => this.ending.arm(reason, { terminal: this.flow?.state.ended }),
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
        replyCut,
        previous,
      });
      this.ending.seal();
    } finally {
      early?.finish();
      if (this.active === controller) this.active = undefined;
    }
  }

  /**
   * P4: the flow has ended, so this turn only closes the call. The goodbye is said once more when
   * the caller barged in before hearing any of it; the call then ends whatever they say, and no
   * decision or LLM is asked: nothing can reopen a call the flow has finished.
   */
  private *closeFlow(input: string): Generator<string> {
    this.turn += 1;
    if (input) this.conversation.user(input);
    const reason = `decision:flow:${this.flow!.state.node ?? 'end'}`;
    for (const line of this.ending.close(reason)) yield this.say(line);
    this.ending.seal();
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
