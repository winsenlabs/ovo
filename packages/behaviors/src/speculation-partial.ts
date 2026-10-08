import { callerWords, normalizeForMatch, type Inference } from '@winsendotai/ovo-contracts';
import { endsSentence } from './speculation.ts';
import {
  callerMatchKey,
  SpeculativeLlm,
  type InferenceCall,
  type LlmSpeculationMetrics,
} from './speculation-llm.ts';
import type { SpeculationPolicy } from './speculation-policy.ts';

type Policy = Pick<
  SpeculationPolicy,
  'llmDebounceMs' | 'llmMinWords' | 'partialEnding' | 'llmMaxPartialCalls'
>;

interface Asked {
  turnId: string;
  words: string;
  call: SpeculativeLlm;
}

/**
 * Wave 8 (latency fix 4): the LLM asked on the caller's partial transcript, for an agent without
 * a decision model, so the first token (and any web search the model starts, since the request
 * carries the same tools) is under way before the turn ends. In the Maya calls a one-word answer's
 * last partial arrived 1.6-1.9 s before its turn ended, and a sentence's 0.2-1.0 s.
 *
 * A revisable partial must hold `llmDebounceMs` unchanged, carry `llmMinWords` words and end a
 * sentence (`partialEnding: 'sentence'`; unlike a decision, an STT that never punctuates its
 * partials gets no LLM call on them: early fragments would use up the budget), and an utterance is
 * asked about at most `llmMaxPartialCalls` times. Words the STT will not revise are asked
 * at once. The request is built when the call starts, from the conversation as it is then, and
 * never while the agent is still speaking: its lines would change the history the turn sends.
 *
 * At most one call is in flight: newer words abort it. The turn takes it (`take`) and uses it only
 * when its own first request is the same (`SpeculativeLlm.inference`); otherwise it is aborted, so
 * speculation can make a turn faster but never change what it says.
 */
export class PartialLlmSpeculation {
  private asked?: Asked;
  private timer?: ReturnType<typeof setTimeout>;
  /** The utterance whose words wait out the debounce. */
  private offered?: string;
  /** Calls started on the revisable partials of utterance `turnId`. */
  private partialCalls = { turnId: '', count: 0 };

  constructor(
    private readonly policy: Policy,
    private readonly llm: Inference,
    private readonly metrics: LlmSpeculationMetrics,
  ) {}

  /**
   * The caller's words so far. `request` builds the turn's first request for them as the call
   * stands when the debounce ends, or undefined when the turn would not ask the LLM.
   */
  offer(turnId: string, text: string, stable: boolean, request: () => InferenceCall | undefined) {
    if (!normalizeForMatch(text)) return;
    const words = callerMatchKey(text);
    this.clearOffer();
    if (this.asked?.words === words && this.asked.call.pending) return;
    if (callerWords(text).length < this.policy.llmMinWords) return;
    if (!stable && !this.worthAsking(turnId, text)) return;
    const start = () => this.start(turnId, words, !stable, request);
    if (stable) return start();
    this.offered = turnId;
    this.timer = setTimeout(() => {
      this.clearOffer();
      start();
    }, this.policy.llmDebounceMs);
  }

  /**
   * The engine is about to answer `text` for utterance `turnId`: a call asked on other words is
   * aborted now, before the turn starts, so no search line is announced for it.
   */
  finalize(turnId: string, text: string): void {
    this.clearOffer();
    const asked = this.asked;
    if (asked && (asked.turnId !== turnId || asked.words !== callerMatchKey(text)))
      this.drop('superseded by the final transcript');
  }

  /** The call for the turn that is starting, if any; whatever it does not use, it aborts. */
  take(): SpeculativeLlm | undefined {
    this.clearOffer();
    const call = this.asked?.call;
    this.asked = undefined;
    return call?.pending ? call : undefined;
  }

  /** Utterance `turnId` will not be answered as it was heard: nothing is asked for it. */
  discard(turnId: string): void {
    if (this.offered === turnId) this.clearOffer();
    if (this.asked?.turnId === turnId) this.drop('utterance discarded');
  }

  /**
   * The agent's reply was cut or a turn superseded: a call already asked saw another history. Words
   * still waiting out the debounce are kept: they are the caller's barge-in, and the request is
   * built from the conversation as it stands when the debounce ends (dropping them cost 3.2 of the
   * 8.1 s saved in the Maya replay). The engine ends a call by discarding the open utterance
   * (`discard`), which drops them, before it cancels.
   */
  cancel(): void {
    this.drop('the call moved on');
  }

  private start(
    turnId: string,
    words: string,
    revisable: boolean,
    request: () => InferenceCall | undefined,
  ): void {
    if (revisable && this.used(turnId) >= this.policy.llmMaxPartialCalls) return;
    // Older words in flight cannot be what the turn asks now that newer ones have held.
    this.drop('newer words from the caller');
    let call: InferenceCall | undefined;
    try {
      call = request();
    } catch {
      // swallow-ok: the turn builds the same request itself and handles the failure there.
      return;
    }
    if (!call) return;
    const llm = this.llm;
    this.metrics.onPartials += 1;
    if (revisable) this.count(turnId);
    this.asked = {
      turnId,
      words,
      call: new SpeculativeLlm(llm, call, Boolean(llm.stream), undefined, this.metrics),
    };
  }

  private worthAsking(turnId: string, text: string): boolean {
    if (this.policy.partialEnding === 'sentence' && !endsSentence(text)) return false;
    return this.used(turnId) < this.policy.llmMaxPartialCalls;
  }

  private used(turnId: string): number {
    return this.partialCalls.turnId === turnId ? this.partialCalls.count : 0;
  }

  private count(turnId: string): void {
    if (this.partialCalls.turnId !== turnId) this.partialCalls = { turnId, count: 0 };
    this.partialCalls.count += 1;
  }

  private drop(reason: string): void {
    this.asked?.call.discard(reason);
    this.asked = undefined;
  }

  private clearOffer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.offered = undefined;
  }
}
