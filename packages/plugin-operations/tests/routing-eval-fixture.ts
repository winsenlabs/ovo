import {
  ROUTING_SCORECARD_SCHEMA,
  type RoutingEvalCase,
  type RoutingScorecard,
} from '@winsendotai/ovo-contracts';

const rate = (correct: number, total: number) => ({
  correct,
  total,
  rate: total ? correct / total : null,
});
const tally = {
  attempts: 0,
  matched: 0,
  no_match: 0,
  low_confidence: 0,
  timeout: 0,
  error: 0,
  disabled: 0,
};

/** A scorecard of `passed` of `cases` cases, as the scorer would report it. */
export function scorecard(cases = 2, passed = 1): RoutingScorecard {
  return {
    schema: ROUTING_SCORECARD_SCHEMA,
    engineMode: 'recorded',
    corpus: { name: 'worked-example', digest: 'a'.repeat(64), cases },
    routing: { pointId: null, routingReleaseId: null, digest: 'b'.repeat(64) },
    totals: { cases, passed, failed: cases - passed },
    accuracy: {
      overall: rate(passed, cases),
      status: rate(passed, cases),
      path: rate(0, 0),
      node: rate(0, 0),
      branch: rate(0, 0),
      pool: rate(0, 0),
      member: rate(0, 0),
      agent: rate(0, 0),
      queue: rate(0, 0),
      language: rate(0, 0),
    },
    fallbackRate: { ...rate(0, cases), byStep: {} },
    clarifyRate: rate(1, cases),
    endRate: rate(0, cases),
    perEngine: { rules: tally, decision: tally, llm: tally, external: tally, context: tally },
    confusion: {},
    calibration: [],
    perNode: [],
    byTag: {},
    failures: [],
    ms: { total: 3, p50: 1, p95: 2 },
  };
}

export const cases = (count = 2): RoutingEvalCase[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `case-${i}`,
    tags: [],
    call: { variables: {} },
    turns: [{ kind: 'speech' as const, text: 'sales please' }],
    answers: [],
    faults: { fullMembers: [], failedReleases: [], queues: {} },
    expect: { status: 'agent' as const },
  }));
