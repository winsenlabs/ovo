import type { RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import { simulateRoute, SimulationInputError, type SimulateInput } from '../simulate/index.ts';
import {
  ROUTING_EVAL_LIMITS,
  ROUTING_SCORECARD_SCHEMA,
  type Rate,
  type RoutingEvalCase,
  type RoutingScorecard,
} from '../wire/index.ts';
import { actualOf, blankActual, type CaseActual } from './actual.ts';
import { checkCase, FIELDS, type CaseCheck } from './check.ts';
import { routingCorpusDigest, routingSnapshotDigest } from './digest.ts';
import { FALLBACK_STEPS, type FallbackStepName } from './types.ts';
import {
  calibrationOf,
  confusionOf,
  countEngines,
  decisionsOf,
  nodesOf,
  rate,
  type Decision,
} from './tallies.ts';

/** The clock a case starts at when it sets no `call.at`: Thursday noon in Kolkata, so a corpus never reads the real time. */
export const EVAL_DEFAULT_NOW = Date.UTC(2026, 9, 15, 6, 30);

export interface ScoreInput {
  snapshot: RoutingReleaseSnapshot;
  cases: readonly RoutingEvalCase[];
  name: string;
  /** `recorded`: engine answers are scripted. `live`: `live` supplies real engines (CLI `--live`). */
  engineMode: RoutingScorecard['engineMode'];
  /** The switches the run assumes; a function chooses them per case (a tag can change the assumption). */
  flags: SimulateInput['flags'] | ((testcase: RoutingEvalCase) => SimulateInput['flags']);
  router: SimulateInput['router'];
  routingReleaseId?: string | null;
  /** Engines that run for real in every case, with their implementations. */
  live?: {
    mode: Partial<Record<'decision' | 'llm' | 'external', 'live'>>;
    ports: NonNullable<SimulateInput['live']>;
  };
  now?: number;
  /** Milliseconds for `ms`; the default is the real clock. A test passes a fake one. */
  clock?: () => number;
}

interface Scored {
  testcase: RoutingEvalCase;
  actual: CaseActual;
  check: CaseCheck;
  decisions: Decision[];
}

async function runCase(input: ScoreInput, testcase: RoutingEvalCase): Promise<Scored> {
  const mode = { decision: 'mock', llm: 'mock', external: 'mock', ...input.live?.mode } as const;
  const base = {
    snapshot: input.snapshot,
    request: {
      call: testcase.call,
      turns: testcase.turns,
      engines: { mode, answers: testcase.answers },
      faults: testcase.faults,
      load: 'empty' as const,
      assume: {},
    },
    now: input.now ?? EVAL_DEFAULT_NOW,
    router: input.router,
    flags: typeof input.flags === 'function' ? input.flags(testcase) : input.flags,
    ...(input.live ? { live: input.live.ports } : {}),
    ...(input.routingReleaseId ? { routingReleaseId: input.routingReleaseId } : {}),
  };
  try {
    const actual = actualOf(await simulateRoute(base), input.snapshot);
    return {
      testcase,
      actual,
      check: checkCase(testcase.expect, actual),
      decisions: decisionsOf(testcase.expect.branches, actual),
    };
  } catch (error) {
    // A case the simulator refuses (a live run past the turn limit) fails; it never stops the corpus.
    if (!(error instanceof SimulationInputError)) throw error;
    const check = checkCase(testcase.expect, blankActual());
    return {
      testcase,
      actual: blankActual(),
      check: { ...check, passed: false, diff: [`run: ${error.code}`, ...check.diff] },
      decisions: [],
    };
  }
}

const percentile = (sorted: readonly number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! : 0;

/**
 * Scores a routing corpus against a release (R4 design 5.6): every case runs through `simulateRoute`,
 * so scoring and the simulator cannot disagree, and the results become the scorecard. A case passes
 * when every field it asserts equals what happened. Offline engine answers are authored, so this
 * measures the tree, the rules and the pools; only `engineMode: 'live'` measures a model.
 */
export async function scoreRoutingCorpus(input: ScoreInput): Promise<RoutingScorecard> {
  const clock = input.clock ?? (() => performance.now());
  const scored: Scored[] = [];
  const times: number[] = [];
  for (const testcase of input.cases) {
    const started = clock();
    scored.push(await runCase(input, testcase));
    times.push(Math.max(0, clock() - started));
  }
  const total = scored.length;
  const passed = scored.filter((entry) => entry.check.passed).length;
  const field = (name: string): Rate => {
    const asserting = scored.filter((entry) => name in entry.check.fields);
    return rate(
      asserting.filter((entry) => entry.check.fields[name as keyof CaseCheck['fields']]).length,
      asserting.length,
    );
  };
  const accuracy = Object.fromEntries(FIELDS.map((name) => [name, field(name)])) as Omit<
    RoutingScorecard['accuracy'],
    'overall'
  >;
  const steps: Partial<Record<FallbackStepName, number>> = {};
  for (const step of FALLBACK_STEPS) {
    const n = scored.filter((entry) => entry.actual.fallback === step).length;
    if (n) steps[step] = n;
  }
  const decisions = scored.flatMap((entry) => entry.decisions);
  const sorted = [...times].sort((a, b) => a - b);
  const tags: RoutingScorecard['byTag'] = {};
  for (const { testcase, check } of scored)
    for (const tag of testcase.tags) {
      tags[tag] ??= { cases: 0, passed: 0 };
      tags[tag].cases += 1;
      if (check.passed) tags[tag].passed += 1;
    }
  return {
    schema: ROUTING_SCORECARD_SCHEMA,
    engineMode: input.engineMode,
    corpus: { name: input.name, digest: routingCorpusDigest(input.cases), cases: total },
    routing: {
      pointId: input.snapshot.routingPointId,
      routingReleaseId: input.routingReleaseId ?? null,
      digest: routingSnapshotDigest(input.snapshot),
    },
    totals: { cases: total, passed, failed: total - passed },
    accuracy: { overall: rate(passed, total), ...accuracy },
    fallbackRate: {
      ...rate(scored.filter((entry) => entry.actual.fallback !== 'none').length, total),
      byStep: steps,
    },
    clarifyRate: rate(scored.filter((entry) => entry.actual.clarify).length, total),
    endRate: rate(
      scored.filter((entry) => ['end', 'undecided'].includes(entry.actual.status)).length,
      total,
    ),
    perEngine: countEngines(scored.map((entry) => entry.actual)),
    confusion: confusionOf(decisions),
    calibration: calibrationOf(decisions),
    perNode: nodesOf(
      scored.map((e) => ({ actual: e.actual, expectations: e.testcase.expect.branches })),
    ),
    byTag: Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : 1))),
    failures: scored
      .filter((entry) => !entry.check.passed)
      .slice(0, ROUTING_EVAL_LIMITS.failures)
      .map(({ testcase, check }) => ({
        id: testcase.id,
        expected: check.expected,
        actual: check.actual,
        diff: check.diff,
      })),
    ms: {
      total: Math.round(times.reduce((sum, ms) => sum + ms, 0)),
      p50: Math.round(percentile(sorted, 0.5)),
      p95: Math.round(percentile(sorted, 0.95)),
    },
  };
}
