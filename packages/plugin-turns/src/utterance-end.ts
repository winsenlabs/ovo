import {
  classifyConfirmation,
  countWords,
  isBackchannel,
  normalizeForMatch,
  type TurnConfig,
} from '@winsendotai/ovo-contracts';
import { endsCutOff } from './transcript-text.ts';

/**
 * How the caller's words so far end (Wave 8 smart end-of-turn). `complete` ends the turn on the
 * short silence; `unfinished` waits for the caller to go on; `open` (no signal either way) keeps
 * the wait by length.
 */
export type UtteranceEnd = 'complete' | 'unfinished' | 'open';

export interface UtteranceContext {
  language: string;
  backchannels: TurnConfig['backchannels'];
  /** The agent's last line asked the caller something: a short reply is an answer to it. */
  answering: boolean;
}

/** The most words a short answer ("Yes.", "Theek hai.", "Oh, my God.") has. */
export const SHORT_ANSWER_WORDS = 3;

/** Sentence-final punctuation as STTs write it, closing quotes and brackets allowed after it. */
const SENTENCE_END = /[.?!।॥？！。]["'”’)\]]*$/u;
/** A list or a clause still going: "Paris, Rome," or "two things:". */
const LIST_GOING = /[,;:،、]["'”’)\]]*$/u;
/** A currency sign before the closing number: "₹500" may go on ("₹500 and 20 paise"). */
const CURRENCY_GOING = /[₹$€£]\s*[\p{N},.]*\p{N}$/u;

const words = (...groups: string[]) => new Set(groups.flatMap((group) => group.split(' ')));
/**
 * Words no utterance ends on, even when the STT put a full stop after them: conjunctions,
 * articles, possessives and hesitations, in English, Hinglish and Devanagari Hindi.
 */
const NEVER_LAST = words(
  'and but or nor because cause the an my your our their um uh er erm',
  'aur lekin magar kyunki kyonki matlab',
  'और लेकिन मगर क्योंकि मतलब',
);
/**
 * Words an utterance with no closing punctuation is still going after: prepositions, month names
 * and Hindi case markers ("I want to go to", "leave on December", "mera naam ki"). A question can
 * end on one ("Where are you from?"), so they count only before the STT has closed the sentence.
 */
const MONTHS = 'january february march april june july august september october november december';
const NOT_LAST = words(
  'a to for in on at of with from about around into than like if',
  MONTHS,
  'ki ka ke ko jo',
  'का की के को जो कि या',
);
/**
 * Words after which a closing number with no punctuation is a date, an ordinal or an amount still
 * being said: "around the 1" ("st." follows), "around 2", "on December 2", "Rs 500".
 */
const BEFORE_NUMBER = words(
  'the around about on by at till until from before after between to of rs inr',
  MONTHS,
);
/** Short replies that answer by themselves, beyond the agent's backchannel list. */
const ANSWERS = new Set(
  [
    'no',
    'no no',
    'nope',
    'nah',
    'not really',
    'nahi',
    'nahin',
    'na',
    'नहीं',
    'ना',
    'hello',
    'hi',
    'hey',
    'हेलो',
    'हैलो',
    'thanks',
    'thank you',
    'bye',
    'see you',
    'oh my god',
  ].map(normalizeForMatch),
);

/** How `text` ends; see UtteranceEnd. */
export function utteranceEnd(text: string, context: UtteranceContext): UtteranceEnd {
  const trimmed = text.trim();
  const tokens = normalizeForMatch(trimmed).split(' ').filter(Boolean);
  if (!tokens.length) return 'open';
  // Broken off mid-word or trailing off ("tell me for-", "is a..."), or a list still going.
  if (endsCutOff(trimmed) || LIST_GOING.test(trimmed)) return 'unfinished';
  const last = tokens.at(-1)!;
  if (NEVER_LAST.has(last)) return 'unfinished';
  if (SENTENCE_END.test(trimmed)) return 'complete';
  if (isAnswer(tokens, context)) return 'complete';
  // Call 6e1a4e3a turn 17: "…be back around the 1" and "st." became two turns.
  if (NOT_LAST.has(last) || numberGoing(trimmed, tokens)) return 'unfinished';
  if (context.answering && countWords(trimmed, context.language) <= SHORT_ANSWER_WORDS)
    return 'complete';
  return 'open';
}

function numberGoing(text: string, tokens: readonly string[]): boolean {
  if (!/\p{N}$/u.test(text)) return false;
  if (CURRENCY_GOING.test(text)) return true;
  const before = tokens.at(-2);
  return before !== undefined && BEFORE_NUMBER.has(before);
}

function isAnswer(tokens: readonly string[], context: UtteranceContext): boolean {
  const phrase = tokens.join(' ');
  if (ANSWERS.has(phrase) || classifyConfirmation(phrase) === 'yes') return true;
  // A count or a day ("2", "15") said alone; longer numbers are being read out.
  if (/^\p{N}{1,3}$/u.test(phrase)) return true;
  return isBackchannel(phrase, context.language, {
    backchannels: context.backchannels,
    backchannelsEnabled: true,
    minWordsWhileBotSpeaking: 0,
  });
}
