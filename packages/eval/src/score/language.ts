// Language misdetection: a transcript the STT wrote in a language the caller was not speaking.
// Call eb509d62 heard Indian English and Hinglish as German ("Ah, aber, äh, war noch nicht."),
// Turkish ("Hıhı.", "Çok.") and English as Devanagari ("तेज इजाफा" for "Tejas"). A heuristic, not a
// language identifier: a script the agent's languages do not use, letters English and romanised
// Hindi never need, or several common words of a European language the caller does not speak.
import { isDevanagari } from './hinglish.ts';

export type Script = 'latin' | 'devanagari' | 'other' | 'none';

/** Letters of Latin-script languages that English and romanised Hindi do not use. */
const FOREIGN_LETTERS = /[äöüßıışğçñœæøåãõâêîôûàèìòùáíóúéëïÿž]/iu;

/** Frequent words of the languages Scribe has mistaken Indian callers for (not English, not Hindi). */
const FOREIGN_WORDS = new Set(
  [
    'aber nicht noch und ich ist auch sie wir genau danke bitte nein oder mit für ein eine', // German
    'pero gracias bueno buenas buenos tardes señor claro sí muy obrigado', // Spanish and Portuguese
    'mais merci oui avec pour grazie ciao', // French and Italian
    'evet hayır çok şey hıhı', // Turkish
  ].flatMap((words) => words.split(' ')),
);

/** The script most of the letters are in. */
export function scriptOf(text: string): Script {
  let latin = 0;
  let devanagari = 0;
  let other = 0;
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    if (isDevanagari(char)) devanagari++;
    else if (/\p{Script=Latin}/u.test(char)) latin++;
    else other++;
  }
  const most = Math.max(latin, devanagari, other);
  if (!most) return 'none';
  return most === latin ? 'latin' : most === devanagari ? 'devanagari' : 'other';
}

export interface LanguageVerdict {
  foreign: boolean;
  why?: 'script' | 'letters' | 'words';
}

/**
 * Whether `text` reads as a language outside `languages` (BCP-47 bases, default English and
 * Hindi). Devanagari counts as foreign only when Hindi is not among them.
 */
export function foreignTranscript(
  text: string,
  languages: readonly string[] = ['en', 'hi'],
): LanguageVerdict {
  const script = scriptOf(text);
  const hindi = languages.includes('hi');
  if (script === 'other' || (script === 'devanagari' && !hindi))
    return { foreign: true, why: 'script' };
  if (script !== 'latin') return { foreign: false };
  if (FOREIGN_LETTERS.test(text)) return { foreign: true, why: 'letters' };
  const words = text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  const hits = new Set(words.filter((word) => FOREIGN_WORDS.has(word)));
  // One such word alone is a name or a stray word; two different ones are a language. Words that
  // are also romanised Hindi ("ja", "vale", "tamam") are left out of the list.
  if (hits.size >= 2 && hits.size / words.length >= 0.25) return { foreign: true, why: 'words' };
  return { foreign: false };
}

/**
 * Against a gold utterance: English heard as Devanagari (or Hindi as a European language) is a
 * misdetection even when both scripts are allowed. `mixed` accepts Latin and Devanagari.
 */
export function mismatchesGold(
  hypothesis: string,
  goldLanguage: string | undefined,
  languages: readonly string[] = ['en', 'hi'],
): boolean {
  if (!hypothesis.trim()) return false;
  if (foreignTranscript(hypothesis, languages).foreign) return true;
  const script = scriptOf(hypothesis);
  const base = goldLanguage?.split('-')[0]?.toLowerCase();
  if (base === 'en') return script === 'devanagari';
  return false;
}
