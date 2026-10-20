import type { Rate, RoutingScorecard } from '../wire/index.ts';

/**
 * How far a rate may move before the gate fails, as a fraction (0.02 = two points). Absent keys
 * are zero: the offline corpus is deterministic, so any movement is a change in the router.
 */
export interface RoutingThresholds {
  /** Each accuracy rate may fall by at most this. */
  accuracy?: number;
  fallbackRate?: number;
  clarifyRate?: number;
  endRate?: number;
  /** Passed cases may drop by at most this many. */
  passed?: number;
  /** Compare a scorecard of a different corpus or snapshot digest (rates are then not like for like). */
  allowCorpusChange?: boolean;
}

export interface RoutingGateResult {
  ok: boolean;
  failures: string[];
}

const EPSILON = 1e-9;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/**
 * Whether `candidate` may replace `baseline`: no fewer cases pass, no case that passed now fails,
 * no accuracy rate falls and no fallback, clarify or end rate rises beyond `thresholds`. A baseline
 * measured on another corpus or release is stale and fails unless the thresholds allow it.
 */
export function routingScorecardGate(
  baseline: RoutingScorecard,
  candidate: RoutingScorecard,
  thresholds: RoutingThresholds = {},
): RoutingGateResult {
  const failures: string[] = [];
  const stale = (what: string) =>
    failures.push(
      `${what} changed since the baseline was saved: regenerate it with --save-baseline`,
    );
  if (!thresholds.allowCorpusChange) {
    if (baseline.corpus.digest !== candidate.corpus.digest) stale('the corpus');
    if (baseline.routing.digest !== candidate.routing.digest) stale('the routing snapshot');
  }
  const dropped = baseline.totals.passed - candidate.totals.passed;
  if (dropped > (thresholds.passed ?? 0))
    failures.push(`passed cases fell from ${baseline.totals.passed} to ${candidate.totals.passed}`);
  const known = new Set(baseline.failures.map((failure) => failure.id));
  for (const failure of candidate.failures)
    if (!known.has(failure.id))
      failures.push(`case ${failure.id} passed in the baseline and now fails`);
  const fell = (name: string, was: Rate, now: Rate, slack = 0) => {
    if (was.rate !== null && (now.rate ?? 0) < was.rate - slack - EPSILON)
      failures.push(
        `${name} fell from ${pct(was.rate)} to ${now.rate === null ? 'n/a' : pct(now.rate)}`,
      );
  };
  const rose = (name: string, was: Rate, now: Rate, slack = 0) => {
    if (now.rate !== null && now.rate > (was.rate ?? 0) + slack + EPSILON)
      failures.push(
        `${name} rose from ${was.rate === null ? 'n/a' : pct(was.rate)} to ${pct(now.rate)}`,
      );
  };
  for (const key of Object.keys(baseline.accuracy) as (keyof RoutingScorecard['accuracy'])[])
    fell(`${key} accuracy`, baseline.accuracy[key], candidate.accuracy[key], thresholds.accuracy);
  rose('fallback rate', baseline.fallbackRate, candidate.fallbackRate, thresholds.fallbackRate);
  rose('clarify rate', baseline.clarifyRate, candidate.clarifyRate, thresholds.clarifyRate);
  rose('end rate', baseline.endRate, candidate.endRate, thresholds.endRate);
  return { ok: failures.length === 0, failures };
}
