import { describe, expect, it } from 'vitest';
import {
  EvalRunRequest,
  RoutingEvalCase,
  RoutingEvalRun,
  RoutingEvalRunSummary,
  RoutingScorecard,
  ROUTING_SCORECARD_SCHEMA,
} from '../src/index.ts';
import { POINT_ID, SALES_EN_RELEASE } from './routing-fixture.ts';

const accepts = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true);
const rejects = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);

const release = { kind: 'release', routingReleaseId: SALES_EN_RELEASE };

describe('RoutingEvalCase', () => {
  const base = { id: 'sales-hi', expect: { status: 'agent' } };

  it('accepts a minimal case and fills defaults', () => {
    const parsed = RoutingEvalCase.parse(base);
    expect(parsed).toMatchObject({ tags: [], turns: [], answers: [], call: { variables: {} } });
  });

  it('accepts a full case', () => {
    accepts(RoutingEvalCase, {
      id: 'sales.hi-1',
      description: 'Hindi sales',
      tags: ['sales', 'fallback'],
      call: { from: '+919812345678' },
      turns: [{ kind: 'speech', text: 'mujhe naya credit card chahiye' }],
      answers: [
        { node: 'intent', engine: 'llm', branch: 'sales', confidence: 0.91, language: 'hi' },
      ],
      faults: { queues: { desk: 'queue_closed' } },
      expect: {
        status: 'agent',
        path: ['intent'],
        node: 'intent',
        branches: { intent: 'sales' },
        pool: 'Sales',
        member: 'sales-hi',
        agentId: 'sales-hi',
        queue: 'desk',
        language: 'hi',
        fallback: 'none',
        clarify: false,
      },
    });
  });

  it('rejects bad ids, an empty expectation and unknown expectation fields', () => {
    rejects(RoutingEvalCase, { ...base, id: 'Sales' });
    rejects(RoutingEvalCase, { ...base, id: '' });
    rejects(RoutingEvalCase, { ...base, id: 'x'.repeat(81) });
    rejects(RoutingEvalCase, { ...base, expect: {} });
    rejects(RoutingEvalCase, { ...base, expect: { vibes: 'good' } });
    rejects(RoutingEvalCase, { ...base, expect: { status: 'undecided' } });
    rejects(RoutingEvalCase, { ...base, expect: { fallback: 'panic' } });
    rejects(RoutingEvalCase, { ...base, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) });
    rejects(RoutingEvalCase, { ...base, expect: undefined });
    rejects(RoutingEvalCase, { ...base, extra: true });
  });
});

const rate = (correct: number, total: number) => ({
  correct,
  total,
  rate: total ? correct / total : null,
});
const tally = {
  attempts: 2,
  matched: 1,
  no_match: 1,
  low_confidence: 0,
  timeout: 0,
  error: 0,
  disabled: 0,
};

function scorecardFixture(): RoutingScorecard {
  return {
    schema: ROUTING_SCORECARD_SCHEMA,
    engineMode: 'recorded',
    corpus: { name: 'worked-example', digest: 'a'.repeat(64), cases: 2 },
    routing: { pointId: POINT_ID, routingReleaseId: SALES_EN_RELEASE, digest: 'b'.repeat(64) },
    totals: { cases: 2, passed: 1, failed: 1 },
    accuracy: {
      overall: rate(1, 2),
      status: rate(2, 2),
      path: rate(1, 2),
      node: rate(1, 1),
      branch: rate(1, 2),
      pool: rate(0, 0),
      member: rate(0, 0),
      agent: rate(0, 0),
      queue: rate(0, 0),
      language: rate(1, 1),
    },
    fallbackRate: { ...rate(1, 2), byStep: { default: 1 } },
    clarifyRate: rate(1, 2),
    endRate: rate(0, 2),
    perEngine: { rules: tally, decision: tally, llm: tally, external: tally, context: tally },
    confusion: {
      llm: {
        labels: ['sales', 'support', 'none'],
        matrix: [
          [1, 0, 0],
          [0, 0, 1],
          [0, 0, 0],
        ],
        correct: 1,
        total: 2,
      },
    },
    calibration: [{ engine: 'llm', bucket: '0.9-1', n: 1, correct: 1 }],
    perNode: [{ node: 'intent', cases: 2, decided: 2, correct: 1, fallbacks: 1 }],
    byTag: { sales: { cases: 1, passed: 1 } },
    failures: [{ id: 'support-1', expected: { node: 'x' }, actual: { node: 'y' }, diff: ['node'] }],
    ms: { total: 12, p50: 5, p95: 7 },
  };
}

describe('RoutingScorecard', () => {
  it('accepts a complete scorecard and an empty-rate one', () => {
    accepts(RoutingScorecard, scorecardFixture());
    const empty = scorecardFixture();
    empty.accuracy.pool = rate(0, 0);
    expect(empty.accuracy.pool.rate).toBeNull();
    accepts(RoutingScorecard, empty);
  });

  it('rejects a wrong schema, rates over 1, a missing engine and more than 50 failures', () => {
    rejects(RoutingScorecard, { ...scorecardFixture(), schema: 'ovo.routing-scorecard/0' });
    rejects(RoutingScorecard, { ...scorecardFixture(), engineMode: 'guessed' });
    const over = scorecardFixture();
    over.accuracy.overall = { correct: 3, total: 2, rate: 1.5 };
    rejects(RoutingScorecard, over);
    const noEngine = scorecardFixture() as unknown as { perEngine: Record<string, unknown> };
    delete noEngine.perEngine.llm;
    rejects(RoutingScorecard, noEngine);
    const many = scorecardFixture();
    many.failures = Array.from({ length: 51 }, (_, i) => ({
      id: `c${i}`,
      expected: {},
      actual: {},
      diff: [],
    }));
    rejects(RoutingScorecard, many);
    rejects(RoutingScorecard, {
      ...scorecardFixture(),
      calibration: [{ engine: 'rules', bucket: '0-0.5', n: 1, correct: 0 }],
    });
  });
});

describe('eval run wire shapes', () => {
  const summary = {
    id: POINT_ID,
    name: 'Nightly',
    routingReleaseId: SALES_EN_RELEASE,
    routingPointId: POINT_ID,
    releaseVersion: 3,
    createdAt: '2026-10-20T10:00:00.000Z',
    createdBy: 'user-1',
    engineMode: 'recorded',
    caseCount: 2,
    headline: { passed: 1, total: 2, accuracy: 0.5, fallbackRate: null, clarifyRate: 0 },
  };

  it('accepts a run request, a summary and a full run', () => {
    accepts(EvalRunRequest, {
      routingReleaseId: SALES_EN_RELEASE,
      name: 'Nightly',
      cases: [{ id: 'a', expect: { status: 'agent' } }],
    });
    accepts(RoutingEvalRunSummary, summary);
    accepts(RoutingEvalRun, {
      ...summary,
      corpusDigest: 'c'.repeat(64),
      scorecard: scorecardFixture(),
    });
  });

  it('rejects an empty or oversized corpus, a blank name, live mode and a bad digest', () => {
    const request = {
      routingReleaseId: SALES_EN_RELEASE,
      name: 'n',
      cases: [{ id: 'a', expect: { status: 'agent' } }],
    };
    rejects(EvalRunRequest, { ...request, cases: [] });
    rejects(EvalRunRequest, {
      ...request,
      cases: Array.from({ length: 501 }, (_, i) => ({ id: `c${i}`, expect: { status: 'agent' } })),
    });
    rejects(EvalRunRequest, { ...request, name: '  ' });
    rejects(EvalRunRequest, { ...request, cases: [{ id: 'a', expect: {} }] });
    rejects(EvalRunRequest, { ...request, extra: 1 });
    rejects(RoutingEvalRunSummary, { ...summary, engineMode: 'live' });
    rejects(RoutingEvalRunSummary, { ...summary, caseCount: 0 });
    rejects(RoutingEvalRun, { ...summary, corpusDigest: 'xyz', scorecard: scorecardFixture() });
  });
});
