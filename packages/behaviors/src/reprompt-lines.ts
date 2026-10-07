import {
  effectiveVoicemailPolicy,
  flowSpeaksFirst,
  type AgentConfig,
  type SpeechKindV2,
} from '@winsendotai/ovo-contracts';
import type { CallEnding } from './agent-ending.ts';
import type { PreReply } from './agent-pre-reply.ts';
import { openFlow } from './agent-decision-step.ts';
import type { DecisionGateResult, FlowSession } from './decision-gate.ts';
import type { AgentVariables } from './agent-variables.ts';
import { IdleLines } from './idle.ts';
import { RecoveryState, renderLines, type AuthoredLine, type RecoveryPlan } from './reprompt.ts';
import { DISCLOSURE_FIELD, disclosureLine, withDisclosure } from './disclosure.ts';

/** Where a caller turn goes: recovery lines, or the decision step's answer (no `say`: the LLM). */
export type CallerTurn =
  | { kind: 'recover'; plan: RecoveryPlan }
  | { kind: 'answer'; prepared: PreReply; say?: string; end?: string };

export interface ScriptedLinesHost {
  ending: CallEnding;
  /** Records a line this call's data could not fill, by field only. */
  skipped(field: string): void;
  /** Speaks a line; `conversational` lines are what a later repeat replays. */
  say(text: string, conversational: boolean): string;
  /** `text` is about to be said and must be heard in full as `id` (P5). */
  mustHear(id: string, text: string): void;
}

/**
 * The lines an agent speaks with no LLM and no decision answer behind them: the opening (AGT-2),
 * the voicemail message, the idle prompts (AGT-11) and the recovery lines (AGT-4, AGT-12). Each is rendered for the call;
 * a line the call's data cannot fill is skipped, never read aloud half-filled.
 */
export class ScriptedLines {
  readonly recovery: RecoveryState;
  private readonly idle?: IdleLines;
  private idlePrompts = new Set<string>();
  private opened = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly variables: AgentVariables,
    private readonly host: ScriptedLinesHost,
  ) {
    this.recovery = new RecoveryState(config, variables.schema);
    if (config.idle) this.idle = new IdleLines(config.idle);
  }

  /** The caller-silence timeout, when this agent handles silence itself. */
  get idleTimeoutMs(): number | undefined {
    return this.idle?.timeoutMs;
  }

  /** Idle prompts play as `idle-prompt` speech, but only during their own turn. */
  speechKind(text: string): SpeechKindV2 | undefined {
    return this.idlePrompts.has(text) ? 'idle-prompt' : undefined;
  }

  startTurn(): void {
    this.idlePrompts = new Set();
  }

  /**
   * Route a caller turn: a request to hear the last turn again is replayed, an empty reply is
   * recovered without a decision, and otherwise `prepare` runs the decision step and the recovery
   * state judges its verdict (`verdict`, read after `prepare`).
   */
  async route(turn: {
    input: string;
    llm: boolean;
    prepare: () => Promise<PreReply>;
    verdict: () => DecisionGateResult | undefined;
  }): Promise<CallerTurn> {
    const replay = this.recovery.replay(turn.input);
    if (replay) return { kind: 'recover', plan: replay };
    const skip = this.recovery.skipsDecision(turn.input, turn.llm);
    const prepared: PreReply = skip ? { context: '' } : await turn.prepare();
    const route = this.recovery.route({
      input: turn.input,
      answered: prepared.speak,
      end: prepared.end,
      verdict: skip ? undefined : turn.verdict(),
      llm: turn.llm,
    });
    return route.kind === 'recover' ? route : { ...route, prepared };
  }

  /** The caller said something: the idle escalation starts over. */
  heard(): void {
    this.idle?.reset();
  }

  /** True when the agent speaks before the caller does: an opening, or a flow's start node. */
  speaksFirst(): boolean {
    return (
      this.config.opening !== undefined ||
      flowSpeaksFirst(this.config.decision) ||
      disclosureLine(this.config) !== undefined
    );
  }

  /**
   * The opening, once per call: the `opening` lines, then a flow's start node. No decision, LLM or
   * caller words are involved.
   */
  *opening(variables: Record<string, unknown>, flow?: FlowSession): Generator<string> {
    if (this.opened || !this.speaksFirst()) return;
    this.opened = true;
    // The recording disclosure comes before anything else the call says.
    const lines = withDisclosure(
      this.config,
      (this.config.opening?.lines ?? []).map((text, index) => ({
        field: `opening.lines.${index}`,
        text,
      })),
    );
    const rendered = this.render(lines, variables);
    const disclosure = disclosureLine(this.config);
    const mustHear: (string | undefined)[] = rendered.map((text) =>
      text === disclosure ? DISCLOSURE_FIELD : undefined,
    );
    const started = openFlow(flow, {
      render: (line) => this.variables.render(line, variables),
      clarification: this.config.clarification,
    });
    for (const [index, line] of (started?.lines ?? []).entries()) {
      rendered.push(line);
      mustHear.push(started?.mandatory?.[index]);
    }
    if (started?.end !== undefined)
      this.host.ending.arm(`decision:${started.end}`, { terminal: true });
    for (const [index, line] of rendered.entries()) {
      const id = mustHear[index];
      if (id !== undefined) this.host.mustHear(id, line);
      yield this.host.say(line, true);
    }
    this.host.ending.seal();
  }

  /** A caller silence: the next idle line, ending the call after the final one. */
  *silence(variables: Record<string, unknown>): Generator<string> {
    if (this.idle) yield* this.speak(this.idle.next(), variables);
  }

  /** Recovery and idle lines: spoken and kept in history, but never what a repeat replays. */
  *speak(plan: RecoveryPlan, variables: Record<string, unknown>): Generator<string> {
    if (plan.end !== undefined) this.host.ending.arm(plan.end);
    for (const line of this.render(plan.lines, variables)) {
      if (plan.idle) this.idlePrompts.add(line);
      yield this.host.say(line, false);
    }
    this.host.ending.seal();
  }

  /** The message to leave on an answering machine; '' hangs up; undefined keeps the call. */
  voicemail(variables: Record<string, unknown>): string | undefined {
    const policy = effectiveVoicemailPolicy(this.config);
    if (!policy) return undefined;
    return policy.action === 'message' && policy.message
      ? this.variables.render(policy.message, variables)
      : '';
  }

  private render(lines: readonly AuthoredLine[], variables: Record<string, unknown>): string[] {
    return renderLines(
      lines,
      (text) => this.variables.render(text, variables),
      (field) => this.host.skipped(field),
    );
  }
}
