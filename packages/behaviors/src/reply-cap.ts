import type { AgentReplyPacing } from '@winsendotai/ovo-contracts';

/** Call-3 #7: how much of a long voice answer is said before the rest is offered. */
export const DEFAULT_REPLY_CAP = Object.freeze({
  maxSentences: 2,
  maxChars: 160,
  moreLine: 'Want more detail?',
});

/** A short question the reply ends on instead of the offer: it keeps the conversation going. */
const MAX_CLOSING_QUESTION_CHARS = 120;
const SENTENCE_END = /[.!?।॥。！？؟۔…]["'”’»)\]]*$/u;
const QUESTION_END = /[?？؟]["'”’»)\]]*$/u;

/**
 * Caps a long streamed answer on voice so the caller is not talked over (call 6e1a4e3a: 7 of 23
 * replies were cut by the caller, most of them long search answers). Sentences are spoken whole,
 * and the first always is. A later sentence is not started once `maxSentences` have been said, or
 * when it would take the reply past `maxChars` (after the first segment, the segmenter hands over
 * whole sentences, so its length is known). The reply then ends with `moreLine`, unless it already
 * ended on a question, or the sentence is a short question, which is said in its place. The caller
 * who wants the rest says so, and the model sees what was said. Off for a non-English agent with
 * no `moreLine` of its own, and with `maxSentences` 0.
 */
export class ReplyCap {
  private sentences = 0;
  private chars = 0;
  /** The last segment spoken ended mid-sentence. */
  private open = false;
  private question = false;
  private readonly limits?: { maxSentences: number; maxChars: number; moreLine: string };

  constructor(pacing: AgentReplyPacing = {}, language: string) {
    const moreLine =
      pacing.moreLine ?? (/^en\b/iu.test(language) ? DEFAULT_REPLY_CAP.moreLine : undefined);
    const maxSentences = pacing.maxSentences ?? DEFAULT_REPLY_CAP.maxSentences;
    if (moreLine && maxSentences > 0)
      this.limits = {
        maxSentences,
        maxChars: pacing.maxChars ?? DEFAULT_REPLY_CAP.maxChars,
        moreLine,
      };
  }

  /**
   * What to say for the next spoken segment: `say` (it, the closing question, or the offer), and
   * whether the reply stops there.
   */
  next(segment: string): { say?: string; stop: boolean } {
    const limits = this.limits;
    if (
      limits &&
      !this.open &&
      this.sentences > 0 &&
      (this.sentences >= limits.maxSentences || this.chars + segment.length > limits.maxChars)
    ) {
      const asks = SENTENCE_END.test(segment) && QUESTION_END.test(segment);
      if (asks && segment.length <= MAX_CLOSING_QUESTION_CHARS) return { say: segment, stop: true };
      return this.question ? { stop: true } : { say: limits.moreLine, stop: true };
    }
    this.chars += segment.length;
    this.open = !SENTENCE_END.test(segment);
    if (!this.open) {
      this.sentences += 1;
      this.question = QUESTION_END.test(segment);
    }
    return { say: segment, stop: false };
  }
}
