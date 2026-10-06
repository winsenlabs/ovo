import {
  effectiveVoicemailPolicy,
  type AgentConfig,
  type SpeechKindV2,
} from '@winsendotai/ovo-contracts';
import type { CallEnding } from './agent-ending.ts';
import type { AgentVariables } from './agent-variables.ts';
import { IdleLines } from './idle.ts';
import { RecoveryState, renderLines, type AuthoredLine, type RecoveryPlan } from './reprompt.ts';

export interface ScriptedLinesHost {
  ending: CallEnding;
  /** Records a line this call's data could not fill, by field only. */
  skipped(field: string): void;
  /** Speaks a line; `conversational` lines are what a later repeat replays. */
  say(text: string, conversational: boolean): string;
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

  /** The caller said something: the idle escalation starts over. */
  heard(): void {
    this.idle?.reset();
  }

  /** True when the agent speaks before the caller does. */
  speaksFirst(): boolean {
    return this.config.opening !== undefined;
  }

  /** The opening, once per call: no decision, LLM or caller words are involved. */
  *opening(variables: Record<string, unknown>): Generator<string> {
    if (this.opened || !this.speaksFirst()) return;
    this.opened = true;
    const lines = (this.config.opening?.lines ?? []).map((text, index) => ({
      field: `opening.lines.${index}`,
      text,
    }));
    for (const line of this.render(lines, variables)) yield this.host.say(line, true);
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
