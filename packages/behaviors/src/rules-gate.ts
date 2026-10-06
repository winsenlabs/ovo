import {
  matchFlowPhrase,
  resolveDecision,
  ruleDecisionTarget,
  type AgentConfig,
  type AgentDecisionPolicy,
  type AgentDecisionQuestion,
  type DecisionAnswer,
  type DecisionPort,
  type DecisionResolution,
} from '@winsendotai/ovo-contracts';
import {
  action,
  DecisionGate,
  type DecisionClock,
  type DecisionGateResult,
  type DecisionTurn,
} from './decision-gate.ts';
import { RuleMatcher } from './rules.ts';
import { DecisionSpeculation, type SpeculationPolicy } from './speculation.ts';

/** The `modelId` of a verdict the rules tier settled with no decision-model call. */
export const RULES_MODEL_ID = 'ovo.rules';
const RULES_CALIBRATION = 'ovo.rules@1';

/**
 * The decision gate with the rules tier in front of it (AGT-6), for an agent without a flow. A
 * rule answers a decision question outright, at confidence 1. When rules answer every question the
 * model is never asked; when they answer some, the model is asked and the rule's answer replaces
 * the model's for those questions, so a matched rule is never second-guessed.
 *
 * It also keeps the turn's verdict (`last`), which the agent needs to tell an unavailable decision
 * model or a clarification apart from an answer when choosing what to say instead (AGT-4, AGT-12).
 */
export class RuledDecisionGate extends DecisionGate {
  /**
   * The verdict of the most recent `evaluate`, cleared when the next one starts. The agent clears
   * it at the start of every caller turn too, since some turns never ask the gate.
   */
  last?: DecisionGateResult;
  /** LAT-4: the verdict on the caller's partial transcript, when the policy speculates. */
  private readonly speculation?: DecisionSpeculation;
  /** Set while the decision model is asked, so a speculative call can be counted as one. */
  private readonly probe: { asked: boolean };

  constructor(
    private readonly authored: AgentDecisionPolicy,
    port: DecisionPort | undefined,
    private readonly rules?: RuleMatcher,
    clock?: DecisionClock,
    speculation?: Pick<SpeculationPolicy, 'partials' | 'debounceMs' | 'match'>,
  ) {
    const probe = { asked: false };
    // With a flow, the authored phrases still win; the rules tier then tries the listen set's own
    // rules and the global ones before the decision model is asked.
    super(
      authored,
      port && {
        decide: (request, options) => {
          probe.asked = true;
          return port.decide(request, options);
        },
      },
      clock,
      {
        rules: (reply, listen, flow) =>
          matchFlowPhrase(flow, listen, reply) ?? rules?.match(reply, listen)?.intent,
      },
    );
    this.probe = probe;
    if (speculation?.partials && authored.enabled && (this.flow || authored.questions.length))
      this.speculation = new DecisionSpeculation(speculation, (turn, signal) =>
        this.ask(turn, signal),
      );
  }

  /** What speculation on partial transcripts did; undefined when this gate does not speculate. */
  get speculationMetrics() {
    return this.speculation?.metrics;
  }

  /** LAT-4: decide on utterance `turnId`'s partial transcript before the caller's turn ends. */
  prepare(turnId: string, turn: DecisionTurn, stable: boolean): void {
    const state = this.speculationState(turn);
    if (state) this.speculation?.offer(turnId, turn, state, stable);
  }

  /** A turn started or was cancelled: a partial still waiting out its debounce is not decided. */
  closePrepared(): void {
    this.speculation?.closeOffers();
  }

  /** Utterance `turnId` will not be answered as heard: what was decided for it is dropped. */
  discardPrepared(turnId: string): void {
    this.speculation?.discard(turnId);
  }

  override async evaluate(
    turn: DecisionTurn,
    signal: AbortSignal,
    waiting?: () => void,
  ): Promise<DecisionGateResult> {
    this.last = undefined;
    // Without a decision prepared for these words, the model is asked on this tick, as before.
    const pending = this.speculation?.take(
      turn,
      this.speculationState(turn) ?? '',
      signal,
      waiting,
    );
    const prepared = pending && (await pending);
    if (pending) signal.throwIfAborted();
    let verdict = prepared && this.restamp(prepared);
    if (!verdict) {
      const asked = this.ask(turn, signal);
      if (asked.asked) waiting?.();
      verdict = await asked.verdict;
    }
    this.last = verdict;
    return verdict;
  }

  /** `decide`, and whether it asked the model: that happens on this tick, before any await. */
  private ask(turn: DecisionTurn, signal: AbortSignal) {
    this.probe.asked = false;
    const verdict = this.decide(turn, signal);
    const asked = this.probe.asked;
    this.probe.asked = false;
    return { verdict, asked };
  }

  /**
   * Everything but the words that the verdict depends on. Retrieved passages are left out: an agent
   * whose policy reads them does not speculate (`AgentBehavior`).
   */
  private speculationState(turn: DecisionTurn): string | undefined {
    const { history, variables, context, today } = turn;
    try {
      return JSON.stringify([this.flow?.state ?? null, history, variables, context, today ?? null]);
    } catch {
      // swallow-ok: variables JSON cannot carry (a BigInt) only mean this turn is not speculated.
      return undefined;
    }
  }

  /** A reused flow step is dated when the turn takes it, not when the partial was decided. */
  private restamp(verdict: DecisionGateResult): DecisionGateResult {
    if (verdict.kind !== 'flow') return verdict;
    const transition = { ...verdict.step.transition, at: new Date().toISOString() };
    return { kind: 'flow', step: { ...verdict.step, transition } };
  }

  private async decide(turn: DecisionTurn, signal: AbortSignal): Promise<DecisionGateResult> {
    const ruled = this.authored.enabled ? this.ruled(turn.input) : new Map();
    const questions = this.authored.questions;
    // Never with no questions: a policy without them (a flow, since Wave 3) routes another way.
    if (ruled.size && ruled.size === questions.length) {
      const resolutions = questions.map((question) => ruled.get(question.id)!);
      return { kind: 'decided', modelId: RULES_MODEL_ID, resolutions, action: action(resolutions) };
    }
    const verdict = await super.evaluate(turn, signal);
    if (verdict.kind !== 'decided' || !ruled.size) return verdict;
    const resolutions = verdict.resolutions.map(
      (resolution) => ruled.get(resolution.questionId) ?? resolution,
    );
    return { ...verdict, resolutions, action: action(resolutions) };
  }

  /** The first matching rule per question, resolved as a fully confident answer. */
  private ruled(input: string): Map<string, DecisionResolution> {
    const ruled = new Map<string, DecisionResolution>();
    for (const match of this.rules?.matches(input) ?? []) {
      const target = ruleDecisionTarget(match.intent);
      const question = target && this.authored.questions.find((q) => q.id === target.question);
      if (!target || !question || ruled.has(question.id)) continue;
      const answer = ruleAnswer(question, target.answer);
      if (answer) ruled.set(question.id, resolveDecision(question, answer));
    }
    return ruled;
  }
}

/** The agent's gate, with its rules in front, or none without a decision policy. */
export function ruledDecisionGate(
  config: AgentConfig,
  port: DecisionPort | undefined,
  speculation?: Pick<SpeculationPolicy, 'partials' | 'debounceMs' | 'match'>,
): RuledDecisionGate | undefined {
  if (!config.decision) return undefined;
  return new RuledDecisionGate(
    config.decision,
    port,
    config.rules && new RuleMatcher(config.rules),
    undefined,
    speculation,
  );
}

function ruleAnswer(question: AgentDecisionQuestion, answer: string): DecisionAnswer | undefined {
  const base = { confidence: 1, calibrationVersion: RULES_CALIBRATION };
  if (question.type === 'choice' && question.options.some((option) => option.key === answer))
    return { type: 'choice', choice: answer, probabilities: { [answer]: 1 }, ...base };
  if (question.type === 'noul' && (answer === 'yes' || answer === 'no'))
    return {
      type: 'noul',
      noul: answer === 'yes' ? 1 : 0,
      probabilities: { yes: answer === 'yes' ? 1 : 0, no: answer === 'no' ? 1 : 0 },
      ...base,
    };
  // Config validation keeps rules off score questions and unknown answers; skip rather than throw.
  return undefined;
}
