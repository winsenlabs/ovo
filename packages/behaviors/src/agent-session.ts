import type { ValidateFunction } from 'ajv';
import { compileAgentTools, type AgentBehaviorOptions } from './agent-tools.ts';
import {
  AgentTurnLog,
  type AgentDecisionRecord,
  type AgentGroundingRecord,
  type AgentSkippedLineRecord,
} from './agent-turn-log.ts';
import type { AgentToolErrorRecord } from './agent-tools.ts';
import {
  AgentConfig as AgentConfigSchema,
  type AgentConfig,
  type Behavior,
  type Execution,
  type FinalUtterance,
  type Inference,
  type ToolDefinition,
  type SpeechReceipt,
  type SpeechKindV2,
} from '@winsendotai/ovo-contracts';
import { PlaybackConversation } from './history.ts';
import { ToolConfirmation } from './confirmation.ts';
import { ToolEvents } from './tool-events.ts';
import { assembleBoundedContext } from './context.ts';
import { ruledDecisionGate, type RuledDecisionGate } from './rules-gate.ts';
import type { FlowSession } from './decision-gate.ts';
import { flowBriefing } from './agent-decision-step.ts';
import { ScriptedLines } from './reprompt-lines.ts';
import { Grounding } from './grounding.ts';
import { CallEnding } from './agent-ending.ts';
import { AgentVariables } from './agent-variables.ts';
import { AgentReplyGuard } from './agent-guardrail.ts';
import { CallOutcomeEvents } from './outcome-events.ts';
import { followFlowEndpointing } from './flow-endpointing.ts';
import { peekHistory } from './speculation-history.ts';
import type { PartialWords } from './speculation-turn.ts';
import { AgentSpeculation } from './speculation-agent.ts';
import type { AgentSpeculationOptions } from './speculation.ts';
import { CallOptOut } from './opt-out.ts';
import { DISCLOSURE_FIELD, disclosureLine, disclosureSpeechKind } from './disclosure.ts';
import { MustHear } from './must-hear.ts';

/**
 * One agent call's state and the hooks the engine calls between turns: playback, cancellation,
 * completion, and the caller's words in progress (LAT-4). `AgentBehavior` adds the turn itself.
 */
export abstract class AgentSession implements Behavior {
  readonly config: AgentConfig;
  readonly assembledContext: string;
  protected readonly tools: ToolDefinition[];
  protected readonly validators: Map<string, ValidateFunction>;
  protected readonly operationId: () => string;
  protected active?: AbortController;
  protected turn = 0;
  protected readonly conversation = new PlaybackConversation();
  protected readonly events = new ToolEvents();
  protected readonly confirmation = new ToolConfirmation(this.events.emit);
  readonly subscribe = this.events.subscribe;
  speechKind(text: string): SpeechKindV2 | undefined {
    return (
      disclosureSpeechKind(this.config, text) ??
      this.lines.speechKind(text) ??
      this.confirmation.speechKind(text)
    );
  }
  protected uncertainWrite = false;
  protected readonly gate?: RuledDecisionGate;
  /** The authored flow this call follows, when its decision policy has one and is enabled. */
  readonly flow?: FlowSession;
  /** Opening, idle and recovery lines. */
  protected readonly lines: ScriptedLines;
  protected readonly grounding?: Grounding;
  protected readonly log = new AgentTurnLog();
  protected readonly ending = new CallEnding();
  /** Lines the caller must hear in full: a flow node's mandatory lines and the disclosure (P5). */
  protected readonly mustHear = new MustHear();
  /** The playback epoch of the turn in progress. */
  protected epoch?: number;
  /** The disclosure was cut before the caller heard it, and how often it was said again. */
  private disclosureCut = false;
  private disclosureRepeats = 0;
  protected readonly variables: AgentVariables;
  /** Tool-selection failures and decisions asked, oldest first, bounded. */
  readonly toolErrors: readonly AgentToolErrorRecord[] = this.log.toolErrors;
  readonly decisions: readonly AgentDecisionRecord[] = this.log.decisions;
  readonly groundings: readonly AgentGroundingRecord[] = this.log.groundings;
  readonly skippedLines: readonly AgentSkippedLineRecord[] = this.log.skippedLines;
  protected readonly guard: AgentReplyGuard;
  protected readonly outcomes: CallOutcomeEvents;
  /** The caller's "stop calling me" (collections compliance). */
  protected readonly optOut: CallOptOut;
  /** True once the caller asked not to be called again; the host lists the number. */
  get optedOut(): boolean {
    return this.optOut.optedOut;
  }
  /** Sentences the reply guardrail checked, flagged, blocked and dropped, and what it cost. */
  get guardrailMetrics() {
    return this.guard.metrics;
  }
  /** Work ahead of the caller (LAT-3, LAT-4). */
  protected readonly ahead: AgentSpeculation;
  get speculation() {
    return this.ahead.policy;
  }
  /** Speculative decisions and LLM calls, metered apart from the turns that used them. */
  get speculationMetrics() {
    return { decision: this.gate?.speculationMetrics, llm: this.ahead.llm };
  }

  constructor(
    config: AgentConfig,
    /** Absent for a Jev-only agent (AGT-4): a turn that would reach it is recovered instead. */
    protected readonly inference: Inference | undefined,
    protected readonly execution: Execution,
    protected readonly options: AgentBehaviorOptions & AgentSpeculationOptions,
  ) {
    this.config = AgentConfigSchema.parse(config);
    if (this.config.mode !== 'agent')
      throw new TypeError(`Agent behavior requires agent mode, received ${this.config.mode}`);
    if (!options.workspaceId || !options.sessionId)
      throw new TypeError('Agent behavior requires workspaceId and sessionId');
    this.assembledContext = assembleBoundedContext(this.config.context, this.config.contextBudget);
    this.operationId = options.operationId ?? (() => crypto.randomUUID());
    // Validates every authored line against the declared variables before the first call.
    this.variables = new AgentVariables(this.config, options.now);
    this.guard = new AgentReplyGuard(this.config, options);
    this.lines = new ScriptedLines(this.config, this.variables, {
      ending: this.ending,
      skipped: (field) => this.log.skippedLine(this.turn, field),
      say: (text, conversational) => this.say(text, conversational ? this.turn : undefined),
      mustHear: (id, text) => this.mustHear.expect(this.epoch, id, text),
    });

    const compiled = compileAgentTools(this.config);
    this.tools = compiled.tools;
    this.validators = compiled.validators;
    this.ahead = new AgentSpeculation(this.config, options.speculation);
    this.gate = ruledDecisionGate(
      this.config,
      this.options.decision,
      AgentSpeculation.forGate(this.config, this.ahead.policy),
    );
    this.flow = this.gate?.flow;
    this.outcomes = new CallOutcomeEvents(options.events, this.log);
    this.optOut = new CallOptOut(this.config, options.events);
    this.outcomes.follow(this.flow, () => this.turn);
    // Wave 4 request 5: each state's endpointing reaches the STT as an `stt.configure` event.
    if (this.flow)
      followFlowEndpointing(this.flow, (update) =>
        this.events.emit({ type: 'stt.configure', update }),
      );
    if (this.config.knowledge)
      this.grounding = new Grounding(this.config.knowledge, this.options.knowledge);
  }

  abstract respond(input: string, variables?: Record<string, unknown>): Promise<string>;

  /**
   * LAT-4, the turn driver's `TurnSpeculation.prepare`: the caller's words so far. The rules tier
   * and the decision model judge them now, as the gate would at the end of the turn, and `respond`
   * reuses that verdict when the final words and the call's state are the same. Words the gate
   * would not be asked about are left alone. Never throws.
   */
  prepare(partial: PartialWords): void {
    const { recovery } = this.lines;
    this.ahead.prepare(partial, this.gate, (input, variables) =>
      // An ended flow decides nothing more: the next turn only closes the call (P4).
      this.flow?.state.ended ||
      this.confirmation.waiting ||
      recovery.replay(input) ||
      recovery.skipsDecision(input, this.inference !== undefined)
        ? undefined
        : {
            input,
            history: peekHistory(this.conversation),
            variables,
            today: this.variables.today(),
            context: this.briefing(variables),
          },
    );
  }

  /** The utterance whose reply started last (`TurnSpeculation.finalize`). */
  private finalized?: FinalUtterance;

  /** `TurnSpeculation.finalize`: `final.text` is the next `respond` input, on the same tick. */
  finalize(final: FinalUtterance): void {
    this.finalized = final;
  }

  /** `TurnSpeculation.discard`: utterance `turnId` will not be answered as it was heard. */
  discard(turnId: string, reason?: 'reset' | 'superseded'): void {
    this.gate?.discardPrepared(turnId);
    // AGT-10: its words come back inside the merged turn, so they leave the history here.
    if (reason === 'superseded' && this.finalized?.turnId === turnId) {
      this.conversation.withdraw(this.finalized.text);
      this.finalized = undefined;
    }
  }

  /** AGT-5: until a flow confirms identity, the briefing carries none of this call's values. */
  protected briefing(variables: Record<string, unknown>): string {
    return flowBriefing(this.flow, this.assembledContext, (text) =>
      this.variables.renderBriefing(text, variables),
    );
  }

  /** `turn` marks a conversational line, which a later repeat replays. */
  protected say(text: string, turn?: number): string {
    if (turn !== undefined) {
      this.lines.recovery.remember(turn, text);
      this.flow?.said(turn, text);
    }
    this.ending.said(text);
    return this.conversation.generated(text);
  }

  /**
   * P5: the recording disclosure again, before anything else this reply says, when the caller cut
   * it before hearing it in full. Twice at most, so a caller who keeps talking over it is answered.
   */
  protected disclosureAgain(): string | undefined {
    const text = disclosureLine(this.config);
    if (text === undefined || !this.disclosureCut || this.disclosureRepeats >= 2) return undefined;
    this.disclosureCut = false;
    this.disclosureRepeats += 1;
    this.mustHear.expect(this.epoch, DISCLOSURE_FIELD, text);
    return this.say(text);
  }

  /** The caller-silence timeout, when this agent handles silence itself (AGT-11). */
  idleTimeoutMs = (): number | undefined => this.lines.idleTimeoutMs;
  speaksFirst = (): boolean => this.lines.speaksFirst();
  /** Undefined without a detecting policy: a machine verdict alone never ends this agent's call. */
  voicemail = (variables: Record<string, unknown>) => this.lines.voicemail(variables);

  isComplete(): boolean {
    return this.ending.complete;
  }

  completionReason(): string | undefined {
    return this.ending.reason;
  }

  cancel(reason = 'agent turn cancelled'): void {
    this.turn += 1;
    // A decision already in flight finishes within its deadline; a pending partial is not started.
    this.gate?.closePrepared();
    this.active?.abort(new DOMException(reason, 'AbortError'));
    this.active = undefined;
    this.confirmation.expire();
    this.ending.cancel();
  }

  beginTurn(epoch: number): void {
    this.epoch = epoch;
    this.conversation.beginTurn(epoch);
    this.confirmation.beginTurn(epoch);
    this.ending.beginTurn(epoch);
  }
  onPlayback(receipt: SpeechReceipt): void {
    this.conversation.played(receipt);
    this.confirmation.played(receipt);
    this.ending.played(receipt);
    const settled = this.mustHear.played(receipt);
    if (settled?.id === DISCLOSURE_FIELD) this.disclosureCut = !settled.heard;
    else if (settled?.heard) this.flow?.heard(settled.id, receipt.text);
  }
}
