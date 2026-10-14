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
/**
 * Wave 12 (F7): what the cap held back, when it is no longer than this, is said instead of the
 * offer: "Otherwise, you can connect through Oslo." is not worth "Want to hear more?".
 */
const SHORT_TAIL_CHARS = 80;
/**
 * Wave 12 (F7): a held tail that ends on a question is said whole up to this length, the question
 * with what it asks about. A question is never said without the held sentences before it: "Which
 * of the two would you prefer?" after two flights the cap held back cannot be answered.
 */
const SHORT_QUESTION_TAIL_CHARS = 120;
/** A short question the cap stops before is said in place of the offer (call-3 #7). */
const MAX_CLOSING_QUESTION_CHARS = 120;
const SENTENCE_END = /[.!?।॥。！？؟۔…]["'”’»)\]]*$/u;
const QUESTION_END = /[?？؟]["'”’»)\]]*$/u;
const EVIDENCE_NOTE = /^\[Playback evidence: [a-z-]+\.\] /;

/** What the agent said before this reply, which decides whether and how it offers more (D5). */
export interface ReplyCapRecent {
  /** The lines of the agent's last turn. */
  lastSaid?: readonly string[];
  /**
   * Wave 12 (F7): the lines of its last three turns, the last included; when given, read instead
   * of `lastSaid` for an offer already made.
   */
  recentSaid?: readonly string[];
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
 * Wave 12 (Maya call 8cb76efc, F7): "every other turn" counted only the turn before, so with a
 * reply between that offered nothing (an ask-again, a closing question of the model's own) the
 * offer came back on turns 13, 19, 25, 28 and 30, and nearly every answer ended on one or on a
 * question. It is now said only when none of the agent's last three turns offered more
 * (`ReplyCapRecent.recentSaid`).
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
        ...(offered(lines, recent.recentSaid ?? recent.lastSaid ?? [])
          ? {}
          : { moreLine: nextLine(lines, recent) }),
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

  /**
   * Wave 12 (F7): what the cap held back (`held`, its speakable lines) is short enough to say
   * instead of offering, all of it. One that ends on a question may be a little longer: the model's
   * own question keeps the conversation going, but only with what it asks about. Turn 16's "…would
   * you like to start with how Yugoslavia formed?" came after a held "I can walk you through the
   * background, the breakup, and the aftermath step by step", so neither is said.
   */
  shortTail(held: readonly string[]): boolean {
    const text = held.join(' ').trim();
    if (text.length <= SHORT_TAIL_CHARS) return true;
    return QUESTION_END.test(text) && text.length <= SHORT_QUESTION_TAIL_CHARS;
  }

  /**
   * `segment` would take the reply past its limits. Wave 12 (Maya call 8cb76efc, F7): sentences
   * count only once the reply has said `SHORT_ANSWER_CHARS`. Turn 13 said "You’re right, you did."
   * and "I’m sorry." (32 characters, two sentences), then "Want more detail?" in place of the
   * answer it had begun.
   */
  private full(segment: string, limits: { maxSentences: number; maxChars: number }): boolean {
    if (this.sentences >= limits.maxSentences && this.chars >= SHORT_ANSWER_CHARS) return true;
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
