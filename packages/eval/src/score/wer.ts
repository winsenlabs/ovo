// Word and character error rates against a gold transcript, on Hinglish-folded text (hinglish.ts).
import { scoringWords } from './hinglish.ts';

/** Substitutions, deletions and insertions turning `reference` into `hypothesis` (Levenshtein). */
export function editDistance<T>(reference: readonly T[], hypothesis: readonly T[]): number {
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

export interface ErrorCount {
  /** Edits, words (or characters) in the closest reference. */
  errors: number;
  length: number;
}

function closest(
  references: readonly string[],
  hypothesis: string,
  units: (text: string) => string[],
): ErrorCount {
  const said = units(hypothesis);
  let best: ErrorCount | undefined;
  for (const reference of references) {
    const expected = units(reference);
    const errors = editDistance(expected, said);
    const rate = errors / Math.max(1, expected.length);
    if (!best || rate < best.errors / Math.max(1, best.length))
      best = { errors, length: expected.length };
  }
  return best ?? { errors: said.length, length: 0 };
}

/** Word errors against the closest of the accepted references. */
export function wordErrors(references: readonly string[], hypothesis: string): ErrorCount {
  return closest(references, hypothesis, scoringWords);
}

/** Character errors (spaces dropped) against the closest of the accepted references. */
export function charErrors(references: readonly string[], hypothesis: string): ErrorCount {
  return closest(references, hypothesis, (text) => [...scoringWords(text).join('')]);
}

/** Corpus-level rate: all errors over all reference units; null with no reference units. */
export function rate(counts: readonly ErrorCount[]): number | null {
  const length = counts.reduce((sum, count) => sum + count.length, 0);
  return length ? counts.reduce((sum, count) => sum + count.errors, 0) / length : null;
}
