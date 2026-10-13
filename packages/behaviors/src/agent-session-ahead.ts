import type { FinalUtterance, Inference } from '@winsendotai/ovo-contracts';
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
  async respond(input: string, variables: Record<string, unknown> = {}): Promise<string> {
    const segments: string[] = [];
    for await (const segment of this.runResponse(input, false, variables)) segments.push(segment);
    return segments.join(' ');
  }

  respondStream(input: string, variables: Record<string, unknown> = {}): AsyncIterable<string> {
    return this.runResponse(input, true, variables);
  }

  /** Wave 8: with the LLM call asked on the turn's partial words, used if it asks the same. */
  private runResponse(input: string, streaming: boolean, variables: Record<string, unknown>) {
    return this.ahead.withLlm((asked) => this.answer(input, streaming, variables, asked));
  }

  /** The turn itself (`AgentBehavior`), given the call asked on its partial words, if any. */
  protected abstract answer(
    input: string,
    streaming: boolean,
    variables: Record<string, unknown>,
    asked: Inference | undefined,
  ): AsyncIterable<string>;

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
      // Wave 10 (L2): a plain yes or no to "Shall I end the call?" is answered without either.
      this.endGate.answeredAsk(input, {}, this.lines.recovery.lastSaid) !== undefined ||
      recovery.replay(input) ||
      recovery.skipsDecision(input, this.inference !== undefined)
    );
  }

  /**
   * Wave 8: the turn's first LLM request for these words as the call stands now; undefined while
   * the agent is still speaking (its lines change the history), with passages to retrieve first,
   * or when the turn would not ask the LLM.
   * Wave 10 (Maya call 4f1a919d, B1/B2): nor while the agent still owes the caller's earlier words
   * a reply: its lines, or the merge of both utterances, change the history too. Live, "Madras."
   * was asked ahead while the reply to "Chennai, Chennai." searched; it searched as well (5.1 s,
   * 9,647 tokens, billed) and was thrown away, and having searched for the words it left their
   * own turn no search tool.
   */
  private llmAhead(input: string, variables: Record<string, unknown>): InferenceCall | undefined {
    if (this.ending.complete || this.grounding || this.conversation.speaking) return undefined;
    const now = this.conversation.peek();
    if (now.history.at(-1)?.role === 'user' || !this.answersAhead(input)) return undefined;
    const facts = flowFacts(this.flow, this.variables.facts(variables));
    return firstInferenceRequest({
      config: this.config,
      input,
      ...now,
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
