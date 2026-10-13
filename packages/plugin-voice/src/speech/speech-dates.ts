import { MONTHS, ordinal } from './indian-verbalisation.ts';

/*
 * Wave 9 D1: how a date the speech normaliser found is said (`speech-normaliser.ts` finds them):
 * day first with an ordinal in every English but en-US, a year the caller would assume dropped,
 * a range with "to", and (Wave 10, B4) a choice or a pair of days with "or" and "and".
 */

export type DateToken = {
  month: number;
  day?: number;
  /** A second day in the same month: "21–24 December". */
  until?: number;
  /** How `until` joins `day`: a range ("to", the default), a choice ("or") or both ("and"). */
  join?: 'or' | 'and';
  year?: number;
  /**
   * A date already written as it is said, "21st of December" or "the 5th of January": kept as the
   * model wrote it in every English, so only a range or a year around it changes.
   */
  said?: string;
  /** Written day first with "of" ("the 21st of December 2026"): en-US keeps that order too. */
  ofForm?: boolean;
};

export function monthIndex(name: string): number {
  return MONTHS.findIndex((month) => month.startsWith(name.replace(/\.$/, '').slice(0, 3))) + 1;
}

export function validDay(month: number, day: number | undefined): boolean {
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
export const DETERMINED = /\b(?:the|a|an|this|that|your|our|my|their|his|her)\s+$/i;

export function renderDate(
  token: DateToken,
  now: Date,
  dayFirst: boolean,
  determined: boolean,
): string {
  if (token.said !== undefined) return token.said;
  const month = MONTHS[token.month - 1]!;
  const year = spokenYear(token, now);
  if (token.day === undefined) return year === undefined ? month : `${month} ${year}`;
  const join = token.join ?? 'to';
  if (!dayFirst && !token.ofForm) {
    const days =
      token.until === undefined
        ? ordinal(token.day)
        : `${ordinal(token.day)} ${join} ${ordinal(token.until)}`;
    return `${month} ${days}${year === undefined ? '' : `, ${year}`}`;
  }
  const the = determined ? '' : 'the ';
  // A choice or a pair is said with one "the": "the 20th or 21st of December".
  const second = token.join ? '' : 'the ';
  const days =
    token.until === undefined
      ? `${the}${ordinal(token.day)}`
      : `${the}${ordinal(token.day)} ${join} ${second}${ordinal(token.until)}`;
  return `${days} of ${month}${year === undefined ? '' : ` ${year}`}`;
}
