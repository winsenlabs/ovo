import type { FinalUtterance } from '@winsendotai/ovo-contracts';
import { flowFacts } from './agent-decision-step.ts';
import { replyContext } from './agent-pre-reply.ts';
import { AgentSession } from './agent-session.ts';
import { firstInferenceRequest } from './inference-request.ts';
import { peekHistory } from './speculation-history.ts';
import type { InferenceCall } from './speculation-llm.ts';
import type { PartialWords } from './speculation-turn.ts';

/**
 * The turn driver's `TurnSpeculation` hooks on an agent call: the caller's words in progress,
 * judged by the decision model (LAT-4) or asked of the LLM (Wave 8) before the turn ends.
 */
export abstract class AgentSessionAhead extends AgentSession {
  /**
   * LAT-4, the turn driver's `TurnSpeculation.prepare`: the caller's words so far. The rules tier
   * and the decision model judge them now, as the gate would at the end of the turn, and `respond`
   * reuses that verdict when the final words and the call's state are the same. Words the gate
   * would not be asked about are left alone. Never throws.
   */
  prepare(partial: PartialWords): void {
    this.ahead.prepare(partial, this.gate, (input, variables) =>
      this.answersAhead(input)
        ? {
            input,
            history: peekHistory(this.conversation),
            variables,
            today: this.variables.today(),
            context: this.briefing(variables),
          }
        : undefined,
    );
    this.ahead.prepareLlm(partial, (input, variables) => this.llmAhead(input, variables));
  }

  /** Whether the turn would ask for an answer to these words at all (LAT-3, LAT-4). */
  private answersAhead(input: string): boolean {
    const { recovery } = this.lines;
    // An ended flow or an opt-out decides nothing more: the next turn only closes the call (P4).
    return !(
      this.flow?.state.ended ||
      this.optOut.optedOut ||
      // N4: words outside the agent's languages get its language line, never a decision.
      !this.languages.understands(input) ||
      this.confirmation.waiting ||
      recovery.replay(input) ||
      recovery.skipsDecision(input, this.inference !== undefined)
    );
  }

  /**
   * Wave 8: the turn's first LLM request for these words as the call stands now; undefined while
   * the agent is still speaking (its lines change the history), with passages to retrieve first,
   * or when the turn would not ask the LLM.
   */
  private llmAhead(input: string, variables: Record<string, unknown>): InferenceCall | undefined {
    if (this.ending.complete || this.grounding || this.conversation.speaking) return undefined;
    if (!this.answersAhead(input)) return undefined;
    const facts = flowFacts(this.flow, this.variables.facts(variables));
    return firstInferenceRequest({
      config: this.config,
      input,
      ...this.conversation.peek(),
      context: replyContext(this.briefing(variables), facts),
      tools: this.tools,
      results: [],
      previous: [...this.lines.recovery.lastSaid],
    });
  }

  /** The utterance whose reply started last (`TurnSpeculation.finalize`). */
  private finalized?: FinalUtterance;

  /** `TurnSpeculation.finalize`: `final.text` is the next `respond` input, on the same tick. */
  finalize(final: FinalUtterance): void {
    this.finalized = final;
    this.ahead.finalizeLlm(final);
  }

  /** `TurnSpeculation.discard`: utterance `turnId` will not be answered as it was heard. */
  discard(turnId: string, reason?: 'reset' | 'superseded'): void {
    this.gate?.discardPrepared(turnId);
    this.ahead.discardLlm(turnId);
    // AGT-10: its words come back inside the merged turn, so they leave the history here.
    if (reason === 'superseded' && this.finalized?.turnId === turnId) {
      this.conversation.withdraw(this.finalized.text);
      this.finalized = undefined;
    }
  }
}
