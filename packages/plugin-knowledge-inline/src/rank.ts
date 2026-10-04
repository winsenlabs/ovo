import { countTerms, type Chunked } from './chunk.ts';

/** Term-frequency saturation: a term repeated ten times is not ten times the evidence. */
const SATURATION = 1.2;

export interface Ranked {
  passage: Chunked;
  score: number;
}

/**
 * The score is the IDF-weighted fraction of the query's distinct terms that a passage covers.
 *
 * This is the whole reason the number can be compared across queries, which
 * `KnowledgePassage.score` requires and BM25 cannot give: the denominator is the query's own total
 * weight, so 0.5 means "half the informative words, by weight" for any query. It is lexical, and the
 * manifest says so — a threshold tuned here does NOT transfer to a vector backend.
 *
 * `idf` is computed over the corpus once. A term present in every passage carries no weight, which is
 * how a frequent word is discounted without a stopword list anybody has to maintain per language.
 */
export class InlineRanker {
  private readonly idf: ReadonlyMap<string, number>;

  constructor(private readonly passages: readonly Chunked[]) {
    const documentFrequency = new Map<string, number>();
    for (const passage of passages)
      for (const term of passage.terms.keys())
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    const total = passages.length || 1;
    this.idf = new Map(
      [...documentFrequency].map(([term, count]) => [
        term,
        Math.log(1 + (total - count + 0.5) / (count + 0.5)),
      ]),
    );
  }

  rank(text: string, sourceIds: readonly string[]): Ranked[] {
    const query = countTerms(text);
    // An unknown term has no corpus weight, so it cannot be covered and must not inflate the
    // denominator either: a query of only unknown words scores 0, not 0/0.
    const weights = [...query.keys()]
      .map((term) => [term, this.idf.get(term) ?? 0] as const)
      .filter(([, weight]) => weight > 0);
    const totalWeight = weights.reduce((sum, [, weight]) => sum + weight, 0);
    if (!totalWeight) return [];
    const allowed = new Set(sourceIds);
    return this.passages
      .filter((passage) => !allowed.size || allowed.has(passage.sourceId))
      .map((passage) => {
        const covered = weights.reduce((sum, [term, weight]) => {
          const frequency = passage.terms.get(term) ?? 0;
          return frequency ? sum + weight * (frequency / (frequency + SATURATION)) : sum;
        }, 0);
        return { passage, score: covered / totalWeight };
      })
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.passage.id.localeCompare(right.passage.id),
      );
  }
}
