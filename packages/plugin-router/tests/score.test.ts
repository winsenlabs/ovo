import { describe, expect, it } from 'vitest';
import { exampleRoutingSnapshot } from '../src/testing.ts';
import { routingCorpusDigest, scoreRoutingCorpus } from '../src/eval/index.ts';
import { ROUTING_SCORECARD_SCHEMA, RoutingEvalCase } from '../src/wire/index.ts';
import { HAND_CASES } from './support-corpus.ts';

const snapshot = exampleRoutingSnapshot();
/** Durations 5, 10, 30, 5 and 50 ms, one pair of clock reads per case. */
function clock() {
  const reads = [0, 5, 5, 15, 15, 45, 45, 50, 50, 100];
  return () => reads.shift() ?? 0;
}
const score = (cases = HAND_CASES) =>
  scoreRoutingCorpus({
    snapshot,
    cases,
    name: 'hand',
    engineMode: 'recorded',
    flags: { transferEnabled: false, humanQueueEnabled: true },
    router: { timezone: 'Asia/Kolkata' },
    clock: clock(),
  });
const r = (correct: number, total: number) => ({
  correct,
  total,
  rate: total ? correct / total : null,
});

describe('scoreRoutingCorpus: a corpus worked out by hand', () => {
  it('counts what passed and what each field got right', async () => {
    const card = await score();
    expect(card.schema).toBe(ROUTING_SCORECARD_SCHEMA);
    expect(card.engineMode).toBe('recorded');
    expect(card.totals).toEqual({ cases: 5, passed: 4, failed: 1 });
    expect(card.corpus).toEqual({
      name: 'hand',
      digest: routingCorpusDigest(HAND_CASES),
      cases: 5,
    });
    expect(card.routing).toMatchObject({
      pointId: snapshot.routingPointId,
      routingReleaseId: null,
    });
    expect(card.accuracy).toEqual({
      overall: r(4, 5),
      status: r(5, 5),
      path: r(2, 2),
      node: r(2, 2),
      branch: r(2, 3),
      pool: r(2, 2),
      member: r(2, 3),
      agent: r(1, 1),
      queue: { correct: 0, total: 0, rate: null },
      language: r(1, 1),
    });
  });

  it('rates the fallbacks, clarifying questions and calls that ended', async () => {
    const card = await score();
    expect(card.fallbackRate).toEqual({ ...r(2, 5), byStep: { default: 1, end: 1 } });
    expect(card.clarifyRate).toEqual(r(1, 5));
    expect(card.endRate).toEqual(r(1, 5));
  });

  it('counts every engine attempt by outcome', async () => {
    const { perEngine } = await score();
    expect(perEngine.rules).toEqual({
      attempts: 10,
      matched: 5,
      no_match: 5,
      low_confidence: 0,
      timeout: 0,
      error: 0,
      disabled: 0,
    });
    expect(perEngine.llm).toEqual({
      attempts: 5,
      matched: 1,
      no_match: 2,
      low_confidence: 2,
      timeout: 0,
      error: 0,
      disabled: 0,
    });
    expect(
      perEngine.decision.attempts + perEngine.external.attempts + perEngine.context.attempts,
    ).toBe(0);
  });

  it('builds a confusion matrix per deciding engine, expected branch by chosen branch', async () => {
    expect((await score()).confusion).toEqual({
      rules: {
        labels: ['cards', 'sales', 'support'],
        matrix: [
          [1, 0, 0],
          [0, 0, 0],
          [0, 1, 1],
        ],
        correct: 2,
        total: 3,
      },
      llm: { labels: ['sales'], matrix: [[1]], correct: 1, total: 1 },
    });
  });

  it('buckets the confidence of matched model verdicts against correctness', async () => {
    expect((await score()).calibration).toEqual([
      { engine: 'llm', bucket: '0.9-1', n: 1, correct: 1 },
    ]);
  });

  it('breaks results down by node and by tag', async () => {
    const card = await score();
    expect(card.perNode).toEqual([
      { node: 'intent', cases: 5, decided: 4, correct: 2, fallbacks: 1 },
      { node: 'product', cases: 2, decided: 2, correct: 1, fallbacks: 1 },
    ]);
    expect(card.byTag).toEqual({
      clarify: { cases: 1, passed: 1 },
      end: { cases: 1, passed: 1 },
      fallback: { cases: 2, passed: 2 },
      sales: { cases: 2, passed: 1 },
      support: { cases: 1, passed: 1 },
      wrong: { cases: 1, passed: 0 },
    });
  });

  it('lists failures by id and field, never by what the caller said', async () => {
    const card = await score();
    expect(card.failures).toEqual([
      {
        id: 'c3',
        expected: { status: 'agent', branch: { intent: 'support' }, member: 'sales-hi' },
        actual: { status: 'agent', branch: { intent: 'sales' }, member: 'sales-en' },
        diff: [
          'branch: expected {"intent":"support"}, got {"intent":"sales"}',
          'member: expected "sales-hi", got "sales-en"',
        ],
      },
    ]);
    expect(JSON.stringify(card)).not.toContain('mujhe');
  });

  it('measures time with the clock it is given', async () => {
    expect((await score()).ms).toEqual({ total: 100, p50: 10, p95: 50 });
  });

  it('is deterministic: the same corpus gives the same scorecard', async () => {
    expect(JSON.stringify(await score())).toBe(JSON.stringify(await score()));
  });
});

describe('scoreRoutingCorpus: edges', () => {
  it('scores an empty corpus without dividing by zero', async () => {
    const card = await score([]);
    expect(card.totals).toEqual({ cases: 0, passed: 0, failed: 0 });
    expect(card.accuracy.overall).toEqual({ correct: 0, total: 0, rate: null });
    expect(card.failures).toEqual([]);
  });

  it('caps the failures at fifty', async () => {
    const wrong = RoutingEvalCase.parse({
      id: 'x',
      turns: [{ kind: 'dtmf', digits: '1' }],
      expect: { member: 'nobody' },
    });
    const cases = Array.from({ length: 60 }, (_, i) => ({ ...wrong, id: `x${i}` }));
    const card = await score(cases);
    expect(card.totals.failed).toBe(60);
    expect(card.failures).toHaveLength(50);
  });

  it('counts a callback as the fallback step the route reached', async () => {
    const card = await scoreRoutingCorpus({
      snapshot: exampleRoutingSnapshot((raw) => {
        raw.nodes[0].fallback = [{ kind: 'callback', inMinutes: 30, line: { en: 'Call back.' } }];
      }),
      cases: [
        RoutingEvalCase.parse({
          id: 'cb',
          turns: [{ kind: 'speech', text: 'umm' }],
          expect: { status: 'callback', fallback: 'callback' },
        }),
      ],
      name: 'cb',
      engineMode: 'recorded',
      flags: { transferEnabled: false, humanQueueEnabled: true },
      router: {},
    });
    expect(card.totals.passed).toBe(1);
    expect(card.fallbackRate.byStep).toEqual({ callback: 1 });
  });

  it('fails a case the simulator refuses, and carries on', async () => {
    const case1 = RoutingEvalCase.parse({
      id: 'long',
      turns: Array.from({ length: 9 }, () => ({ kind: 'speech', text: 'hello' })),
      expect: { status: 'agent' },
    });
    const card = await scoreRoutingCorpus({
      snapshot,
      cases: [case1, HAND_CASES[0]!],
      name: 'live',
      engineMode: 'live',
      flags: { transferEnabled: false, humanQueueEnabled: true },
      router: {},
      live: {
        mode: { llm: 'live' },
        ports: {
          inference: {
            model: 'm',
            generate: async () => ({
              kind: 'tool',
              toolId: 'ovo_route',
              input: { branch: 'sales', confidence: 0.9 },
            }),
          },
        },
      },
    });
    expect(card.engineMode).toBe('live');
    expect(card.failures[0]).toMatchObject({
      id: 'long',
      diff: expect.arrayContaining(['run: live_turns_exceeded']),
    });
  });
});

describe('routingCorpusDigest', () => {
  it('is the same for the same cases and changes with any of them', () => {
    expect(routingCorpusDigest(HAND_CASES)).toMatch(/^[0-9a-f]{64}$/);
    expect(routingCorpusDigest(HAND_CASES)).toBe(routingCorpusDigest(structuredClone(HAND_CASES)));
    const edited = structuredClone(HAND_CASES);
    edited[0]!.expect.member = 'sales-en';
    expect(routingCorpusDigest(edited)).not.toBe(routingCorpusDigest(HAND_CASES));
    expect(routingCorpusDigest(HAND_CASES.slice(0, 4))).not.toBe(routingCorpusDigest(HAND_CASES));
  });
});
