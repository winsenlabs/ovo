import { describe, expect, it } from 'vitest';
import {
  InlineKnowledge,
  InlineKnowledgeRowConfig,
  chunkDocument,
  type InlineSource,
} from '../src/index.ts';

const live = () => new AbortController().signal;

const sources: InlineSource[] = [
  {
    id: 'collections',
    documents: [
      {
        id: 'promise',
        title: 'Promise to pay',
        citation: 'Collections SOP, section 2',
        text: [
          'A caller who promises a date is recorded as a promise to pay and no further call is made before that date.',
          '',
          'A caller who refuses outright is marked as a refusal and escalated to a field visit.',
        ].join('\n'),
      },
      {
        id: 'waiver',
        text: 'A late fee waiver requires a supervisor approval and is never offered on a first call.',
      },
    ],
  },
  {
    id: 'pricing',
    documents: [{ id: 'interest', text: 'Interest accrues daily at the contracted rate.' }],
  },
];

const search = (text: string, over: Record<string, unknown> = {}) =>
  new InlineKnowledge({ sources, maxPassageCharacters: 2_000 }).search(
    { text, topK: 5, sourceIds: [], ...over },
    { signal: live() },
  );

describe('ranking', () => {
  it('finds the passage that covers the question and cites the author’s own reference', async () => {
    const result = await search('what if the caller promises a date');
    expect(result.passages[0]!.id).toBe('promise#1');
    // Both paragraphs fit one passage at this budget, so the citation carries no "x of y".
    expect(result.passages[0]!.citation).toBe('Collections SOP, section 2');
    expect(result.passages[0]!.text).toContain('promise to pay');
  });

  it('scores full coverage of a query above partial coverage of the same passage', async () => {
    const focused = await search('waiver supervisor approval');
    const diluted = await search('waiver supervisor approval interest promises refusal escalated');
    const focusedScore = focused.passages.find((entry) => entry.id.startsWith('waiver'))!.score;
    const dilutedScore = diluted.passages.find((entry) => entry.id.startsWith('waiver'))!.score;
    expect(focusedScore).toBeGreaterThan(dilutedScore);
    // Bounded, which is what one authored `minScore` across every turn depends on.
    expect(focusedScore).toBeLessThanOrEqual(1);
  });

  it('gives a term in every passage no weight, without any stopword list', async () => {
    const common: InlineSource[] = [
      {
        id: 's',
        documents: [
          { id: 'a', text: 'the account is open' },
          { id: 'b', text: 'the account is closed' },
        ],
      },
    ];
    const port = new InlineKnowledge({ sources: common, maxPassageCharacters: 2_000 });
    // 'the', 'account' and 'is' appear in both, so only 'closed' can separate them.
    const result = await port.search(
      { text: 'the account is closed', topK: 2, sourceIds: [] },
      { signal: live() },
    );
    expect(result.passages[0]!.id).toBe('b#1');
    expect(result.passages[0]!.score).toBeGreaterThan(result.passages[1]?.score ?? 0);
  });

  it('returns nothing for a question whose every term is absent', async () => {
    expect((await search('mortgage prepayment penalty')).passages).toEqual([]);
  });

  it('returns nothing rather than dividing by zero for a query of only unknown words', async () => {
    expect((await search('zzzqqq wwwxxx')).passages).toEqual([]);
  });

  it('restricts to the requested source', async () => {
    const result = await search('rate', { sourceIds: ['pricing'] });
    expect(result.passages.every((entry) => entry.sourceId === 'pricing')).toBe(true);
  });

  it('refuses a source it does not have, instead of answering with silence', async () => {
    await expect(search('rate', { sourceIds: ['collections', 'nope'] })).rejects.toThrow(
      /no source named nope/,
    );
  });

  it('honours topK as a ceiling', async () => {
    expect((await search('caller', { topK: 1 })).passages.length).toBeLessThanOrEqual(1);
  });

  it('rejects an already-aborted search', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(
      new InlineKnowledge({ sources, maxPassageCharacters: 2_000 }).search(
        { text: 'caller', topK: 1, sourceIds: [] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });
});

describe('revision', () => {
  it('is identical for the same corpus and different for a changed one', () => {
    const first = new InlineKnowledge({ sources, maxPassageCharacters: 2_000 }).revision;
    const again = new InlineKnowledge({ sources, maxPassageCharacters: 2_000 }).revision;
    expect(first).toBe(again);
    const edited = structuredClone(sources);
    edited[0]!.documents[1]!.text += ' Supervisors are named in appendix C.';
    expect(new InlineKnowledge({ sources: edited, maxPassageCharacters: 2_000 }).revision).not.toBe(
      first,
    );
  });

  it('changes when the same text moves to a different source', () => {
    const moved: InlineSource[] = [{ id: 'elsewhere', documents: [sources[1]!.documents[0]!] }];
    const here: InlineSource[] = [{ id: 'pricing', documents: [sources[1]!.documents[0]!] }];
    expect(new InlineKnowledge({ sources: moved, maxPassageCharacters: 2_000 }).revision).not.toBe(
      new InlineKnowledge({ sources: here, maxPassageCharacters: 2_000 }).revision,
    );
  });
});

describe('chunking', () => {
  it('splits on the author’s own paragraph boundaries', () => {
    // 20 characters: each clause fits alone, no two fit together.
    const chunks = chunkDocument(
      { id: 'd', text: 'First clause.\n\nSecond clause.\n\nThird clause.' },
      's',
      20,
    );
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      'First clause.',
      'Second clause.',
      'Third clause.',
    ]);
  });

  it('packs short paragraphs together up to the budget', () => {
    const chunks = chunkDocument({ id: 'd', text: 'Aaa.\n\nBbb.\n\nCcc.' }, 's', 200);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('Aaa.\n\nBbb.\n\nCcc.');
  });

  it('splits an over-long paragraph on sentence boundaries, not mid-sentence', () => {
    const chunks = chunkDocument(
      { id: 'd', text: 'One sentence here. Two sentences here. Three sentences here.' },
      's',
      40,
    );
    expect(chunks.every((chunk) => chunk.text.trim().endsWith('.'))).toBe(true);
  });

  it('never halves a surrogate pair when there is nothing left to split on', () => {
    const chunks = chunkDocument({ id: 'd', text: '🙂'.repeat(10) }, 's', 4);
    expect(chunks.every((chunk) => !chunk.text.includes('�'))).toBe(true);
    expect(chunks.map((chunk) => [...chunk.text].length)).toEqual([4, 4, 2]);
  });

  it('numbers a citation only when a document produced more than one passage', () => {
    const one = chunkDocument({ id: 'd', title: 'Policy', text: 'Short.' }, 's', 100);
    expect(one[0]!.citation).toBe('Policy');
    const many = chunkDocument({ id: 'd', title: 'Policy', text: 'A.\n\nB.' }, 's', 3);
    expect(many.map((chunk) => chunk.citation)).toEqual(['Policy (1 of 2)', 'Policy (2 of 2)']);
  });

  it('invents no citation for a document with neither title nor citation', () => {
    expect(chunkDocument({ id: 'd', text: 'Short.' }, 's', 100)[0]!.citation).toBeUndefined();
  });
});

describe('the corpus on the release', () => {
  it('refuses a repeated source id, which would make a restriction ambiguous', () => {
    expect(
      () =>
        new InlineKnowledge({
          sources: [sources[0]!, { ...sources[0]! }],
          maxPassageCharacters: 2_000,
        }),
    ).toThrow(/source collections is repeated/);
  });

  it('refuses a repeated document id, which would make a passage id ambiguous', () => {
    expect(
      () =>
        new InlineKnowledge({
          sources: [
            {
              id: 's',
              documents: [
                { id: 'a', text: 'x' },
                { id: 'a', text: 'y' },
              ],
            },
          ],
          maxPassageCharacters: 2_000,
        }),
    ).toThrow(/document a is repeated/);
  });

  it('caps the corpus, because a release is snapshotted and shipped', () => {
    expect(() => InlineKnowledgeRowConfig.parse({ sources: [] })).toThrow();
    expect(() =>
      InlineKnowledgeRowConfig.parse({
        sources: [{ id: 's', documents: [{ id: 'a', text: 'x'.repeat(20_001) }] }],
      }),
    ).toThrow();
    expect(() =>
      InlineKnowledgeRowConfig.parse({
        sources: Array.from({ length: 21 }, (_, index) => ({
          id: `s${index}`,
          documents: [{ id: 'a', text: 'x' }],
        })),
      }),
    ).toThrow();
  });

  it('refuses a source id that is not a usable key', () => {
    expect(() =>
      InlineKnowledgeRowConfig.parse({
        sources: [{ id: 'Not An Id', documents: [{ id: 'a', text: 'x' }] }],
      }),
    ).toThrow();
  });
});
