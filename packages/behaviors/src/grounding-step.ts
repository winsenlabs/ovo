import type { AgentKnowledgePolicy } from '@winsendotai/ovo-contracts';
import { groundingMissing, type Grounding, type GroundingResult } from './grounding.ts';

export interface GroundingStepOptions {
  policy?: AgentKnowledgePolicy;
  input: string;
  signal: AbortSignal;
  /** Spoken when the policy requires grounding and the turn has none. */
  uncertainty: string;
  record: (result: GroundingResult) => void;
  stale: () => boolean;
}

export interface GroundingStep {
  /** Set when the turn must stop here and say this instead of answering ungrounded. */
  refuse?: string;
  result: GroundingResult;
}

/**
 * Retrieve what this turn may use. `requireGrounding` is the only case that stops the turn: for an
 * agent whose answers are only safe when grounded — a policy, a price, an eligibility rule — saying
 * the uncertainty line is correct and answering from the model alone is not.
 *
 * Otherwise an unavailable retrieval falls through ungrounded, recorded for review. A knowledge
 * backend being slow or down must not drop a live call.
 */
export async function runGroundingStep(
  grounding: Grounding,
  { policy, input, signal, uncertainty, record, stale }: GroundingStepOptions,
): Promise<GroundingStep> {
  const result = await grounding.retrieve(input, signal);
  signal.throwIfAborted();
  if (stale()) throw new DOMException('stale agent turn', 'AbortError');
  record(result);
  return groundingMissing(policy, result) ? { refuse: uncertainty, result } : { result };
}
