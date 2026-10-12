import type { TextFilter } from '@winsendotai/ovo-contracts';
import { MONTHS, ordinal } from './indian-verbalisation.ts';
import { spokenRanges, spokenSymbols } from './speech-ranges.ts';

export const SPEECH_NORMALISER_FILTER_ID = '@winsendotai/ovo-text-filter-speech-normaliser';

/**
 * Wave 9 D1 (Maya call 10d5ef30, 2026-10-12): the model writes for the eye, and the TTS (ElevenLabs
 * flash v2.5, whose own text normalisation is off and needs an Enterprise plan) reads it as
 * written: "December 21, 2026–January 5, 2027" and "seventy thousand rupees–one lakh rupees". This
 * rewrites English reply text for the ear before any speech cache key is computed: ranges get
 * "to" (or "between … and …" for amounts), a year the caller would assume is dropped, dates are
 * said day first with an ordinal for every English but en-US ("the 21st of December"), and the
 * symbols a TTS reads aloud become words. Deterministic for a given day, and idempotent: its own
 * output passes through unchanged, so running it twice (or on a segment and again on a join of
 * two) is safe.
 */
export interface SpeechNormaliserOptions {
  /** The call's clock, for the year a caller assumes; defaults to the wall clock. */
  now?: () => number;
}

// Capitalised only: "may" and "march" are also verbs, "Mar 5" is not.
// An abbreviation's dot only inside a sentence ("Dec. 21", "5 Dec. we fly"): "on 5 Dec. We
// fly" keeps the full stop that ends its sentence.
const MONTH = String.raw`(January|February|March|April|May|June|July|August|September|October|November|December|(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)(?:\.(?=\s[\d\p{Ll}]|,))?)`;
const ORDINAL = String.raw`(?:st|nd|rd|th)?`;
const DAY = String.raw`(\d{1,2})${ORDINAL}`;
const YEAR = String.raw`((?:19|20)\d{2})(?![\d:])`;
/** Hyphen, en dash or em dash between the two ends of a range, or "through". */
const RANGE_SEPARATOR = String.raw`\s*(?:[–—]|-|\s(?:to|through|thru|until)\s)\s*`;

type DateToken = {
  month: number;
  day?: number;
  /** A second day in the same month: "21–24 December". */
  until?: number;
  year?: number;
  /**
   * A date already written as it is said, "21st of December" or "the 5th of January": kept as the
   * model wrote it in every English, so only a range or a year around it changes.
   */
  said?: string;
};

function monthIndex(name: string): number {
  return MONTHS.findIndex((month) => month.startsWith(name.replace(/\.$/, '').slice(0, 3))) + 1;
}

function validDay(month: number, day: number | undefined): boolean {
  if (day === undefined) return true;
  const probe = new Date(Date.UTC(2024, month - 1, day));
  return day >= 1 && probe.getUTCMonth() === month - 1;
}

/**
 * The year said aloud, or undefined when the caller would assume it: a date from last month to
 * ten months ahead is the one they mean ("January 2027", said in October 2026, is "January"). Any
 * other year is kept, so "October 2027" never becomes this October.
 */
function spokenYear(token: DateToken, now: Date): number | undefined {
  if (token.year === undefined) return undefined;
  const ahead = token.year * 12 + token.month - (now.getUTCFullYear() * 12 + now.getUTCMonth() + 1);
  return ahead >= -1 && ahead <= 10 ? undefined : token.year;
}

/** A determiner already before the date: "the March 15 deadline" is not "the the 15th…". */
const DETERMINED = /\b(?:the|a|an|this|that|your|our|my|their|his|her)\s+$/i;

function renderDate(token: DateToken, now: Date, dayFirst: boolean, determined: boolean): string {
  if (token.said !== undefined) return token.said;
  const month = MONTHS[token.month - 1]!;
  const year = spokenYear(token, now);
  if (token.day === undefined) return year === undefined ? month : `${month} ${year}`;
  if (!dayFirst) {
    const days =
      token.until === undefined
        ? ordinal(token.day)
        : `${ordinal(token.day)} to ${ordinal(token.until)}`;
    return `${month} ${days}${year === undefined ? '' : `, ${year}`}`;
  }
  const the = determined ? '' : 'the ';
  const days =
    token.until === undefined
      ? `${the}${ordinal(token.day)}`
      : `${the}${ordinal(token.day)} to the ${ordinal(token.until)}`;
  return `${days} of ${month}${year === undefined ? '' : ` ${year}`}`;
}

/** A placeholder no reply text contains; the date it stands for is in `tokens`. */
const MARK = '\u0000';
const PLACEHOLDER = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');

const ISO_DATE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;
// "21/12/2026", "21-12-2026": day first, as everywhere but the US (which keeps these as written).
const NUMERIC_DATE = /(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})\2((?:19|20)\d{2})(?![\d/-]|\.\d)/g;
// "the 21st of December 2026", "21–24 December", "5 Jan".
const DAY_FIRST = new RegExp(
  String.raw`(?<![\d.,:/])(?:\bthe\s+)?${DAY}(?:${RANGE_SEPARATOR}(?:the\s+)?${DAY})?(?:\s+of)?\s+${MONTH}(?![\p{L}])(?:,?\s+${YEAR})?`,
  'gu',
);
// "December 21, 2026", "December 21st", "November 28–30, 2026".
const MONTH_FIRST = new RegExp(
  String.raw`(?<![\p{L}])${MONTH}\s+${DAY}(?![\d:])(?:\s*[–—-]\s*${DAY}(?![\d:]))?(?:,?\s+${YEAR})?(?![\p{L}])`,
  'gu',
);
// "December 2026", "January, 2027".
const MONTH_YEAR = new RegExp(String.raw`(?<![\p{L}])${MONTH},?\s+${YEAR}`, 'gu');

function tokenise(text: string, tokens: DateToken[], dayFirst: boolean): string {
  const keep = (token: DateToken, match: string, said = false) => {
    if (!token.month || !validDay(token.month, token.day) || !validDay(token.month, token.until))
      return match;
    if (token.until !== undefined && token.day !== undefined && token.until <= token.day)
      return match;
    tokens.push(said ? { ...token, said: match } : token);
    return `${MARK}${tokens.length - 1}${MARK}`;
  };
  const year = (value: string | undefined) => (value === undefined ? undefined : Number(value));
  const until = (value: string | undefined) => (value === undefined ? undefined : Number(value));
  const numeric = dayFirst
    ? text.replace(NUMERIC_DATE, (match, d: string, _separator, m: string, y: string) =>
        keep({ month: Number(m), day: Number(d), year: Number(y) }, match),
      )
    : text;
  return numeric
    .replace(ISO_DATE, (match, y: string, m: string, d: string) =>
      keep({ month: Number(m), day: Number(d), year: Number(y) }, match),
    )
    .replace(DAY_FIRST, (match, d: string, d2: string | undefined, m: string, y?: string) => {
      const said = !y && !d2 && MONTHS.includes(m) && /\d(?:st|nd|rd|th)\s+of\s/.test(match);
      return keep(
        { month: monthIndex(m), day: Number(d), until: until(d2), year: year(y) },
        match,
        said,
      );
    })
    .replace(MONTH_FIRST, (match, m: string, d: string, d2: string | undefined, y?: string) =>
      keep({ month: monthIndex(m), day: Number(d), until: until(d2), year: year(y) }, match),
    )
    .replace(MONTH_YEAR, (match, m: string, y: string) =>
      keep({ month: monthIndex(m), year: Number(y) }, match),
    );
}

/** Two dates, months or times joined by a dash or "through": the caller hears "to". */
const DATE_RANGE = new RegExp(
  String.raw`(${MARK}\d+${MARK})(?:\s*[–—]\s*|\s+-\s+|-|,?\s+(?:through|thru)\s+)(${MARK}\d+${MARK})`,
  'g',
);

export function normaliseSpeechText(
  text: string,
  language: string,
  options: SpeechNormaliserOptions = {},
): string {
  if (!/^en(?:-|$)/i.test(language) || !text) return text;
  const now = new Date((options.now ?? Date.now)());
  const dayFirst = !/^en-US$/i.test(language);
  const tokens: DateToken[] = [];
  let spoken = tokenise(text, tokens, dayFirst);
  if (tokens.length) spoken = spoken.replace(DATE_RANGE, '$1 to $2');
  spoken = spokenSymbols(spokenRanges(spoken));
  if (tokens.length)
    spoken = spoken.replace(PLACEHOLDER, (_match, index: string, offset: number, whole: string) =>
      renderDate(tokens[Number(index)]!, now, dayFirst, DETERMINED.test(whole.slice(0, offset))),
    );
  return spoken.replace(/ {2,}/g, ' ');
}

/** The normaliser as a text filter: order 25, after the markdown and URL filters, before Indian
 * verbalisation (30), which then speaks the rupee amounts and phone numbers. */
export function createSpeechNormaliserFilter(options: SpeechNormaliserOptions = {}): TextFilter {
  return {
    id: SPEECH_NORMALISER_FILTER_ID,
    order: 25,
    apply(text, ctx) {
      return normaliseSpeechText(text, ctx.language, options);
    },
  };
}

export const speechNormaliserFilter: TextFilter = createSpeechNormaliserFilter();
