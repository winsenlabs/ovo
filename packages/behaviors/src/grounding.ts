import {
  groundPassages,
  knowledgeQuery,
  renderPassages,
  validateKnowledgeExchange,
  type AgentKnowledgePolicy,
  type GroundedPassages,
  type KnowledgePort,
} from '@winsendotai/ovo-contracts';

export type GroundingResult =
  | { kind: 'off' }
  /** Retrieval could not answer. Whether the turn continues is the policy's decision, not this one's. */
  | { kind: 'unavailable'; reason: 'timeout' | 'error' | 'invalid'; message: string }
  | { kind: 'grounded'; grounded: GroundedPassages; rendered: string };

/**
 * Retrieves the passages one turn is allowed to use, and applies the authored threshold and character
 * budget. It performs no effect and composes no answer: the behaviour decides what to do with an
 * empty result, which is why a weak match stays visibly weak instead of becoming confident prose.
 *
 * Retrieval runs ONCE per turn and the same passages ground both the decision and the LLM. Retrieving
 * twice would let a decision and the reply that follows it disagree about what the corpus says.
 */
export class Grounding {
  constructor(
    private readonly policy: AgentKnowledgePolicy,
    private readonly port: KnowledgePort | undefined,
    private readonly clock: { timeout(ms: number): AbortSignal } = {
      timeout: (ms) => AbortSignal.timeout(ms),
    },
  ) {}

  async retrieve(text: string, signal: AbortSignal): Promise<GroundingResult> {
    if (!this.policy.enabled) return { kind: 'off' };
    if (!this.port)
      return {
        kind: 'unavailable',
        reason: 'error',
        message: 'No knowledge plugin is available for a configured knowledge policy',
      };
    const query = knowledgeQuery(this.policy, text);
    const deadline = this.clock.timeout(this.policy.timeoutMs);
    let result;
    try {
      result = await this.port.search(query, { signal: AbortSignal.any([signal, deadline]) });
    } catch (error) {
      // A cancelled turn is not a retrieval failure; the caller is already gone.
      signal.throwIfAborted();
      if (deadline.aborted)
        return {
          kind: 'unavailable',
          reason: 'timeout',
          message: `Knowledge did not answer within ${this.policy.timeoutMs}ms`,
        };
      return {
        kind: 'unavailable',
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    signal.throwIfAborted();
    try {
      // Re-validated here, as the decision exchange is: a third-party knowledge plugin is the point
      // of the boundary, and ranked order is what the budget trim below depends on.
      const checked = validateKnowledgeExchange(query, result);
      const grounded = groundPassages(this.policy, checked.result);
      return { kind: 'grounded', grounded, rendered: renderPassages(grounded.used) };
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: 'invalid',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** True when the policy demands grounding and this turn has none to offer. */
export function groundingMissing(
  policy: AgentKnowledgePolicy | undefined,
  result: GroundingResult,
): boolean {
  if (!policy?.enabled || !policy.requireGrounding) return false;
  return result.kind !== 'grounded' || result.grounded.used.length === 0;
}
