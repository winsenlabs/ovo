import type { KnowledgeKitContext } from './knowledge-support.ts';
import { anySignal, corpusOf, runToken } from './knowledge-support.ts';
import { searchOnce } from './knowledge-harness.ts';
import { Failures, type KitCheck } from './runner.ts';

/**
 * Whether a passage can be traced back to something a human can open, and whether the corpus it came
 * from can be identified. An answer nobody can check is not grounded, it is merely fluent.
 */
export const KNOWLEDGE_PROVENANCE_CHECKS: readonly KitCheck<KnowledgeKitContext>[] = [
  {
    name: 'a citation points at what the author supplied and is not invented',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const sources = corpusOf(token);
      const result = await searchOnce(context, sources, `refund alpha${token}`);
      const top = result.passages[0];
      if (!top) {
        f.add('citation: nothing came back to check');
        return f.messages;
      }
      if (top.citation === undefined) return f.messages;
      const supplied = sources.flatMap((source) =>
        source.documents.flatMap((document) =>
          [document.citation, document.title].filter((value): value is string => Boolean(value)),
        ),
      );
      f.expect(
        supplied.some((value) => top.citation!.includes(value)),
        `citation: ${JSON.stringify(top.citation)} is not derived from any supplied title or citation`,
      );
      return f.messages;
    },
  },
  {
    name: 'a document with no title and no citation gets no invented one',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const result = await searchOnce(context, corpusOf(token), `delta${token} standard plan`);
      for (const passage of result.passages.filter((entry) => entry.sourceId === 'pricing'))
        f.expect(
          passage.citation === undefined || passage.citation.includes('pricing'),
          `citation: an untitled document was given the citation ${JSON.stringify(passage.citation)}`,
        );
      return f.messages;
    },
  },
  {
    name: 'topK is a ceiling the caller sets, not a preference the backend may exceed',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const sources = corpusOf(token);
      const one = await searchOnce(context, sources, `shared${token}`, { topK: 1 });
      f.expect(
        one.passages.length <= 1,
        `topK: ${one.passages.length} passages came back for topK 1`,
      );
      return f.messages;
    },
  },
  {
    name: 'revision is stable for an unchanged corpus and changes when the corpus changes',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const sources = corpusOf(token);
      const first = await searchOnce(context, sources, `alpha${token}`);
      const again = await searchOnce(context, corpusOf(token), `alpha${token}`);
      f.expect(
        first.revision === again.revision,
        `revision: the same corpus reported ${first.revision} then ${again.revision}`,
      );
      const changed = corpusOf(token);
      changed[0]!.documents = [
        ...changed[0]!.documents,
        { id: 'extra', text: `An extra clause epsilon${token} was added.` },
      ];
      const after = await searchOnce(context, changed, `alpha${token}`);
      // Without this, an answer cannot be traced to the text that was actually read.
      f.expect(
        after.revision !== first.revision,
        `revision: adding a document left the revision at ${after.revision}`,
      );
      return f.messages;
    },
  },
  {
    name: 'an aborted search rejects and does not resolve with stale passages',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const port = await context.factory({ sources: corpusOf(token) });
      const controller = new AbortController();
      controller.abort(new DOMException('cancelled', 'AbortError'));
      try {
        const result = await port.search(
          { text: `alpha${token}`, topK: 5, sourceIds: [] },
          { signal: controller.signal },
        );
        f.add(`abort: an already-aborted search resolved with ${result.passages.length} passages`);
      } catch {
        // Rejected, which is the required behaviour.
      }
      return f.messages;
    },
  },
];
