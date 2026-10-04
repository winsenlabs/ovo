import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  AgentKnowledgePolicy,
  groundPassages,
  knowledgeQuery,
  renderPassages,
  validateKnowledgeExchange,
  type KnowledgePassage,
} from '../src/index.ts';

const policy = (over: Record<string, unknown> = {}) =>
  AgentKnowledgePolicy.parse({ enabled: true, minScore: 0.4, ...over });

const passage = (over: Partial<KnowledgePassage> = {}): KnowledgePassage => ({
  id: 'p1',
  sourceId: 'policy',
  text: 'A refund is issued within seven working days.',
  score: 0.9,
  ...over,
});

describe('the knowledge policy', () => {
  it('requires a threshold, because it decides what the agent treats as fact', () => {
    expect(() => AgentKnowledgePolicy.parse({ enabled: true })).toThrow();
    expect(policy().minScore).toBe(0.4);
  });

  it('asks for exactly the authored sources and depth', () => {
    expect(
      knowledgeQuery(policy({ topK: 3, sourceIds: ['policy'] }), 'how long for a refund'),
    ).toEqual({
      text: 'how long for a refund',
      topK: 3,
      sourceIds: ['policy'],
    });
  });

  it('bounds the retrieval deadline, because retrieval sits in front of the reply', () => {
    expect(policy().timeoutMs).toBe(1000);
    expect(() =>
      AgentKnowledgePolicy.parse({ enabled: true, minScore: 0.4, timeoutMs: 30_000 }),
    ).toThrow();
  });

  it('rides on AgentConfig so a release carries it', () => {
    const config = AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      knowledge: { enabled: true, minScore: 0.5, sourceIds: ['policy'] },
    });
    expect(config.knowledge?.sourceIds).toEqual(['policy']);
  });
});

describe('applying the threshold and the budget', () => {
  it('keeps passages at or above the threshold and counts what it dropped', () => {
    const result = groundPassages(policy(), {
      revision: 'r1',
      passages: [
        passage({ id: 'a', score: 0.9 }),
        passage({ id: 'b', score: 0.4 }),
        passage({ id: 'c', score: 0.39 }),
      ],
    });
    expect(result.used.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(result.belowThreshold).toBe(1);
    expect(result.revision).toBe('r1');
  });

  it('drops a passage whole rather than truncating it mid-sentence', () => {
    const long = 'x'.repeat(80);
    const result = groundPassages(policy({ maxCharacters: 100 }), {
      revision: 'r1',
      passages: [passage({ id: 'a', text: long }), passage({ id: 'b', text: long })],
    });
    expect(result.used.map((entry) => entry.id)).toEqual(['a']);
    // Half a clause of policy read back to a caller is worse than one passage fewer.
    expect(result.used[0]!.text).toHaveLength(80);
    expect(result.overBudget).toBe(1);
  });

  it('keeps a lower-ranked passage that still fits after a large one did not', () => {
    const result = groundPassages(policy({ maxCharacters: 100 }), {
      revision: 'r1',
      passages: [
        passage({ id: 'big', score: 0.9, text: 'x'.repeat(60) }),
        passage({ id: 'huge', score: 0.8, text: 'y'.repeat(60) }),
        passage({ id: 'small', score: 0.7, text: 'z'.repeat(30) }),
      ],
    });
    expect(result.used.map((entry) => entry.id)).toEqual(['big', 'small']);
    expect(result.overBudget).toBe(1);
  });

  it('counts the budget by code point, so an emoji costs one and not two', () => {
    // 100 code points, 200 UTF-16 units. Counting `.length` would drop a passage that fits.
    const result = groundPassages(policy({ maxCharacters: 100 }), {
      revision: 'r1',
      passages: [passage({ text: '🙂'.repeat(100) })],
    });
    expect(result.used).toHaveLength(1);
    expect(result.overBudget).toBe(0);
  });

  it('renders each passage with its citation so an answer can be traced', () => {
    const rendered = renderPassages([
      passage({ id: 'a', citation: 'Refund policy, clause 4' }),
      passage({ id: 'b', text: 'Arrears accrue interest.' }),
    ]);
    expect(rendered).toContain('[1] Refund policy, clause 4');
    // With no citation the source id is named, never a plausible-looking invention.
    expect(rendered).toContain('[2] policy');
  });
});

describe('the wire invariants a result alone cannot check', () => {
  const query = { text: 'refund', topK: 2, sourceIds: [] };

  it('refuses more passages than were asked for', () => {
    expect(() =>
      validateKnowledgeExchange(query, {
        revision: 'r',
        passages: [
          passage({ id: 'a' }),
          passage({ id: 'b', score: 0.8 }),
          passage({ id: 'c', score: 0.7 }),
        ],
      }),
    ).toThrow(/3 passages for a topK of 2/);
  });

  it('refuses passages that are not ranked best first', () => {
    expect(() =>
      validateKnowledgeExchange(query, {
        revision: 'r',
        passages: [passage({ id: 'a', score: 0.5 }), passage({ id: 'b', score: 0.9 })],
      }),
    ).toThrow(/not ordered by score/);
  });

  it('refuses a repeated passage, which would spend the budget twice on one fact', () => {
    expect(() =>
      validateKnowledgeExchange(query, { revision: 'r', passages: [passage(), passage()] }),
    ).toThrow(/repeated passage p1/);
  });

  it('refuses a passage from a source the caller excluded', () => {
    expect(() =>
      validateKnowledgeExchange(
        { ...query, sourceIds: ['pricing'] },
        { revision: 'r', passages: [passage({ sourceId: 'policy' })] },
      ),
    ).toThrow(/unrequested source policy/);
  });

  it('refuses a score outside [0,1], which no authored threshold could compare against', () => {
    expect(() =>
      validateKnowledgeExchange(query, { revision: 'r', passages: [passage({ score: 7.4 })] }),
    ).toThrow();
  });

  it('refuses a result with no revision, which could not be traced to a corpus', () => {
    expect(() => validateKnowledgeExchange(query, { passages: [passage()] })).toThrow();
  });
});
