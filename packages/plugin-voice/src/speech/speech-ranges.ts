/**
 * Wave 9 D1: the ranges and symbols of a reply, written for the ear (`speech-normaliser.ts` runs
 * these after it has set its dates aside as placeholders). An amount range gets "to", or "between
 * … and …" for money ("between seventy thousand and one lakh rupees"); an en dash between two
 * names gets "to" ("Mumbai to Prague"); a symbol a TTS reads aloud becomes its word.
 */

/** The placeholder mark the normaliser puts around a date: never part of an amount. */
const MARK = '\u0000';

/** Words of a spoken amount: "seventy thousand", "one lakh", "two and a half". */
const NUMBER_WORDS = [
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen',
  'sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety',
  'hundred thousand lakh lakhs crore crores million billion half',
]
  .join(' ')
  .split(' ');
const NUMBER_WORD = `(?:${NUMBER_WORDS.join('|')})`;
const WORD_AMOUNT = String.raw`${NUMBER_WORD}(?:(?:[\s-]+(?:and\s+|a\s+)?)${NUMBER_WORD})*`;
const DIGIT_AMOUNT = String.raw`(?:[₹$€£]\s?)?\d[\d,]*(?:\.\d+)?(?::\d{2})?(?:st|nd|rd|th|k|K|%|\s?(?:am|pm|AM|PM))?(?:\s(?:lakhs?|crores?|thousand|million|billion))?`;
const UNITS = [
  'rupees',
  'rupee',
  'dollars',
  'euros',
  'pounds',
  'percent',
  'per cent',
  'days',
  'day',
  'nights',
  'night',
  'hours',
  'hour',
  'minutes',
  'minute',
  'weeks',
  'week',
  'months',
  'month',
  'years',
  'year',
  'degrees',
  'people',
  'kilometres',
  'kilometers',
  'km',
  'kg',
];
const UNIT = `(${UNITS.join('|')})`;
const MONEY_UNITS = new Set(['rupees', 'rupee', 'dollars', 'euros', 'pounds']);
const CURRENCY_WORDS: Record<string, [string, string]> = {
  '€': ['euro', 'euros'],
  $: ['dollar', 'dollars'],
  '£': ['pound', 'pounds'],
};

const APPROXIMATE =
  /\b(?:around|about|roughly|approximately|approx\.?|nearly|some|under|over|up to)\s+$/i;

/**
 * Amount and number ranges: "₹70,000–₹1,00,000", "seventy thousand rupees–one lakh rupees",
 * "5–7 days", "20–25%", "10am–2pm".
 */
const AMOUNT_RANGE = new RegExp(
  String.raw`(?<![\p{L}\p{N}₹$€£.,${MARK}])(${DIGIT_AMOUNT}|${WORD_AMOUNT})(?:\s+${UNIT})?(\s*[–—]\s*|\s+-\s+|-)(${DIGIT_AMOUNT}|${WORD_AMOUNT})(?:\s+${UNIT})?(?![\p{L}\p{N}${MARK}])`,
  'giu',
);

function amountRanges(text: string): string {
  return text.replace(
    AMOUNT_RANGE,
    (
      match: string,
      left: string,
      leftUnit: string | undefined,
      separator: string,
      right: string,
      rightUnit: string | undefined,
      offset: number,
    ) => {
      const symbol = /^[₹$€£]/.exec(left)?.[0];
      // A bare hyphen joins a spoken number ("sixty-five"); between digits it is a range only
      // next to a currency or a unit, so a phone number ("98450-12345") or a code keeps it.
      if (separator === '-' && (/^\p{L}/u.test(left) || /^\p{L}/u.test(right))) return match;
      if (separator === '-' && !leftUnit && !rightUnit && !/[₹$€£%]/.test(match)) return match;
      // A word range needs a word on both sides: "one–two" yes, "one–2" is a typo or a code.
      if (/^\p{L}/u.test(left) !== /^\p{L}/u.test(right)) return match;
      if (symbol && !/^[₹$€£]/.test(right)) right = `${symbol}${right}`;
      const unit = rightUnit ?? leftUnit;
      const sameUnit =
        !leftUnit || !rightUnit || leftUnit.toLowerCase() === rightUnit.toLowerCase();
      const from = sameUnit ? left : `${left} ${leftUnit}`;
      const to = unit ? `${right} ${unit}` : right;
      const before = text.slice(0, offset);
      if (/\bbetween\s+$/i.test(before)) return `${from} and ${to}`;
      if (/\bfrom\s+$/i.test(before) || APPROXIMATE.test(before)) return `${from} to ${to}`;
      const money =
        (unit !== undefined && MONEY_UNITS.has(unit.toLowerCase())) ||
        (symbol !== undefined && sameUnit);
      return money && sameUnit ? `between ${from} and ${to}` : `${from} to ${to}`;
    },
  );
}

/**
 * "Mumbai–Prague", "Monday–Friday": an unspaced en dash between two names. Never "Sure—I can",
 * and never a spaced en dash: "Absolutely – Vienna is lovely" is a pause after an opener, which
 * `spokenSymbols` says as a comma.
 */
const NAME_RANGE = /(?<=(?:^|[^\p{L}])\p{Lu}[\p{L}\p{M}'’.]*)–(?=\p{Lu}[\p{L}\p{M}])(?!I\b)/gu;

/** Amount ranges, then ranges between names, said with "to" (or "between … and …"). */
export function spokenRanges(text: string): string {
  return amountRanges(text).replace(NAME_RANGE, ' to ');
}

/** "€120" → "120 euros", "$5k" → "5 thousand dollars"; rupees are the Indian filter's. */
const CURRENCY = /([€$£])\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(k|K)\b|\s(thousand|million|billion)\b)?/g;

function currencies(text: string): string {
  return text.replace(
    CURRENCY,
    (_match, symbol: string, amount: string, k?: string, scale?: string) => {
      const [one, many] = CURRENCY_WORDS[symbol]!;
      const magnitude = k ? ' thousand' : scale ? ` ${scale}` : '';
      return `${amount}${magnitude} ${amount === '1' && !magnitude ? one : many}`;
    },
  );
}

const PER = /(?<=[\p{L}\p{N}])\/(night|person|head|pax|day|hour|week|month|year|kg|km|minute)\b/gu;

export function spokenSymbols(text: string): string {
  return (
    currencies(text)
      .replace(/(\d)\s?%/g, '$1 percent')
      .replace(/(\d)\s?°\s?C\b/g, '$1 degrees Celsius')
      .replace(/(\d)\s?°\s?F\b/g, '$1 degrees Fahrenheit')
      .replace(/(\d)\s?°/g, '$1 degrees')
      .replace(PER, ' per $1')
      .replace(/(?<=[\p{L}\p{N}])\s*&\s*(?=[\p{L}\p{N}])/gu, ' and ')
      .replace(/~\s?(?=\d)/g, 'about ')
      .replace(/(\d)\+(?![\d+])/g, '$1 plus')
      .replace(/#(?=\d)/g, 'number ')
      // An en dash left over is a pause, not a range: "Vienna – the capital – is".
      .replace(/\s+–\s+/g, ', ')
      .replace(/(?<=\p{L})–(?=\p{L})/gu, '-')
  );
}
