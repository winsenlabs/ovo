import { normalizeForMatch, type AgentReplyPacing } from '@winsendotai/ovo-contracts';

/** Call-3 #7: how much of a long voice answer is said before the rest is offered. */
export const DEFAULT_REPLY_CAP = Object.freeze({
  maxSentences: 2,
  maxChars: 160,
  moreLine: 'Want more detail?',
});

/**
 * Wave 9 (Maya call 10d5ef30, issue D5): the default offers, taken in turn, so the caller does not
 * hear one line again and again (turns 9, 10, 14, 17 and 18 all ended "Want more detail?"). None
 * offers to look something up, so a bare yes to one is no reason to search (search-voice.ts).
 */
export const DEFAULT_MORE_LINES: readonly string[] = Object.freeze([
  DEFAULT_REPLY_CAP.moreLine,
  'Want to hear more?',
  'Would you like more on that?',
  'Interested in more detail?',
]);

/**
 * Wave 9 (D5): a reply that has said less than this is a short answer, which no offer follows:
 * its next sentence is said, up to twice `maxChars` in all. Call 10d5ef30 turn 17 said "You’re
 * right—you already said that." (35 characters) and then only "Want more detail?".
 */
const SHORT_ANSWER_CHARS = 60;
/** A short question the reply ends on instead of the offer: it keeps the conversation going. */
const MAX_CLOSING_QUESTION_CHARS = 120;
const SENTENCE_END = /[.!?।॥。！？؟۔…]["'”’»)\]]*$/u;
const QUESTION_END = /[?？؟]["'”’»)\]]*$/u;
const EVIDENCE_NOTE = /^\[Playback evidence: [a-z-]+\.\] /;

/** What the agent said before this reply, which decides whether and how it offers more (D5). */
export interface ReplyCapRecent {
  /** The lines of the agent's last turn. */
  lastSaid?: readonly string[];
  /** The conversation so far: the lines that played. */
  history?: readonly { role: string; content: string }[];
}

/**
 * Caps a long streamed answer on voice so the caller is not talked over (call 6e1a4e3a: 7 of 23
 * replies were cut by the caller, most of them long search answers). Sentences are spoken whole,
 * and the first always is. A later sentence is not started once `maxSentences` have been said, or
 * when it would take the reply past `maxChars` (after the first segment, the segmenter hands over
 * whole sentences, so its length is known). The reply then ends with `moreLine`, unless it already
 * ended on a question, or the sentence is a short question, which is said in its place. The caller
 * who wants the rest says so, and the model sees what was said. Off for an agent that does not
 * reply in English (`replyLanguage`, never the locale) and has no `moreLine` of its own, and with
 * `maxSentences` 0.
 * Wave 9 (D5): the offer is said at most every other turn: a reply right after one that offered
 * more stops at the same place with nothing after it. A short answer is never cut (see
 * `SHORT_ANSWER_CHARS`), and the default offer goes round `DEFAULT_MORE_LINES`.
 */
export class ReplyCap {
  private sentences = 0;
  private chars = 0;
  /** The last segment spoken ended mid-sentence. */
  private open = false;
  private question = false;
  private readonly limits?: { maxSentences: number; maxChars: number; moreLine?: string };

  constructor(pacing: AgentReplyPacing = {}, replyLanguage: string, recent: ReplyCapRecent = {}) {
    const lines = pacing.moreLine
      ? [pacing.moreLine]
      : /^en\b/iu.test(replyLanguage)
        ? DEFAULT_MORE_LINES
        : undefined;
    const maxSentences = pacing.maxSentences ?? DEFAULT_REPLY_CAP.maxSentences;
    if (lines && maxSentences > 0)
      this.limits = {
        maxSentences,
        maxChars: pacing.maxChars ?? DEFAULT_REPLY_CAP.maxChars,
        ...(offered(lines, recent.lastSaid ?? []) ? {} : { moreLine: nextLine(lines, recent) }),
      };
  }

  /**
   * What to say for the next spoken segment: `say` (it, the closing question, or the offer), and
   * whether the reply stops there.
   */
  next(segment: string): { say?: string; stop: boolean } {
    const limits = this.limits;
    if (limits && !this.open && this.sentences > 0 && this.full(segment, limits)) {
      const asks = SENTENCE_END.test(segment) && QUESTION_END.test(segment);
      if (asks && segment.length <= MAX_CLOSING_QUESTION_CHARS) return { say: segment, stop: true };
      return this.question || !limits.moreLine
        ? { stop: true }
        : { say: limits.moreLine, stop: true };
    }
    this.chars += segment.length;
    this.open = !SENTENCE_END.test(segment);
    if (!this.open) {
      this.sentences += 1;
      this.question = QUESTION_END.test(segment);
    }
    return { say: segment, stop: false };
  }

  /** `segment` would take the reply past its limits. */
  private full(segment: string, limits: { maxSentences: number; maxChars: number }): boolean {
    if (this.sentences >= limits.maxSentences) return true;
    const chars = this.chars + segment.length;
    if (chars <= limits.maxChars) return false;
    return this.chars >= SHORT_ANSWER_CHARS || chars > 2 * limits.maxChars;
  }
}

/** Whether one of `lines` ended the agent's last turn. */
function offered(lines: readonly string[], lastSaid: readonly string[]): boolean {
  const offers = new Set(lines.map(normalizeForMatch));
  return lastSaid.some((line) => offers.has(normalizeForMatch(line)));
}

/** The offer after the one the conversation last heard, or the first. */
function nextLine(lines: readonly string[], recent: ReplyCapRecent): string {
  const keys = lines.map(normalizeForMatch);
  const heard = [...(recent.history ?? [])]
    .reverse()
    .filter((entry) => entry.role === 'assistant')
    .map((entry) => keys.indexOf(normalizeForMatch(entry.content.replace(EVIDENCE_NOTE, ''))))
    .find((index) => index >= 0);
  return lines[heard === undefined ? 0 : (heard + 1) % lines.length]!;
}
