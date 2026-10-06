import type { GuardrailCheck } from '@winsendotai/ovo-contracts';

/**
 * A value stated in text. `keys` are its normalized forms (`num:4850`, `pct:10`, `date:03-15`,
 * `offer:waiver`); a claim is allowed when any of them was declared.
 */
export interface GuardrailClaim {
  kind: GuardrailCheck;
  text: string;
  keys: string[];
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR = '(?:,?\\s+\\d{4})?';
const DATES: readonly [RegExp, (match: RegExpExecArray) => string[]][] = [
  [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => [monthDay(+m[2]!, +m[3]!)]],
  // Day first is the en-IN reading; month first is kept as an alternative so neither is invented.
  [
    /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g,
    (m) => [monthDay(+m[2]!, +m[1]!), monthDay(+m[1]!, +m[2]!)],
  ],
  [
    new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}\\b\\.?${YEAR}`, 'gi'),
    (m) => [monthDay(month(m[2]!), +m[1]!)],
  ],
  [
    new RegExp(`\\b${MONTH}\\.?\\s+${DAY}\\b${YEAR}`, 'gi'),
    (m) => [monthDay(month(m[1]!), +m[2]!)],
  ],
];

const SCALE: Record<string, number> = {
  hundred: 100,
  thousand: 1_000,
  hazar: 1_000,
  hazaar: 1_000,
  k: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  lac: 100_000,
  lacs: 100_000,
  crore: 10_000_000,
  crores: 10_000_000,
  cr: 10_000_000,
  million: 1_000_000,
  billion: 1_000_000_000,
};
const NUMBER =
  /(?<![\d,])(?<!\d\.)(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?(?:\s*(k|lakhs?|lacs?|crores?|cr|thousand|hundred|million|billion|hazaa?r))?(?!\w)/gi;
const CURRENCY_BEFORE = /(?:₹|\brs\.?|\binr|\$|\busd)\s*$/i;
const CURRENCY_AFTER = /^\s*(?:rupees?|rupaye|rupaiye|rs\b|inr\b|dollars?|paise)/i;
const PERCENT_AFTER = /^\s*(?:%|percent\b|per\s+cent\b)/i;

const UNITS =
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(
    ' ',
  );
const TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
const WORD = `(?:${[...UNITS, ...TENS, 'hundred', 'thousand', 'lakhs?', 'lacs?', 'crores?', 'million', 'billion', 'hazaa?r'].join('|')})`;
const WORDS = new RegExp(`\\b${WORD}(?:(?:\\s+|-)(?:and\\s+)?${WORD})*\\b`, 'gi');

const OFFERS: readonly [RegExp, string][] = [
  [/\bdiscount(?:s|ed)?\b/gi, 'discount'],
  [/\bwaiv(?:e|ed|er|ers|ing)\b/gi, 'waiver'],
  [/\b[Ss]ettlements?\b|\bOTS\b/g, 'settlement'],
  [/\bcash\s?back\b/gi, 'cashback'],
  [/\b(?:interest[- ]free|zero[- ]interest)\b/gi, 'interest-free'],
  [/\brebates?\b/gi, 'rebate'],
  [/\bconcessions?\b/gi, 'concession'],
  [/\bwrit(?:e|ten)[- ]off\b/gi, 'write-off'],
  [/\bfree\s+of\s+(?:charge|cost)\b/gi, 'free'],
  [
    /\breduc(?:e|ed|es|ing|tion)\b(?:\s+\w+){0,3}?\s+(?:amount|interest|penalty|emi|dues|charges?|fees?)\b/gi,
    'reduction',
  ],
];
/** "We cannot offer a discount" is a refusal, not an offer. */
const NEGATION =
  /\b(?:no|not|cannot|can't|can not|unable|don't|do not|won't|never|isn't|aren't|neither|nor)\b(?:\s+\S+){0,5}\s*$/i;
/** A negator only refuses within its own clause: "No problem, I can waive it" is an offer. */
const CLAUSE = /[,;:.!?\u2013\u2014]|\bbut\b/i;
/** "No problem", "don't worry": reassurance, not refusal. */
const REASSURANCE = /\b(?:no|not|don't|do not)\s+(?:a\s+)?(?:problem|worr(?:y|ies))\b/gi;

/** Every value `text` states, of the kinds in `checks`. `minimum` drops small bare numbers. */
export function findClaims(
  text: string,
  checks: ReadonlySet<GuardrailCheck>,
  minimum = 10,
): GuardrailClaim[] {
  const claims: GuardrailClaim[] = [];
  let rest = text;
  for (const [pattern, keys] of DATES)
    rest = rest.replace(pattern, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpExecArray;
      const found = keys(match).filter(Boolean);
      if (found.length && checks.has('date'))
        claims.push({ kind: 'date', text: match[0], keys: found });
      return found.length ? ' '.repeat(match[0].length) : match[0];
    });
  for (const match of rest.matchAll(NUMBER)) {
    const before = rest.slice(Math.max(0, match.index - 6), match.index);
    const after = rest.slice(match.index + match[0].length, match.index + match[0].length + 12);
    const scale = match[3] ? SCALE[match[3].toLowerCase()]! : 1;
    const value = Number(`${match[1]!.replaceAll(',', '')}.${match[2] ?? '0'}`) * scale;
    numeric(claims, checks, match[0], value, kindOf(before, after, scale), minimum);
  }
  // Digits are read; "5 lakh" must not be read again as the spelled number "lakh".
  rest = rest.replace(NUMBER, (found) => ' '.repeat(found.length));
  for (const match of rest.matchAll(WORDS)) {
    const before = rest.slice(Math.max(0, match.index - 6), match.index);
    const after = rest.slice(match.index + match[0].length, match.index + match[0].length + 12);
    const kind = kindOf(before, after, /lakh|lac|crore/i.test(match[0]) ? 100_000 : 1);
    // A spelled number is a claim only as an amount or a percentage: "one moment" is not a value.
    if (kind !== 'number') numeric(claims, checks, match[0], wordsValue(match[0]), kind, 0);
  }
  if (checks.has('offer'))
    for (const [pattern, key] of OFFERS)
      for (const match of text.matchAll(pattern))
        if (!refused(text.slice(Math.max(0, match.index - 40), match.index)))
          claims.push({ kind: 'offer', text: match[0], keys: [`offer:${key}`] });
  return claims;
}

/**
 * What text may declare. Offers come only from the call's variables and the policy's allow list:
 * prose names an offer to forbid it ("waivers are not available") as often as to grant it. The
 * caller's own words declare only what can be read back (amounts, numbers, dates), never a
 * percentage or an offer they asked for.
 */
export type Declares = 'all' | 'values' | 'heard';
const DECLARES: Record<Declares, ReadonlySet<GuardrailCheck>> = {
  all: new Set(['amount', 'percent', 'number', 'date', 'offer']),
  values: new Set(['amount', 'percent', 'number', 'date']),
  heard: new Set(['amount', 'number', 'date']),
};

/** The keys a value declares: numbers as amounts and percentages, strings by what they state. */
export function valueKeys(
  value: unknown,
  into: Set<string>,
  declares: Declares = 'values',
  depth = 0,
): void {
  if (depth > 4 || into.size > 5_000) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.add(`num:${normal(value)}`).add(`pct:${normal(value)}`);
  } else if (typeof value === 'string') {
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (iso) into.add(`num:${+iso[1]!}`);
    if (/^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) valueKeys(Number(value), into, declares, depth + 1);
    textKeys(value, into, declares);
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) valueKeys(item, into, declares, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value).slice(0, 200))
      valueKeys(item, into, declares, depth + 1);
  }
}

/** Every key text declares, small numbers included, with the year of each date. */
export function textKeys(text: string, into: Set<string>, declares: Declares = 'values'): void {
  for (const claim of findClaims(text, DECLARES[declares], 0))
    for (const key of claim.keys) into.add(key);
  for (const year of text.matchAll(/\b(19|20)\d{2}\b/g)) into.add(`num:${+year[0]}`);
}

function refused(before: string): boolean {
  const clause = before.split(CLAUSE).at(-1)!;
  return NEGATION.test(clause.replace(REASSURANCE, ' '));
}

function kindOf(before: string, after: string, scale: number): GuardrailCheck {
  if (PERCENT_AFTER.test(after)) return 'percent';
  if (CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after) || scale >= 100_000)
    return 'amount';
  return 'number';
}

function numeric(
  claims: GuardrailClaim[],
  checks: ReadonlySet<GuardrailCheck>,
  text: string,
  value: number,
  kind: GuardrailCheck,
  minimum: number,
): void {
  if (!checks.has(kind) || !Number.isFinite(value)) return;
  if (kind === 'number' && value < minimum && Number.isInteger(value)) return;
  claims.push({
    kind,
    text: text.trim(),
    keys: [`${kind === 'percent' ? 'pct' : 'num'}:${normal(value)}`],
  });
}

function wordsValue(text: string): number {
  let total = 0;
  let current = 0;
  for (const word of text.toLowerCase().split(/[\s-]+/)) {
    if (word === 'and') continue;
    const unit = UNITS.indexOf(word);
    const ten = TENS.indexOf(word);
    if (unit >= 0) current += unit;
    else if (ten >= 0) current += (ten + 2) * 10;
    else if (word === 'hundred') current = (current || 1) * 100;
    else {
      total += (current || 1) * (SCALE[word] ?? 1);
      current = 0;
    }
  }
  return total + current;
}

function month(name: string): number {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? 0;
}

function monthDay(monthNumber: number, day: number): string {
  if (monthNumber < 1 || monthNumber > 12 || day < 1 || day > 31) return '';
  return `date:${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normal(value: number): string {
  return String(Math.round(value * 100) / 100);
}
