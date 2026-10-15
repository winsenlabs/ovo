// Language misdetection: a transcript in a language the caller did not speak. Call 8's Scribe
// finals included German ("Ah, aber, äh, war noch nicht"), Turkish ("Hıhı") and Hindi in
// Devanagari for an English name; call 7's included Spanish ("Bueno, buenas tardes") and Tamil.

/** Base language codes; ISO 639-3 forms providers return are folded to these. */
const ISO3: Readonly<Record<string, string>> = {
  eng: 'en',
  hin: 'hi',
  tam: 'ta',
  deu: 'de',
  ger: 'de',
  spa: 'es',
  tur: 'tr',
  fra: 'fr',
  fre: 'fr',
  por: 'pt',
  ita: 'it',
  nld: 'nl',
  dut: 'nl',
  rus: 'ru',
  urd: 'ur',
};

export function baseLanguage(code: string): string {
  const base = code.trim().toLowerCase().split(/[-_]/)[0]!;
  return ISO3[base] ?? base;
}

/** Letters no English or romanised-Hindi transcript uses: German, Turkish, Spanish, French… */
const FOREIGN_LETTERS = /[äöüßışğçñáíóúàèìòùâêîôûãõœ¿¡]/iu;
/** Frequent function words of the languages Scribe drifted into, none of them English or Hinglish. */
const FOREIGN_WORDS = new Set([
  'aber',
  'nicht',
  'noch',
  'und',
  'ist',
  'ich',
  'das',
  'doch',
  'auch',
  'bueno',
  'buenas',
  'buenos',
  'tardes',
  'gracias',
  'hola',
  'pero',
  'merci',
  'bonjour',
  'oui',
  'obrigado',
  'grazie',
  'evet',
  'hayır',
  'tamam',
]);

const SCRIPTS: readonly [string, RegExp][] = [
  ['devanagari', /\p{Script=Devanagari}/u],
  ['tamil', /\p{Script=Tamil}/u],
  ['telugu', /\p{Script=Telugu}/u],
  ['kannada', /\p{Script=Kannada}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['han', /\p{Script=Han}/u],
  ['latin', /\p{Script=Latin}/u],
];

/** Which language each script implies, for checking it against what the caller spoke. */
const SCRIPT_LANGUAGE: Readonly<Record<string, string>> = {
  devanagari: 'hi',
  tamil: 'ta',
  telugu: 'te',
  kannada: 'kn',
  bengali: 'bn',
  arabic: 'ar',
  cyrillic: 'ru',
  han: 'zh',
};

export function scriptsOf(text: string): string[] {
  return SCRIPTS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/**
 * Why a transcript is in a language the caller did not speak, or nothing when it is not.
 * `spoken` holds the caller's base codes for the utterance (gold), English and Hindi by default.
 * Latin script is never flagged on its own: romanised Hindi and English share it. Evidence is the
 * provider's reported language, a script, a letter or a function word of another language.
 */
export function misdetections(
  text: string,
  spoken: readonly string[] = ['en', 'hi'],
  reported?: string,
): string[] {
  const allowed = new Set(spoken.map(baseLanguage));
  const reasons: string[] = [];
  if (reported && !allowed.has(baseLanguage(reported)))
    reasons.push(`provider reported ${reported}`);
  for (const script of scriptsOf(text)) {
    const language = SCRIPT_LANGUAGE[script];
    if (language && !allowed.has(language)) reasons.push(`${script} script`);
  }
  if (allowed.has('en') || allowed.has('hi')) {
    const letter = text.match(FOREIGN_LETTERS);
    if (letter) reasons.push(`letter ${letter[0]}`);
    const words = text
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter((word) => FOREIGN_WORDS.has(word));
    if (words.length) reasons.push(`words ${[...new Set(words)].join(', ')}`);
  }
  return reasons;
}
