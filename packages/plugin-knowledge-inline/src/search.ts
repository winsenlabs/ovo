import {
  KnowledgeQuery,
  validateKnowledgeExchange,
  type KnowledgePort,
  type KnowledgeResult,
} from '@winsendotai/ovo-contracts';
import { chunkDocument, type Chunked, type InlineSource } from './chunk.ts';
import { InlineRanker } from './rank.ts';

export interface InlineKnowledgeOptions {
  sources: readonly InlineSource[];
  maxPassageCharacters: number;
}

/**
 * Retrieval over passages carried on the release itself. No store, no vendor, no network: the corpus
 * is part of the immutable release, so `revision` is a hash of it and two calls on one release can
 * never read different text.
 *
 * That is also its limit, stated plainly: a corpus that must change without a release, or one too
 * large to put in a config, needs a stored backend behind this same port. See README.md.
 */
export class InlineKnowledge implements KnowledgePort {
  readonly provider = 'inline';
  private readonly passages: readonly Chunked[];
  private readonly ranker: InlineRanker;
  readonly revision: string;

  constructor(options: InlineKnowledgeOptions) {
    const seen = new Set<string>();
    for (const source of options.sources) {
      if (seen.has(source.id)) throw new Error(`Inline knowledge source ${source.id} is repeated`);
      seen.add(source.id);
      const documents = new Set<string>();
      for (const document of source.documents) {
        if (documents.has(document.id))
          throw new Error(`Inline knowledge document ${document.id} is repeated in ${source.id}`);
        documents.add(document.id);
      }
    }
    this.passages = options.sources.flatMap((source) =>
      source.documents.flatMap((document) =>
        chunkDocument(document, source.id, options.maxPassageCharacters),
      ),
    );
    this.ranker = new InlineRanker(this.passages);
    this.revision = revisionOf(this.passages);
  }

  async search(raw: KnowledgeQuery, { signal }: { signal: AbortSignal }): Promise<KnowledgeResult> {
    signal.throwIfAborted();
    const query = KnowledgeQuery.parse(raw);
    const unknown = query.sourceIds.filter(
      (id) => !this.passages.some((passage) => passage.sourceId === id),
    );
    // Silently returning nothing for a misspelled source id is how an agent quietly stops being
    // grounded while every gauge still reads green.
    if (unknown.length)
      throw new Error(`Inline knowledge has no source named ${unknown.join(', ')}`);
    const result: KnowledgeResult = {
      revision: this.revision,
      passages: this.ranker
        .rank(query.text, query.sourceIds)
        .slice(0, query.topK)
        .map(({ passage, score }) => ({
          id: passage.id,
          sourceId: passage.sourceId,
          text: passage.text,
          score,
          ...(passage.citation ? { citation: passage.citation } : {}),
        })),
    };
    return validateKnowledgeExchange(query, result).result;
  }
}

/**
 * A stable digest of exactly what is searchable. Synchronous and dependency-free on purpose: this
 * runs in a plugin constructor, and `crypto.subtle` is async. It identifies a corpus; it is not a
 * security boundary.
 */
function revisionOf(passages: readonly Chunked[]): string {
  let hash = 0x811c9dc5;
  for (const passage of passages)
    for (const point of `${passage.sourceId}\u0000${passage.id}\u0000${passage.text}\u0001`) {
      hash ^= point.codePointAt(0)!;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  return `inline-${passages.length}-${hash.toString(16).padStart(8, '0')}`;
}
