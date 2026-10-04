import { describe, expect, it } from 'vitest';
import {
  checkKnowledge,
  corpusOf,
  type KnowledgeFactory,
  type KitFailure,
} from '@winsendotai/ovo-conformance';
import type { KnowledgePassage, KnowledgeResult } from '@winsendotai/ovo-contracts';
import { InlineKnowledge } from '../src/index.ts';

const messages = (failures: KitFailure[]) => failures.map((failure) => failure.message).join('\n');

/**
 * A faithful plugin with exactly one invariant broken on the way out, so the message the kit produces
 * names that invariant and nothing else. Without these, a kit check that can never fail reads the
 * same as one that passes.
 */
const broken =
  (
    mutate: (result: KnowledgeResult, query: { text: string; sourceIds: string[] }) => void,
  ): KnowledgeFactory =>
  ({ sources }) => {
    const real = new InlineKnowledge({ sources, maxPassageCharacters: 2_000 });
    return {
      async search(query, options) {
        const result = await real.search(query, options);
        const copy: KnowledgeResult = {
          revision: result.revision,
          passages: result.passages.map((passage) => ({ ...passage })),
        };
        mutate(copy, { text: query.text, sourceIds: [...query.sourceIds] });
        return copy;
      },
    };
  };

const run = (
  mutate: (result: KnowledgeResult, query: { text: string; sourceIds: string[] }) => void,
  only: string,
) => checkKnowledge(broken(mutate), {}, { only: [only] });

describe('knowledge@1 rejects a backend that answers instead of retrieving', () => {
  it('flags a plugin that paraphrases rather than returning the author’s span', async () => {
    const failures = await run((result) => {
      for (const passage of result.passages)
        passage.text = `In summary: ${passage.text.slice(0, 20)}`;
    }, 'the author’s own text');
    expect(messages(failures)).toMatch(/not a verbatim span of any supplied document/);
  });

  it('flags a plugin that returns its best bad guess for a term in no document', async () => {
    const empty: KnowledgePassage = {
      id: 'invented',
      sourceId: 'policy',
      text: 'Something vaguely related.',
      score: 0.2,
    };
    const failures = await run((result) => {
      if (!result.passages.length) result.passages.push(empty);
    }, 'absent from the corpus');
    expect(messages(failures)).toMatch(/passages came back for a term in no document/);
  });
});

describe('knowledge@1 rejects a backend that ignores the caller’s restrictions', () => {
  it('flags sourceIds accepted and ignored', async () => {
    const failures = await run((result, query) => {
      // Re-label everything back to the unrestricted source, as a backend that filters nothing would.
      if (query.sourceIds.length)
        for (const passage of result.passages) passage.sourceId = query.sourceIds[0]!;
      else for (const passage of result.passages) passage.sourceId = 'policy';
    }, 'sourceIds restricts');
    expect(messages(failures)).toMatch(/did not reach both sources/);
  });

  it('flags an unknown sourceId answered with silence instead of a failure', async () => {
    const quiet: KnowledgeFactory = ({ sources }) => {
      const real = new InlineKnowledge({ sources, maxPassageCharacters: 2_000 });
      return {
        async search(query, options) {
          if (query.sourceIds.some((id) => id === 'not_a_source'))
            return { revision: 'quiet', passages: [] };
          return real.search(query, options);
        },
      };
    };
    const failures = await checkKnowledge(quiet, {}, { only: ['unknown sourceId'] });
    expect(messages(failures)).toMatch(/returned 0 passages instead of failing/);
  });

  it('flags topK exceeded', async () => {
    const failures = await run((result) => {
      result.passages.push(
        { ...result.passages[0]!, id: 'extra-1', score: 0 },
        { ...result.passages[0]!, id: 'extra-2', score: 0 },
      );
    }, 'topK is a ceiling');
    expect(messages(failures)).toMatch(/passages for a topK of|came back for topK 1/);
  });
});

describe('knowledge@1 rejects a score no threshold could be set against', () => {
  it('flags a constant score, which makes one authored minScore meaningless', async () => {
    const failures = await run((result) => {
      for (const passage of result.passages) passage.score = 0.5;
    }, 'comparable across two different queries');
    expect(messages(failures)).toMatch(
      /covering the whole query scored 0.5, covering part of it scored 0.5/,
    );
  });

  it('flags a score that rises when coverage falls', async () => {
    const failures = await run((result, query) => {
      // More query terms, higher score: an unnormalised sum, which is what BM25 would give.
      const terms = query.text.split(' ').length;
      for (const passage of result.passages) passage.score = Math.min(1, 0.3 * terms);
    }, 'comparable across two different queries');
    expect(messages(failures)).toMatch(/covering the whole query scored/);
  });
});

describe('knowledge@1 rejects provenance a reader could not check', () => {
  it('flags an invented citation', async () => {
    const failures = await run((result) => {
      for (const passage of result.passages) passage.citation = 'Section 12, Internal Handbook';
    }, 'points at what the author supplied');
    expect(messages(failures)).toMatch(/is not derived from any supplied title or citation/);
  });

  it('flags a citation invented for an untitled document', async () => {
    const failures = await run((result) => {
      for (const passage of result.passages)
        if (passage.sourceId === 'pricing') passage.citation = 'Price list, page 3';
    }, 'no invented one');
    expect(messages(failures)).toMatch(/an untitled document was given the citation/);
  });
});

describe('knowledge@1 rejects a corpus that cannot be traced', () => {
  it('flags a revision that changes for an unchanged corpus', async () => {
    let calls = 0;
    const failures = await run((result) => {
      result.revision = `rev-${++calls}`;
    }, 'revision is stable');
    expect(messages(failures)).toMatch(/the same corpus reported rev-1 then rev-2/);
  });

  it('flags a revision that stays put when the corpus changes', async () => {
    const failures = await run((result) => {
      result.revision = 'always-the-same';
    }, 'revision is stable');
    expect(messages(failures)).toMatch(/adding a document left the revision at always-the-same/);
  });

  it('flags a search that ignores an already-aborted signal', async () => {
    const deaf: KnowledgeFactory = ({ sources }) => {
      const real = new InlineKnowledge({ sources, maxPassageCharacters: 2_000 });
      return { search: (query) => real.search(query, { signal: new AbortController().signal }) };
    };
    const failures = await checkKnowledge(deaf, {}, { only: ['aborted search'] });
    expect(messages(failures)).toMatch(/an already-aborted search resolved with/);
  });
});

describe('the kit corpus is the kit’s own', () => {
  it('names a fresh token per call, so nothing can be special-cased', () => {
    const [first, second] = [corpusOf('aaa'), corpusOf('bbb')];
    expect(JSON.stringify(first)).toContain('alphaaaa');
    expect(JSON.stringify(second)).toContain('alphabbb');
    expect(JSON.stringify(first)).not.toContain('bbb');
  });
});
