import { quoteOpen } from './sentence-boundary.ts';

/** The first segment of a reply with no clause mark yet is cut after this many words (LAT-9). */
export const DEFAULT_FIRST_PHRASE_WORDS = 10;
/** From this many words on, the first segment is also cut before a word that opens a phrase. */
const PHRASE_START_WORDS = 6;

/** Words that open a phrase: a break before one is where a speaker pauses anyway. */
const OPENERS = new Set(
  [
    'and but or so because since although though while when where which who whose that if unless',
    'until then to for with from about after before during like at in on by',
    // Hinglish written in Latin script.
    'aur lekin toh ki kyunki jab agar phir',
  ]
    .join(' ')
    .split(' '),
);

/** A phrase never ends on one of these: "your EMI is | due" or "the | fifth" sounds cut. */
const BINDING = new Set([
  ...OPENERS,
  ...'a an the of my your his her its our their this these those'.split(' '),
  ...'is are was were am be been will would can could should shall may might must'.split(' '),
  ...'have has had do does did not very just'.split(' '),
]);

/** Spoken numbers: "two thousand | five hundred" is one amount. */
const NUMBER_WORDS = new Set(
  [
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen',
    'sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety',
    'hundred thousand lakh lakhs crore crores million billion point',
  ]
    .join(' ')
    .split(' '),
);

/** Titles that belong to the name after them. */
const TITLES = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'shri', 'sri', 'smt', 'sir', 'madam']);

/** A word the segment would end on, then the one after it (which may still be streaming in). */
interface Break {
  /** Where the segment ends: just after `before`. */
  end: number;
  /** Words in the segment. */
  count: number;
  before: string;
  after: string;
  /** Whether `after` is whole: "to" may yet stream on into "today". */
  whole: boolean;
}

/** Every break between two words of `text` whose segment ends by `maximum`. */
function breaks(text: string, maximum: number): Break[] {
  const words = [...text.matchAll(/\S+/gu)];
  const found: Break[] = [];
  for (let index = 0; index + 1 < words.length; index += 1) {
    const word = words[index]!;
    const end = word.index + word[0].length;
    if (end > maximum) break;
    const next = words[index + 1]!;
    const whole = next.index + next[0].length < text.length;
    found.push({ end, count: index + 1, before: word[0], after: next[0], whole });
  }
  return found;
}

const bare = (word: string) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const capitalised = (word: string) => /^[^\p{L}\p{N}]*\p{Lu}/u.test(word);

/**
 * True where a cut would split something the caller hears as one unit: an amount, a date or a
 * phone number ("4,500 | rupees", "ending 4 2 | 1 3", "two thousand | five hundred"), a name
 * ("Rahul | Sharma", "Mr. | Sharma"), a quote or a bracket still open, or a phrase left hanging on
 * a word that binds to the next ("the | fifth", "is | due").
 */
function unsafe(text: string, at: Break): boolean {
  const before = bare(at.before);
  const after = bare(at.after);
  if (/\d/u.test(at.before) || /\d/u.test(at.after)) return true;
  if (NUMBER_WORDS.has(before) || NUMBER_WORDS.has(after)) return true;
  if (TITLES.has(before) || (capitalised(at.before) && capitalised(at.after))) return true;
  if (BINDING.has(before) || /^[^\p{L}\p{N}]/u.test(at.after)) return true;
  const head = text.slice(0, at.end);
  return quoteOpen(head) || (head.match(/\[/g)?.length ?? 0) > (head.match(/\]/g)?.length ?? 0);
}

/**
 * Where the first segment of a reply ends when no clause mark or sentence end has come yet, or
 * undefined to wait for more text: before a word that opens a phrase once it holds six words, or
 * at any safe break once it holds `capWords` (0: never). A break needs the next word to have
 * started streaming, so the word before it is whole.
 */
export function phraseBoundary(
  text: string,
  maximum: number,
  capWords: number,
): number | undefined {
  if (capWords <= 0) return undefined;
  const from = Math.min(PHRASE_START_WORDS, capWords);
  for (const at of breaks(text, maximum)) {
    if (at.count < from || unsafe(text, at)) continue;
    if (at.count >= capWords || (at.whole && OPENERS.has(bare(at.after)))) return at.end;
  }
  return undefined;
}

/**
 * The last break by `maximum` that splits nothing (see `unsafe`) and leaves at least `minWords`
 * words before it: where an over-long first segment is cut instead of mid-word or mid-amount.
 */
export function lastSafeBreak(text: string, maximum: number, minWords: number): number | undefined {
  let last: number | undefined;
  for (const at of breaks(text, maximum))
    if (at.count >= Math.max(1, minWords) && !unsafe(text, at)) last = at.end;
  return last;
}
