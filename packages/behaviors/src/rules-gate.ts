import {
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
  type DecisionGateResult,
  type DecisionTurn,
} from './decision-gate.ts';
import { RuleMatcher } from './rules.ts';

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

  constructor(
    private readonly authored: AgentDecisionPolicy,
    port: DecisionPort | undefined,
    private readonly rules?: RuleMatcher,
    clock?: { timeout(ms: number): AbortSignal },
  ) {
    super(authored, port, clock);
  }

  override async evaluate(turn: DecisionTurn, signal: AbortSignal): Promise<DecisionGateResult> {
    this.last = undefined;
    const verdict = await this.decide(turn, signal);
    this.last = verdict;
    return verdict;
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
): RuledDecisionGate | undefined {
  if (!config.decision) return undefined;
  return new RuledDecisionGate(
    config.decision,
    port,
    config.rules && new RuleMatcher(config.rules),
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
