import { normalizeForMatch } from '@winsendotai/ovo-contracts';

/** Words this short add nothing a reply already searching for the caller must start over for. */
const BRIEF_WORDS = 3;

export function brief(text: string): boolean {
  return text.split(/\s+/u).filter(Boolean).length <= BRIEF_WORDS;
}

/**
 * `words` say again only the end of `input`: an STT re-emitting its last words (Wave 12, call
 * 8cb76efc turn 10: a soft "January." after "Sometime around December to... January.").
 */
export function repeatsEnd(words: string, input: string): boolean {
  const said = normalizeForMatch(words);
  return said.length > 0 && normalizeForMatch(input).endsWith(said);
}
