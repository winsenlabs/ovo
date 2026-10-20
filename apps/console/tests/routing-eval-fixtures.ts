import type {
  EngineCounts,
  Rate,
  RoutingEvalRun,
  RoutingEvalRunSummary,
} from '../lib/data/routing-eval-api';

// ---- Wave 18: routing eval fixtures (`/v1/routing/eval-runs`) ----------------------------------

const rate = (correct: number, total: number): Rate => ({
  correct,
  total,
  rate: total ? correct / total : null,
});
const counts = (overrides: Partial<EngineCounts> = {}): EngineCounts => ({
  attempts: 0,
  matched: 0,
  no_match: 0,
  low_confidence: 0,
  timeout: 0,
  error: 0,
  disabled: 0,
  ...overrides,
});

export function evalSummary(overrides: Partial<RoutingEvalRunSummary> = {}): RoutingEvalRunSummary {
  return {
    id: 'run-1',
    name: 'Worked examples',
    routingReleaseId: 'rel-1',
    routingPointId: 'point-1',
    releaseVersion: 3,
    createdAt: '2026-10-19T09:00:00.000Z',
    createdBy: 'asha@sunrise.example',
    engineMode: 'recorded',
    caseCount: 45,
    headline: {
      passed: 43,
      total: 45,
      accuracy: 0.9556,
      fallbackRate: 0.1556,
      clarifyRate: 0.0667,
    },
    ...overrides,
  };
}

export function evalRun(overrides: Partial<RoutingEvalRun> = {}): RoutingEvalRun {
  return {
    ...evalSummary(),
    corpusDigest: 'a'.repeat(64),
    scorecard: {
      schema: 'ovo.routing-scorecard/1',
      engineMode: 'recorded',
      corpus: { name: 'worked-example', digest: 'a'.repeat(64), cases: 45 },
      routing: { pointId: 'point-1', routingReleaseId: 'rel-1', digest: 'b'.repeat(64) },
      totals: { cases: 45, passed: 43, failed: 2 },
      accuracy: {
        overall: rate(43, 45),
        status: rate(45, 45),
        path: rate(40, 42),
        node: rate(0, 0),
        branch: rate(31, 33),
        pool: rate(20, 20),
        member: rate(18, 20),
        agent: rate(0, 0),
        queue: rate(4, 4),
        language: rate(30, 30),
      },
      fallbackRate: { ...rate(7, 45), byStep: { default: 5, release_default: 2 } },
      clarifyRate: rate(3, 45),
      endRate: rate(2, 45),
      perEngine: {
        rules: counts({ attempts: 60, matched: 52, no_match: 8 }),
        llm: counts({ attempts: 33, matched: 28, low_confidence: 5 }),
      },
      confusion: {
        llm: {
          labels: ['sales', 'support', 'none'],
          matrix: [
            [18, 1, 0],
            [1, 9, 0],
            [0, 1, 3],
          ],
          correct: 30,
          total: 33,
        },
      },
      perNode: [
        { node: 'language', cases: 45, decided: 45, correct: 45, fallbacks: 0 },
        { node: 'intent', cases: 40, decided: 36, correct: 33, fallbacks: 7 },
      ],
      byTag: { sales: { cases: 12, passed: 12 } },
      failures: [
        {
          id: 'support-hi-low-confidence',
          expected: { status: 'agent', member: 'support-hi' },
          actual: { status: 'agent', member: 'support-en' },
          diff: ['member'],
        },
      ],
      ms: { total: 412, p50: 7, p95: 21 },
    },
    ...overrides,
  };
}
