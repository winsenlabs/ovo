import type { AgentConfig } from '@winsendotai/ovo-contracts';
import { runDecisionStep } from './agent-decision-step.ts';
import type { AgentTurnLog } from './agent-turn-log.ts';
import type { DecisionGate } from './decision-gate.ts';
import type { Grounding } from './grounding.ts';
import { runGroundingStep } from './grounding-step.ts';

export interface PreReplyInput {
  config: AgentConfig;
  grounding?: Grounding;
  gate?: DecisionGate;
  /** The agent's own briefing text, before anything retrieved is added to it. */
  briefing: string;
  /** This call's facts for the LLM. The decision model reads variables through its own source. */
  facts: string;
  turnInput: {
    input: string;
    history: readonly { role: 'user' | 'assistant'; content: string }[];
    variables: Readonly<Record<string, unknown>>;
    today: string;
  };
  /** Renders an authored line with this call's variables. */
  render: (line: string) => string;
  signal: AbortSignal;
  log: AgentTurnLog;
  turn: number;
  stale: () => boolean;
}

export interface PreReply {
  /** Set when the turn is already answered and the LLM must not be asked. */
  speak?: string;
  /** The briefing the LLM should see, with the call facts and any retrieved passages appended. */
  context: string;
  /** A trusted decision ends the call once this turn's reply has played. */
  end?: string;
}

/**
 * Everything that happens before the LLM is asked: retrieve, then decide.
 *
 * The order is the point. Retrieval runs ONCE and its passages ground both the decision and the
 * reply that follows it, so the two can never disagree about what the corpus says. Retrieving again
 * for the reply would allow exactly that.
 */
export async function runPreReplySteps({
  config,
  grounding,
  gate,
  briefing,
  facts,
  turnInput,
  signal,
  log,
  turn,
  stale,
  render,
}: PreReplyInput): Promise<PreReply> {
  let retrieved = '';
  if (grounding) {
    const step = await runGroundingStep(grounding, {
      policy: config.knowledge,
      input: turnInput.input,
      signal,
      uncertainty: config.uncertainty,
      record: (result) => log.grounding(turn, result),
      stale,
    });
    if (step.refuse !== undefined) return { speak: step.refuse, context: briefing };
    if (step.result.kind === 'grounded') retrieved = step.result.rendered;
  }
  const context =
    facts || retrieved
      ? [briefing, facts, retrieved].filter(Boolean).join('\n\n').trim()
      : briefing;
  if (gate) {
    const answered = await runDecisionStep(gate, {
      turn: { ...turnInput, context: briefing, retrieved },
      signal,
      clarification: config.clarification,
      record: (result) => log.decision(turn, result),
      stale,
      render,
    });
    return { ...answered, context };
  }
  return { context };
}
