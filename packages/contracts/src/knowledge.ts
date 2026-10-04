import { z } from 'zod';

/**
 * Provider-neutral retrieval contract. A `knowledge` plugin answers a question with PASSAGES and
 * their provenance; it never answers the caller, never summarises, and never decides what to use.
 * The behaviour decides, so a weak match is visibly a weak match instead of confident prose.
 *
 * Deliberately NOT an embedding API. Whether a backend ranks by full-text search, by vectors or by a
 * vendor's own relevance is its business; the port is what both have in common.
 */

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);

export const KnowledgeQuery = z
  .object({
    /** What to look for. Normally the caller's turn, verbatim. */
    text: z.string().trim().min(1).max(4_000),
    /** Most passages to return. The caller's budget, not the backend's preference. */
    topK: z.number().int().min(1).max(50),
    /** Restrict to these sources. Empty means every source the plugin is configured with. */
    sourceIds: z.array(Id).max(50).default([]),
    /** BCP-47. A backend that cannot honour it must say so in its capabilities, not guess. */
    language: z.string().min(2).max(35).optional(),
  })
  .strict();
export type KnowledgeQuery = z.infer<typeof KnowledgeQuery>;

export const KnowledgePassage = z
  .object({
    id: z.string().min(1).max(200),
    sourceId: Id,
    text: z.string().trim().min(1).max(8_000),
    /**
     * Relevance in [0,1], comparable ACROSS queries from the same plugin. A backend whose native
     * score is unbounded must map it, because the caller applies one authored threshold to it.
     */
    score: z.number().finite().min(0).max(1),
    /** Where a human can go to check this passage: a heading, a page, a URL. */
    citation: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type KnowledgePassage = z.infer<typeof KnowledgePassage>;

export const KnowledgeResult = z
  .object({
    passages: z.array(KnowledgePassage).max(50),
    /** The corpus revision these passages came from, so an answer can be traced to what was read. */
    revision: z.string().min(1).max(200),
  })
  .strict();
export type KnowledgeResult = z.infer<typeof KnowledgeResult>;

/** Checks the parts a standalone result cannot know about the query. */
export function validateKnowledgeExchange(
  rawQuery: unknown,
  rawResult: unknown,
): { query: KnowledgeQuery; result: KnowledgeResult } {
  const query = KnowledgeQuery.parse(rawQuery);
  const result = KnowledgeResult.parse(rawResult);
  if (result.passages.length > query.topK)
    throw new Error(
      `Knowledge returned ${result.passages.length} passages for a topK of ${query.topK}`,
    );
  const ids = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  for (const passage of result.passages) {
    if (ids.has(passage.id)) throw new Error(`Knowledge repeated passage ${passage.id}`);
    ids.add(passage.id);
    // Ranked, best first. A caller that trims to a budget must be able to trim from the end.
    if (passage.score > previous)
      throw new Error(`Knowledge passages are not ordered by score at ${passage.id}`);
    previous = passage.score;
    if (query.sourceIds.length && !query.sourceIds.includes(passage.sourceId))
      throw new Error(`Knowledge returned passage from unrequested source ${passage.sourceId}`);
  }
  return { query, result };
}

export interface KnowledgePort {
  search(query: KnowledgeQuery, options: { signal: AbortSignal }): Promise<KnowledgeResult>;
}
