import type { ValidateFunction } from 'ajv';
import { compileAgentTools, type AgentBehaviorOptions } from './agent-tools.ts';
import {
  AgentTurnLog,
  type AgentDecisionRecord,
  type AgentGroundingRecord,
  type AgentSkippedLineRecord,
} from './agent-turn-log.ts';
import type { AgentToolErrorRecord } from './agent-tools.ts';
export {
  AgentToolSelectionError,
  type AgentBehaviorOptions,
  type AgentToolErrorRecord,
} from './agent-tools.ts';
import {
  AgentConfig as AgentConfigSchema,
  type AgentConfig,
  type Behavior,
  type Execution,
  type Inference,
  type OperationRecord,
  type ToolDefinition,
  type SpeechReceipt,
  type SpeechKindV2,
} from '@winsendotai/ovo-contracts';
import { PlaybackConversation } from './history.ts';
import { ToolConfirmation } from './confirmation.ts';
import { ToolEvents } from './tool-events.ts';
import { assembleBoundedContext } from './context.ts';
import { ruledDecisionGate, type RuledDecisionGate } from './rules-gate.ts';
import { ScriptedLines } from './reprompt-lines.ts';
import { runPreReplySteps } from './agent-pre-reply.ts';
import { resumeConfirmation } from './agent-confirmation-step.ts';
import { Grounding } from './grounding.ts';
import { runInferenceSteps } from './agent-inference-step.ts';
import { CallEnding } from './agent-ending.ts';
import { AgentVariables } from './agent-variables.ts';

export class AgentBehavior implements Behavior {
  readonly config: AgentConfig;
  readonly assembledContext: string;
  private readonly tools: ToolDefinition[];
  private readonly validators: Map<string, ValidateFunction>;
  private readonly operationId: () => string;
  private active?: AbortController;
  private turn = 0;
  private readonly conversation = new PlaybackConversation();
  private readonly events = new ToolEvents();
  private readonly confirmation = new ToolConfirmation(this.events.emit);
  readonly subscribe = this.events.subscribe;
  speechKind(text: string): SpeechKindV2 | undefined {
    return this.lines.speechKind(text) ?? this.confirmation.speechKind(text);
  }
  private uncertainWrite = false;
  private readonly gate?: RuledDecisionGate;
  /** Opening, idle and recovery lines. */
  private readonly lines: ScriptedLines;
  private readonly grounding?: Grounding;
  private readonly log = new AgentTurnLog();
  private readonly ending = new CallEnding();
  private readonly variables: AgentVariables;
  /** Tool-selection failures and decisions asked, oldest first, bounded. */
  readonly toolErrors: readonly AgentToolErrorRecord[] = this.log.toolErrors;
  readonly decisions: readonly AgentDecisionRecord[] = this.log.decisions;
  readonly groundings: readonly AgentGroundingRecord[] = this.log.groundings;
  readonly skippedLines: readonly AgentSkippedLineRecord[] = this.log.skippedLines;

  constructor(
    config: AgentConfig,
    /** Absent for a Jev-only agent (AGT-4): a turn that would reach it is recovered instead. */
    private readonly inference: Inference | undefined,
    private readonly execution: Execution,
    private readonly options: AgentBehaviorOptions,
  ) {
    this.config = AgentConfigSchema.parse(config);
    if (this.config.mode !== 'agent') {
      throw new TypeError(`Agent behavior requires agent mode, received ${this.config.mode}`);
    }
    if (!options.workspaceId || !options.sessionId)
      throw new TypeError('Agent behavior requires workspaceId and sessionId');
    this.assembledContext = assembleBoundedContext(this.config.context, this.config.contextBudget);
    this.operationId = options.operationId ?? (() => crypto.randomUUID());
    // Validates every authored line against the declared variables before the first call.
    this.variables = new AgentVariables(this.config, options.now);
    this.lines = new ScriptedLines(this.config, this.variables, {
      ending: this.ending,
      skipped: (field) => this.log.skippedLine(this.turn, field),
      say: (text, conversational) => this.say(text, conversational ? this.turn : undefined),
    });

    const compiled = compileAgentTools(this.config);
    this.tools = compiled.tools;
    this.validators = compiled.validators;
    this.gate = ruledDecisionGate(this.config, this.options.decision);
    if (this.config.knowledge)
      this.grounding = new Grounding(this.config.knowledge, this.options.knowledge);
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
    if (variables.inputEvent === 'opening' || variables.inputEvent === 'idle') {
      yield* variables.inputEvent === 'opening'
        ? this.lines.opening(variables)
        : this.lines.silence(variables);
      return;
    }
    this.lines.heard();
    this.active?.abort(new DOMException('superseded by a newer turn', 'AbortError'));
    const controller = new AbortController();
    const turn = ++this.turn;
    this.active = controller;
    const results: OperationRecord[] = [];
    const history = this.conversation.user(input);
    let wrote = false;

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
      const replay = this.lines.recovery.replay(input);
      if (replay) {
        yield* this.lines.speak(replay, variables);
        return;
      }
      const llm = this.inference !== undefined;
      const skip = this.lines.recovery.skipsDecision(input, llm);
      const prepared = skip
        ? { context: '' }
        : await runPreReplySteps({
            config: this.config,
            grounding: this.grounding,
            gate: this.gate,
            briefing: this.variables.renderBriefing(this.assembledContext, variables),
            facts: this.variables.facts(variables),
            turnInput: { input, history, variables, today: this.variables.today() },
            signal: controller.signal,
            log: this.log,
            turn,
            stale: () => turn !== this.turn,
            render: (line) => this.variables.render(line, variables),
          });
      const route = this.lines.recovery.route({
        input,
        answered: prepared.speak,
        end: prepared.end,
        verdict: skip ? undefined : this.gate?.last,
        llm,
      });
      if (route.kind === 'recover') {
        yield* this.lines.speak(route.plan, variables);
        return;
      }
      if (route.end !== undefined) this.ending.arm(`decision:${route.end}`);
      if (route.say !== undefined) {
        yield this.say(route.say, turn);
        this.ending.seal();
        return;
      }
      if (!this.inference) return;
      yield* runInferenceSteps({
        config: this.config,
        inference: this.inference,
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
      });
      this.ending.seal();
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  /** `turn` marks a conversational line, which a later repeat replays. */
  private say(text: string, turn?: number): string {
    if (turn !== undefined) this.lines.recovery.remember(turn, text);
    this.ending.said();
    return this.conversation.generated(text);
  }

  /** The caller-silence timeout, when this agent handles silence itself (AGT-11). */
  idleTimeoutMs(): number | undefined {
    return this.lines.idleTimeoutMs;
  }

  speaksFirst(): boolean {
    return this.config.opening !== undefined;
  }

  /** Undefined without a detecting policy: a machine verdict alone never ends this agent's call. */
  voicemail(variables: Record<string, unknown>): string | undefined {
    return this.lines.voicemail(variables);
  }

  isComplete(): boolean {
    return this.ending.complete;
  }

  completionReason(): string | undefined {
    return this.ending.reason;
  }

  cancel(reason = 'agent turn cancelled'): void {
    this.turn += 1;
    this.active?.abort(new DOMException(reason, 'AbortError'));
    this.active = undefined;
    this.confirmation.expire();
    this.ending.cancel();
  }

  beginTurn(epoch: number): void {
    this.conversation.beginTurn(epoch);
    this.confirmation.beginTurn(epoch);
    this.ending.beginTurn(epoch);
  }
  onPlayback(receipt: SpeechReceipt): void {
    this.conversation.played(receipt);
    this.confirmation.played(receipt);
    this.ending.played(receipt);
  }
}

export function createAgentBehavior(
  config: AgentConfig,
  inference: Inference | undefined,
  execution: Execution,
  options: AgentBehaviorOptions,
): AgentBehavior {
  return new AgentBehavior(config, inference, execution, options);
}
