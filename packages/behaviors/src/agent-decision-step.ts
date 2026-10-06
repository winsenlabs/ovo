import { AnnouncementValidationError } from './announcement.ts';
import type { DecisionGate, DecisionGateResult, DecisionTurn } from './decision-gate.ts';
import { applyFlowStep } from './flow-step.ts';

export * from './flow-step.ts';

export interface DecisionStepOptions {
  turn: DecisionTurn;
  signal: AbortSignal;
  /** Spoken when every deferring question asked for clarification instead of the LLM. */
  clarification: string;
  record: (result: DecisionGateResult) => void;
  /** True once a newer turn has superseded this one. */
  stale: () => boolean;
  /** Renders an authored line with this call's variables. */
  render: (line: string) => string;
}

export interface DecisionStepResult {
  /** Spoken instead of asking the LLM. */
  speak?: string;
  /** `speak` as separate lines, when a flow node says several; each is its own segment. */
  lines?: string[];
  /** The call ends once this turn's reply has played; `<question>=<answer>` or `flow:<node>`. */
  end?: string;
}

/**
 * Run the policy and report what the turn should SAY, or no `speak` to carry on to the LLM.
 *
 * An 'unavailable' verdict returns `undefined` on purpose. A decision model that is slow, down or
 * answering incoherently must never drop a live call: the turn then proceeds exactly as an agent
 * with no policy would, and the failure is recorded for review rather than heard by the caller.
 * A flow handles that inside its own fallback, which is where its author said what should happen.
 */
export async function runDecisionStep(
  gate: DecisionGate,
  { turn, signal, clarification, record, stale, render }: DecisionStepOptions,
): Promise<DecisionStepResult> {
  const verdict = await gate.evaluate(turn, signal);
  signal.throwIfAborted();
  if (stale()) throw new DOMException('stale agent turn', 'AbortError');
  record(verdict);
  // Committed only here, after the staleness check: a superseded turn never moves the call.
  if (verdict.kind === 'flow')
    return applyFlowStep(gate.flow!, verdict.step, { render, clarification });
  if (verdict.kind !== 'decided') return {};
  const end = verdict.action.end === undefined ? {} : { end: verdict.action.end };
  // A trusted scripted line answers the turn outright; no LLM round trip happens at all.
  if (verdict.action.say !== undefined) {
    try {
      return { speak: render(verdict.action.say), ...end };
    } catch (error) {
      // swallow-ok: a line naming a variable this call lacks is never read aloud half-filled; the
      // LLM, which sees the call facts, composes the reply instead and the call carries on.
      if (!(error instanceof AnnouncementValidationError)) throw error;
      return end;
    }
  }
  return verdict.action.clarify ? { speak: clarification } : end;
}
