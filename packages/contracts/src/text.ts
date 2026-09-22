/**
 * Text matching helpers (§2.10). NFKC, lower case, then every run of characters outside the Unicode
 * letter, mark and number classes becomes one space. Keeping `\p{M}` preserves Devanagari combining
 * marks, so 'हाँ!' normalizes to 'हाँ' (#18).
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

function segmenter(language: string): Intl.Segmenter {
  try {
    return new Intl.Segmenter(language, { granularity: 'word' });
  } catch {
    return new Intl.Segmenter(undefined, { granularity: 'word' });
  }
}

/** Words as `Intl.Segmenter` sees them for `language`; only word-like segments count. */
export function countWords(text: string, language: string): number {
  let count = 0;
  for (const segment of segmenter(language).segment(text)) if (segment.isWordLike) count++;
  return count;
}

/** Pre-normalized (fixed points of `normalizeForMatch`) and matched on whole token sequences. */
export const CONFIRM_YES: readonly string[] = Object.freeze([
  'yes',
  'yeah',
  'yep',
  'sure',
  'correct',
  'confirm',
  'confirmed',
  'go ahead',
  'proceed',
  'haan',
  'haan ji',
  'ji haan',
  'theek hai',
  'ठीक है',
  'हाँ',
  'हां',
]);

export const CONFIRM_NO: readonly string[] = Object.freeze([
  'no',
  'nope',
  'not',
  'cancel',
  'stop',
  'wait',
  'hold on',
  'do not',
  'don t',
  'nahin',
  'nahi',
  'mat',
  'mat karo',
  'ruko',
  'नहीं',
  'मत',
  'रुको',
]);

export const CONFIRM_FILLERS: readonly string[] = Object.freeze([
  'please',
  'ok',
  'okay',
  'ji',
  'sir',
  'madam',
  'hmm',
  'uh',
  'um',
]);

const tokens = (text: string) => normalizeForMatch(text).split(' ').filter(Boolean);
const NO_PHRASES = CONFIRM_NO.map(tokens);
const YES_PHRASES = new Set(CONFIRM_YES);
const FILLERS = new Set(CONFIRM_FILLERS);

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let offset = 0; offset < needle.length; offset++)
      if (haystack[start + offset] !== needle[offset]) continue outer;
    return true;
  }
  return false;
}

/**
 * Whole-utterance confirmation (#10). Any NO phrase anywhere wins. Otherwise fillers are stripped
 * from both ends, and the remainder must equal exactly one YES phrase. Anything else is unclear.
 */
export function classifyConfirmation(text: string): 'yes' | 'no' | 'unclear' {
  const words = tokens(text);
  if (NO_PHRASES.some((phrase) => containsRun(words, phrase))) return 'no';
  let start = 0;
  let end = words.length;
  while (start < end && FILLERS.has(words[start]!)) start++;
  while (end > start && FILLERS.has(words[end - 1]!)) end--;
  const remainder = words.slice(start, end).join(' ');
  return remainder && YES_PHRASES.has(remainder) ? 'yes' : 'unclear';
}
