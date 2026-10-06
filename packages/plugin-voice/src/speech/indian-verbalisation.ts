import type { TextFilter } from '@winsendotai/ovo-contracts';

export const INDIAN_VERBALISATION_FILTER_ID = '@winsendotai/ovo-text-filter-indian-verbalisation';

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function twoDigits(n: number): string {
  return n < 20 ? ONES[n]! : TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : '');
}

function threeDigits(n: number, joinAnd: boolean): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rest) parts.push((hundreds || joinAnd ? 'and ' : '') + twoDigits(rest));
  return parts.join(' ');
}

/** Indian grouping, the way an agent in India says it: crore, lakh, thousand, hundred. */
export function indianNumberWords(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Expected a whole number');
  if (value === 0) return 'zero';
  let n = value;
  const crore = Math.floor(n / 1e7);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  n %= 1e5;
  const thousand = Math.floor(n / 1e3);
  n %= 1e3;
  const parts: string[] = [];
  if (crore) parts.push(`${indianNumberWords(crore)} crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} thousand`);
  if (n) parts.push(threeDigits(n, parts.length > 0 && n < 100));
  return parts.join(' ');
}

const digitWords = (digits: string) => [...digits].map((digit) => ONES[Number(digit)]).join(' ');

function rupees(whole: string, fraction: string | undefined): string | undefined {
  const units = Number(whole.replace(/,/g, ''));
  if (!Number.isSafeInteger(units)) return undefined;
  const paise = fraction ? Number(fraction.padEnd(2, '0')) : 0;
  const spokenPaise = `${indianNumberWords(paise)} ${paise === 1 ? 'paisa' : 'paise'}`;
  if (units === 0 && paise) return spokenPaise;
  const spoken = `${indianNumberWords(units)} ${units === 1 ? 'rupee' : 'rupees'}`;
  return paise ? `${spoken} and ${spokenPaise}` : spoken;
}

function scaled(whole: string, fraction: string | undefined, scale: string): string | undefined {
  const units = Number(whole.replace(/,/g, ''));
  if (!Number.isSafeInteger(units)) return undefined;
  const point = fraction ? ` point ${digitWords(fraction)}` : '';
  return `${indianNumberWords(units)}${point} ${scale.toLowerCase()} rupees`;
}

const AMOUNT = String.raw`(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d{1,2}))?`;
const PREFIXED = new RegExp(
  String.raw`(?:₹|\bRs\.?|\bINR)\s?${AMOUNT}(?!\d)(?:\s+(lakhs?|crores?|thousand)\b)?(?:\s?\/-)?`,
  'gi',
);
const SUFFIXED = new RegExp(String.raw`(?<![\d.,])${AMOUNT}\s?(rupees?)\b`, 'gi');

function currency(text: string): string {
  return text
    .replace(PREFIXED, (match, whole: string, fraction?: string, scale?: string) =>
      scale
        ? (scaled(whole, fraction, scale.replace(/s$/i, '')) ?? match)
        : (rupees(whole, fraction) ?? match),
    )
    .replace(
      SUFFIXED,
      (match, whole: string, fraction?: string) => rupees(whole, fraction) ?? match,
    );
}

function ordinal(day: number): string {
  const suffix =
    day % 100 >= 11 && day % 100 <= 13
      ? 'th'
      : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th');
  return `${day}${suffix}`;
}

function yearWords(year: number): string {
  if (year >= 2000 && year < 2010)
    return year === 2000 ? 'two thousand' : `two thousand ${ONES[year - 2000]}`;
  const century = Math.floor(year / 100);
  const rest = year % 100;
  if (century >= 10 && century <= 99)
    return `${twoDigits(century)} ${rest === 0 ? 'hundred' : rest < 10 ? `oh ${ONES[rest]}` : twoDigits(rest)}`;
  return indianNumberWords(year);
}

function spokenDate(day: number, month: number, year?: number): string | undefined {
  if (month < 1 || month > 12 || day < 1) return undefined;
  const probe = new Date(Date.UTC(year ?? 2000, month - 1, day));
  if (probe.getUTCMonth() !== month - 1) return undefined;
  const base = `the ${ordinal(day)} of ${MONTHS[month - 1]}`;
  return year === undefined ? base : `${base}, ${yearWords(year)}`;
}

const MONTH_NAME = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`;
// A sentence may end right after a date ("due on 05/10/2026."), so a trailing period is allowed.
const NUMERIC_DATE = /(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\d/-]|\.\d)/g;
const ISO_DATE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;
const NAMED_DATE = new RegExp(
  // Not after "the": that is already the spoken form, including this filter's own output.
  String.raw`(?<!\d|\bthe )(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?[\s-]+${MONTH_NAME}\.?(?:,?[\s-]+(\d{4}))?(?![\w])`,
  'gi',
);

function monthIndex(name: string): number {
  return (
    MONTHS.findIndex(
      (month) => month.slice(0, 3).toLowerCase() === name.slice(0, 3).toLowerCase(),
    ) + 1
  );
}

function dates(text: string): string {
  return text
    .replace(
      ISO_DATE,
      (match, year: string, month: string, day: string) =>
        spokenDate(Number(day), Number(month), Number(year)) ?? match,
    )
    .replace(
      NUMERIC_DATE,
      (match, day: string, _separator, month: string, year: string) =>
        spokenDate(Number(day), Number(month), Number(year.length === 2 ? `20${year}` : year)) ??
        match,
    )
    .replace(
      NAMED_DATE,
      (match, day: string, month: string, year?: string) =>
        spokenDate(Number(day), monthIndex(month), year ? Number(year) : undefined) ?? match,
    );
}

const digitsOf = (match: string) => match.replace(/\D/g, '');
const PHONES: readonly { pattern: RegExp; groups: (match: string) => string[] }[] = [
  {
    pattern: /(?<![\w+])\+91[\s-]?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g,
    groups: (match) => {
      const digits = digitsOf(match).slice(2);
      return ['+91', digits.slice(0, 5), digits.slice(5)];
    },
  },
  {
    pattern: /(?<![\w+])1800[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g,
    groups: (match) => {
      const digits = digitsOf(match);
      return [digits.slice(0, 4), digits.slice(4, 7), digits.slice(7)];
    },
  },
  {
    pattern: /(?<![\w+])[6-9]\d{4}[\s-]?\d{5}(?!\d)/g,
    groups: (match) => {
      const digits = digitsOf(match);
      return [digits.slice(0, 5), digits.slice(5)];
    },
  },
  { pattern: /(?<![\w+])0\d{2,4}[\s-]\d{6,8}(?!\d)/g, groups: (match) => match.split(/[\s-]/) },
];

/** Phone numbers digit by digit, with a pause between the groups a person would read. */
function phones(text: string): string {
  for (const phone of PHONES)
    text = text.replace(phone.pattern, (match) =>
      phone
        .groups(match)
        .map((group) => (group === '+91' ? 'plus nine one' : digitWords(group)))
        .join(', '),
    );
  return text;
}

/**
 * Writes Indian amounts, dates and phone numbers out the way an agent in India says them, so the
 * provider never guesses ("₹1,23,450" is not "one hundred twenty three comma..."). Runs in the
 * speaker's filter chain, before any speech cache key is computed. English only: Hindi and Tamil
 * agents keep their text unchanged until their own verbalisers exist.
 */
export const indianVerbalisationFilter: TextFilter = {
  id: INDIAN_VERBALISATION_FILTER_ID,
  order: 30,
  apply(text, ctx) {
    if (!/^en(?:-|$)/i.test(ctx.language)) return text;
    let spoken = currency(text);
    if (/^en-IN$/i.test(ctx.language)) spoken = dates(spoken);
    return phones(spoken);
  },
};
