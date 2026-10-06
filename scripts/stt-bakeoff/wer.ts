// Word error rate for the STT-10 bake-off.

/**
 * Words as a transcriber would compare them: Unicode-normalised (NFKC), lower case, without
 * punctuation (Latin and Devanagari danda alike), digit groups joined ("4,210" is one word), and
 * whitespace collapsed. Scripts are not transliterated: list a Devanagari spelling in `accept`.
 */
export function normalizeWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\d)[,.](?=\d)/g, '$1')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Substitutions, deletions and insertions turning `reference` into `hypothesis` (Levenshtein). */
export function wordErrors(reference: readonly string[], hypothesis: readonly string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let i = 1; i <= reference.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j += 1)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[hypothesis.length]!;
}

/** The fewest errors against any accepted reference, with that reference's word count. */
export function bestMatch(
  references: readonly string[],
  hypothesis: string,
): { errors: number; words: number } {
  const said = normalizeWords(hypothesis);
  let best: { errors: number; words: number } | undefined;
  for (const reference of references) {
    const words = normalizeWords(reference);
    const errors = wordErrors(words, said);
    if (!best || errors / Math.max(1, words.length) < best.errors / Math.max(1, best.words))
      best = { errors, words: words.length };
  }
  return best ?? { errors: said.length, words: 0 };
}
