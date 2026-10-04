/**
 * `knowledge@1`: the conformance kit for the `Cap.knowledge` slot. `validateKnowledgeExchange`
 * (`contracts/src/knowledge.ts`) already enforces structure — ranked order, no repeats, topK
 * respected, requested sources only. This kit tests what a schema cannot:
 *
 * - the corpus the plugin was handed is genuinely searchable, and a term that is NOT in it returns
 *   nothing rather than the best of a bad set;
 * - `sourceIds` actually restricts, instead of being accepted and ignored;
 * - the score MOVES with relevance, and is comparable across two different queries, which is the one
 *   property `AgentKnowledgePolicy.minScore` depends on;
 * - a citation, where the plugin claims to support them, points at something the author supplied and
 *   is not invented;
 * - `revision` is stable for an unchanged corpus and different for a changed one;
 * - an abort is honoured.
 *
 * What it cannot prove: that retrieval is GOOD. Relevance is judged against real questions, not a
 * kit corpus. A green run means the port is honest about what it found, not that it found the right
 * thing.
 */
import { corpusOf, runToken, type KnowledgeKitContext } from './knowledge-support.ts';
import { searchOnce } from './knowledge-harness.ts';
import { KNOWLEDGE_PROVENANCE_CHECKS } from './knowledge-provenance.ts';
import { Failures, type KitCheck } from './runner.ts';

export type {
  KnowledgeFactory,
  KnowledgeKitDocument,
  KnowledgeKitOptions,
  KnowledgeKitContext,
  KnowledgeKitSource,
} from './knowledge-support.ts';
export { corpusOf } from './knowledge-support.ts';

const RETRIEVAL_CHECKS: readonly KitCheck<KnowledgeKitContext>[] = [
  {
    name: 'the supplied corpus is searchable and the passage carries the author’s own text',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const sources = corpusOf(token);
      const result = await searchOnce(context, sources, `refund alpha${token} timeline`);
      const top = result.passages[0];
      if (!f.expect(top, `searchable: nothing came back for a term that is in the corpus`))
        return f.messages;
      f.expect(
        top!.text.includes(`alpha${token}`),
        `searchable: the top passage does not contain the term searched for`,
      );
      f.expect(top!.sourceId === 'policy', `searchable: top passage came from ${top!.sourceId}`);
      // A plugin that paraphrases, summarises or truncates is answering, not retrieving.
      f.expect(
        sources[0]!.documents.some((document) => document.text.includes(top!.text.split('\n')[0]!)),
        `searchable: the returned text is not a verbatim span of any supplied document`,
      );
      return f.messages;
    },
  },
  {
    name: 'a term absent from the corpus returns nothing instead of the best of a bad set',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const result = await searchOnce(
        context,
        corpusOf(token),
        `zeta${token} unrelated nonexistent`,
      );
      // Returning the least-bad passage is how a grounded agent starts quoting irrelevant policy.
      f.expect(
        result.passages.length === 0,
        `absent term: ${result.passages.length} passages came back for a term in no document`,
      );
      return f.messages;
    },
  },
  {
    name: 'sourceIds restricts the search instead of being accepted and ignored',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const sources = corpusOf(token);
      const both = await searchOnce(context, sources, `shared${token}`);
      f.expect(
        new Set(both.passages.map((passage) => passage.sourceId)).size === 2,
        `sourceIds: the shared term did not reach both sources without a restriction`,
      );
      const one = await searchOnce(context, sources, `shared${token}`, { sourceIds: ['pricing'] });
      f.expect(one.passages.length > 0, `sourceIds: restricting to one source returned nothing`);
      f.expect(
        one.passages.every((passage) => passage.sourceId === 'pricing'),
        `sourceIds: a restricted search returned a passage from another source`,
      );
      return f.messages;
    },
  },
  {
    name: 'an unknown sourceId is refused rather than silently matching nothing',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      try {
        const result = await searchOnce(context, corpusOf(token), `shared${token}`, {
          sourceIds: ['not_a_source'],
        });
        // Silence here is how an agent stops being grounded while every gauge still reads green.
        f.add(
          `unknown source: a misspelled source id returned ${result.passages.length} passages instead of failing`,
        );
      } catch {
        // Refused, which is the required behaviour.
      }
      return f.messages;
    },
  },
  {
    name: 'the score moves with relevance and is comparable across two different queries',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const sources = corpusOf(token);
      // A query of ONE corpus term against a passage that contains it: near-full coverage.
      const focused = await searchOnce(context, sources, `alpha${token}`);
      // The same term plus two other corpus terms the same passage does NOT contain: part coverage.
      const diluted = await searchOnce(
        context,
        sources,
        `alpha${token} delta${token} gamma${token}`,
      );
      const focusedTop = focused.passages[0]?.score;
      const dilutedSame = diluted.passages.find((passage) =>
        passage.text.includes(`alpha${token}`),
      )?.score;
      if (focusedTop === undefined || dilutedSame === undefined) {
        f.add('comparable scores: the same passage was not found by both queries');
        return f.messages;
      }
      if (context.options.comparableScores === false) {
        f.expect(
          focusedTop !== dilutedSame,
          'score movement: the score is identical for a focused and a diluted query',
        );
        return f.messages;
      }
      // This is the property `minScore` rests on. Without it, one authored threshold means a
      // different thing on every turn, and nobody can tell.
      f.expect(
        focusedTop > dilutedSame,
        `comparable scores: covering the whole query scored ${focusedTop}, covering part of it scored ${dilutedSame}`,
      );
      return f.messages;
    },
  },
];

export const KNOWLEDGE_CHECKS: readonly KitCheck<KnowledgeKitContext>[] = [
  ...RETRIEVAL_CHECKS,
  ...KNOWLEDGE_PROVENANCE_CHECKS,
];
