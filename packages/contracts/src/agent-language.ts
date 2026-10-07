import { z } from 'zod';
import {
  FUNCTION_WORDS,
  LATIN_LETTERS,
  ROMANIZED,
  SCRIPT_LANGUAGES,
  SPANISH_MARKS,
  SPOKEN_AS_ONE,
} from './agent-language-lexicon.ts';

/** A base language code: ISO 639-1, or ISO 639-3 where a language has no two-letter code. */
const BaseLanguage = z
  .string()
  .regex(/^[a-z]{2,3}$/, 'Use a base language code such as en, hi or ta');

/**
 * N4/P9 per agent: the languages a caller may speak. A transcript mostly in another language (an
 * STT that drifted, a background talker, Tamil heard as Spanish) is not understood: it never
 * barges in, the LLM never answers it or ends the call on it, and the caller hears `line`, asking
 * them to say it again. The agent always replies in its own `language`; the platform tells the LLM
 * so, and a reply in a language outside `allowed` is never spoken.
 */
export const AgentLanguages = z
  .object({
    /** Base codes, the agent's own language among them: `['en', 'hi']` for an en-IN agent. */
    allowed: z
      .array(BaseLanguage)
      .min(1)
      .max(12)
      .refine((codes) => new Set(codes).size === codes.length, 'Allowed languages must be unique'),
    /**
     * Said, in the agent's language, when the caller is heard in another one. English and Hindi
     * agents have a default; any other agent language must author it.
     */
    line: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export type AgentLanguages = z.infer<typeof AgentLanguages>;

export function baseLanguageOf(language: string): string {
  return language.split('-')[0]!.toLowerCase();
}

const NAMES: Readonly<Record<string, { en: string; hi: string }>> = {
  en: { en: 'English', hi: 'अंग्रेज़ी' },
  hi: { en: 'Hindi', hi: 'हिंदी' },
  ta: { en: 'Tamil', hi: 'तमिल' },
  te: { en: 'Telugu', hi: 'तेलुगु' },
  kn: { en: 'Kannada', hi: 'कन्नड़' },
  ml: { en: 'Malayalam', hi: 'मलयालम' },
  mr: { en: 'Marathi', hi: 'मराठी' },
  bn: { en: 'Bengali', hi: 'बांग्ला' },
  gu: { en: 'Gujarati', hi: 'गुजराती' },
  pa: { en: 'Punjabi', hi: 'पंजाबी' },
  ur: { en: 'Urdu', hi: 'उर्दू' },
};

function listed(names: string[], or: string): string {
  return names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} ${or} ${names.at(-1)}`;
}

/**
 * The line an agent says to a caller heard outside its languages: the authored one, else the
 * default for an English or Hindi agent, else undefined (the config refinement rejects that).
 */
export function agentLanguageLine(config: {
  language: string;
  languages?: AgentLanguages | undefined;
}): string | undefined {
  const policy = config.languages;
  if (!policy) return undefined;
  if (policy.line) return policy.line;
  const own = baseLanguageOf(config.language);
  if (own !== 'en' && own !== 'hi') return undefined;
  // The agent's own language first, then the others it understands, in the order authored.
  const codes = [own, ...policy.allowed.filter((code) => code !== own)];
  const names = codes.flatMap((code) => (NAMES[code] ? [NAMES[code][own]] : []));
  return own === 'en'
    ? `Sorry, I can only understand ${listed(names, 'or')}. Could you say that again?`
    : `माफ़ कीजिए, क्या आप ${listed(names, 'या')} में दोबारा बता सकते हैं?`;
}

/** Validation issues for `languages`, reported by the AgentConfig refinement. */
export function agentLanguageIssues(config: {
  mode: string;
  language: string;
  languages?: AgentLanguages | undefined;
}): { message: string; path: (string | number)[] }[] {
  const policy = config.languages;
  if (!policy) return [];
  if (config.mode !== 'agent') return [{ message: 'languages requires agent mode', path: [] }];
  const own = baseLanguageOf(config.language);
  const issues: { message: string; path: (string | number)[] }[] = [];
  if (!policy.allowed.includes(own))
    issues.push({
      message: `Allowed languages must include the agent's ${own}`,
      path: ['allowed'],
    });
  if (agentLanguageLine(config) === undefined)
    issues.push({ message: `A ${own} agent must author languages.line`, path: ['line'] });
  return issues;
}

export interface LanguageVerdict {
  /** The words are mostly in languages outside the allowed set. */
  off: boolean;
  /** Base codes of the outside languages the words were in, for logs. */
  foreign: readonly string[];
}

const WORD = /[\p{L}\p{M}]+/gu;
const LATIN = /\p{Script=Latin}/u;

/**
 * Which side of `allowed` the words of `text` fall on. Deterministic and offline, in microseconds:
 * it runs on every interim transcript and every reply sentence.
 *
 * A word in a non-Latin script is in that script's languages. A Latin word is outside only when it
 * carries a letter that English and romanized Indian languages never use (ı, ñ, ß...) or is a
 * function word of another Latin language ("ik", "niet", "entonces") that no romanized Indian
 * language also writes. Every other Latin word is neutral, so Hinglish and Tanglish in Latin script
 * are never off: transcribed Indian speech is Latin as often as not. The text is off when its outside words outnumber its allowed ones and the
 * evidence is not one Latin function word alone.
 */
export function languageVerdict(text: string, allowed: readonly string[]): LanguageVerdict {
  const accepted = new Set(allowed.flatMap((code) => [code, ...(SPOKEN_AS_ONE[code] ?? [])]));
  const isAllowed = (codes: readonly string[]) => codes.some((code) => accepted.has(code));
  const foreign = new Set<string>();
  let inside = 0;
  let strong = 0;
  let weak = 0;
  const outside = (codes: readonly string[], certain: boolean) => {
    for (const code of codes) foreign.add(code);
    if (certain) strong += 1;
    else weak += 1;
  };
  if (SPANISH_MARKS.test(text) && !accepted.has('es')) outside(['es'], true);
  for (const [word] of text.normalize('NFC').matchAll(WORD)) {
    if (!LATIN.test(word)) {
      const codes = SCRIPT_LANGUAGES.find(([script]) => script.test(word))?.[1];
      if (!codes) continue;
      if (isAllowed(codes)) inside += 1;
      else outside(codes, true);
      continue;
    }
    const letters = LATIN_LETTERS.find(([pattern]) => pattern.test(word))?.[1];
    if (letters) {
      if (isAllowed(letters)) inside += 1;
      else outside(letters, true);
      continue;
    }
    const lower = word.toLowerCase();
    const speakers = Object.keys(FUNCTION_WORDS).filter((code) => FUNCTION_WORDS[code]!.has(lower));
    if (!speakers.length) continue;
    if (isAllowed(speakers)) inside += 1;
    else if (!speakers.some((code) => ROMANIZED.has(code))) outside(speakers, false);
  }
  const off = strong + weak > inside && (strong > 0 || weak > 1);
  return { off, foreign: off ? [...foreign] : [] };
}

/** True when `text` is mostly outside `allowed` (see `languageVerdict`). */
export function offLanguage(text: string, allowed: readonly string[]): boolean {
  return languageVerdict(text, allowed).off;
}
