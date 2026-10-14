// Before/after: a candidate scorecard against a baseline, metric by metric, for the aggregate and
// each call both ran, with the regression gate's verdict on each change.
import { METRICS, type MetricSpec } from '../score/metric-specs.ts';
import type { Metrics } from '../score/metrics.ts';
import type { Scorecard } from '../score/scorecard.ts';

/** How much worse a metric may get before the gate fails: absolute, in the metric's unit. */
export type Thresholds = Record<string, number>;

/**
 * The default gate. Counts are per call summed over the corpus, so a tolerance of 0 fails on any
 * increase; rates and latencies have room for replay noise (the modelled commits move endpoints by
 * tens of ms). Metrics not listed are reported, never gated.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  splitRate: 0.05,
  mergeRate: 0.05,
  falseEndpointRate: 0.05,
  droppedThoughts: 0,
  endpointP50Ms: 100,
  endpointP90Ms: 250,
  discardedReplies: 1,
  discardedLines: 2,
  llmPerTurn: 0.15,
  llmPerThought: 0.15,
  talkOver: 1,
  missedReplies: 0,
  missedTurnReplies: 1,
  cannedLines: 0,
  firstAnswerP50Ms: 150,
  firstAnswerP90Ms: 400,
  replyLatencyP50Ms: 150,
  replyLatencyP90Ms: 400,
  wer: 0.02,
  cer: 0.02,
  languageMismatches: 0,
  foreignSegments: 0,
};

export interface DiffRow {
  spec: MetricSpec;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  verdict: 'better' | 'worse' | 'same' | 'regression' | 'n/a';
  threshold?: number;
}

export interface CallDiff {
  call: string;
  rows: DiffRow[];
}

export interface ScorecardDiff {
  baseline: string;
  candidate: string;
  aggregate: DiffRow[];
  calls: CallDiff[];
  /** Gate failures: `scope metric: baseline → candidate (limit +x)`. */
  regressions: string[];
}

function row(
  spec: MetricSpec,
  a: number | null,
  b: number | null,
  thresholds: Thresholds,
): DiffRow {
  const threshold = thresholds[spec.key];
  if (a === null || b === null)
    return {
      spec,
      baseline: a,
      candidate: b,
      delta: null,
      verdict: 'n/a',
      ...(threshold === undefined ? {} : { threshold }),
    };
  const delta = b - a;
  const worse = spec.better === 'lower' ? delta : spec.better === 'higher' ? -delta : 0;
  const epsilon = 1e-9;
  const verdict =
    spec.better === 'info' || Math.abs(worse) <= epsilon
      ? 'same'
      : worse < 0
        ? 'better'
        : threshold !== undefined && worse > threshold + epsilon
          ? 'regression'
          : 'worse';
  return {
    spec,
    baseline: a,
    candidate: b,
    delta,
    verdict,
    ...(threshold === undefined ? {} : { threshold }),
  };
}

function rows(a: Metrics, b: Metrics, thresholds: Thresholds): DiffRow[] {
  return METRICS.map((spec) => row(spec, a[spec.key] ?? null, b[spec.key] ?? null, thresholds));
}

/**
 * The gate judges the aggregate, and each call for the metrics that must never get worse on any
 * call (missed replies, canned lines, dropped thoughts: tolerance 0).
 */
export function diffScorecards(
  baseline: Scorecard,
  candidate: Scorecard,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): ScorecardDiff {
  const aggregate = rows(baseline.aggregate, candidate.aggregate, thresholds);
  const calls: CallDiff[] = [];
  for (const call of candidate.calls) {
    const before = baseline.calls.find((entry) => entry.call === call.call);
    if (before)
      calls.push({ call: call.call, rows: rows(before.metrics, call.metrics, thresholds) });
  }
  const regressions: string[] = [];
  const describe = (scope: string, entry: DiffRow) =>
    `${scope} ${entry.spec.key}: ${entry.baseline} → ${entry.candidate} (limit +${entry.threshold})`;
  for (const entry of aggregate)
    if (entry.verdict === 'regression') regressions.push(describe('aggregate', entry));
  for (const call of calls)
    for (const entry of call.rows)
      if (entry.verdict === 'regression' && entry.threshold === 0)
        regressions.push(describe(call.call, entry));
  const missing = baseline.calls.filter(
    (entry) => !candidate.calls.some((c) => c.call === entry.call),
  );
  for (const entry of missing)
    regressions.push(`${entry.call}: in the baseline but not the candidate run`);
  return { baseline: baseline.label, candidate: candidate.label, aggregate, calls, regressions };
}
