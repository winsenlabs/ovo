import type { DecisionGate, DecisionGateResult, DecisionTurn } from './decision-gate.ts';

export interface DecisionStepOptions {
  turn: DecisionTurn;
  signal: AbortSignal;
  /** Spoken when every deferring question asked for clarification instead of the LLM. */
  clarification: string;
  record: (result: DecisionGateResult) => void;
  /** True once a newer turn has superseded this one. */
  stale: () => boolean;
}

/**
 * Run the policy and report what the turn should SAY, or `undefined` to carry on to the LLM.
 *
 * An 'unavailable' verdict returns `undefined` on purpose. A decision model that is slow, down or
 * answering incoherently must never drop a live call: the turn then proceeds exactly as an agent
 * with no policy would, and the failure is recorded for review rather than heard by the caller.
 */
export async function runDecisionStep(
  gate: DecisionGate,
  { turn, signal, clarification, record, stale }: DecisionStepOptions,
): Promise<string | undefined> {
  const verdict = await gate.evaluate(turn, signal);
  signal.throwIfAborted();
  if (stale()) throw new DOMException('stale agent turn', 'AbortError');
  record(verdict);
  if (verdict.kind !== 'decided') return undefined;
  // A trusted scripted line answers the turn outright; no LLM round trip happens at all.
  if (verdict.action.say !== undefined) return verdict.action.say;
  return verdict.action.clarify ? clarification : undefined;
}
