/**
 * Caller text as the rules engine compares it: Unicode NFC, lowercase, every character that is not
 * a letter, a combining mark or a digit turned into a space (the danda and other punctuation go;
 * Indic vowel signs and viramas, which are marks, stay), zero-width joiners dropped, and spaces
 * collapsed. Both the reply and the configured words go through it, so they compare alike.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‌‍]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

export function words(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(' ') : [];
}

/** The script each supported language is written in (Urdu in the Arabic script). */
export const LANGUAGE_SCRIPTS: Readonly<Record<string, RegExp>> = Object.freeze({
  en: /\p{Script=Latin}/u,
  hi: /\p{Script=Devanagari}/u,
  mr: /\p{Script=Devanagari}/u,
  ta: /\p{Script=Tamil}/u,
  te: /\p{Script=Telugu}/u,
  kn: /\p{Script=Kannada}/u,
  ml: /\p{Script=Malayalam}/u,
  bn: /\p{Script=Bengali}/u,
  gu: /\p{Script=Gujarati}/u,
  pa: /\p{Script=Gurmukhi}/u,
  ur: /\p{Script=Arabic}/u,
});

const LETTER = /[\p{L}\p{M}]/u;
const SHARED = /[\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * The share (0-1) of the reply's letters written in a script any of `languages` uses. Letters and
 * marks count; digits, punctuation and characters every script shares (Common, Inherited) do not.
 * A language this table does not know contributes no script. 0 for a reply with no letters.
 * Hinglish typed or transcribed in Latin letters is Latin: it scores for `en`, not `hi`.
 */
export function scriptShare(text: string, languages: readonly string[]): number {
  const scripts = languages.flatMap((language) => LANGUAGE_SCRIPTS[language] ?? []);
  let letters = 0;
  let inScript = 0;
  for (const char of text.normalize('NFC')) {
    if (!LETTER.test(char) || SHARED.test(char)) continue;
    letters += 1;
    if (scripts.some((script) => script.test(char))) inScript += 1;
  }
  return letters ? inScript / letters : 0;
}
