// Pure shaping for the Evaluations "Routing" tab: the trend lines, the headline KPIs of the
// latest run and the rows of the run drawer's tables. Reads the scorecard as served, adds nothing.
import type { LineSeries } from '../charts/line-chart';
import {
  ACCURACY_FIELDS,
  ENGINE_KEYS,
  type ConfusionMatrix,
  type RoutingEvalRunSummary,
  type RoutingScorecard,
} from '../../lib/data/routing-eval-api';

/** Runs oldest first: the order a trend line reads in. */
export const oldestFirst = (runs: readonly RoutingEvalRunSummary[]) =>
  [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

/** Accuracy and fallback rate per run, as two lines over time (runs without a rate are skipped). */
export function trendSeries(runs: readonly RoutingEvalRunSummary[]): LineSeries[] {
  const ordered = oldestFirst(runs);
  const line = (
    key: string,
    label: string,
    pick: (run: RoutingEvalRunSummary) => number | null,
  ): LineSeries => ({
    key,
    label,
    points: ordered.flatMap((run) => {
      const y = pick(run);
      const x = Date.parse(run.createdAt);
      return y == null || !Number.isFinite(x) ? [] : [{ x, y }];
    }),
  });
  return [
    line('accuracy', 'Accuracy', (run) => run.headline.accuracy),
    line('fallback', 'Fallback rate', (run) => run.headline.fallbackRate),
  ].filter((series) => series.points.length > 0);
}

export function latestRun(runs: readonly RoutingEvalRunSummary[]) {
  return oldestFirst(runs).at(-1);
}

export interface AccuracyRow {
  field: string;
  correct: number;
  total: number;
  rate: number | null;
}

/** A field no case asserts has `total: 0` and is shown as not asserted, never as 0%. */
export function accuracyRows(scorecard: RoutingScorecard): AccuracyRow[] {
  return ACCURACY_FIELDS.flatMap((field) => {
    const rate = scorecard.accuracy[field];
    return rate ? [{ field, ...rate }] : [];
  });
}

export function engineRows(scorecard: RoutingScorecard) {
  return ENGINE_KEYS.flatMap((engine) => {
    const counts = scorecard.perEngine[engine];
    return counts ? [{ engine, ...counts }] : [];
  });
}

export interface MatrixCell {
  value: number;
  diagonal: boolean;
  /** 0 to 1: the cell's share of its row (what was expected), which drives the shading. */
  share: number;
}

/** Rows are the expected branch, columns the branch chosen; the diagonal is correct. */
export function matrixCells(confusion: ConfusionMatrix): MatrixCell[][] {
  return confusion.matrix.map((row, rowIndex) => {
    const total = row.reduce((sum, value) => sum + value, 0);
    return row.map((value, columnIndex) => ({
      value,
      diagonal: rowIndex === columnIndex,
      share: total ? value / total : 0,
    }));
  });
}

const show = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

/** `key=value` pairs of an expected or actual record, for the failures table. */
export function describeRecord(record: Record<string, unknown>): string {
  const entries = Object.entries(record);
  return entries.length
    ? entries.map(([key, value]) => `${key}=${show(value)}`).join(', ')
    : 'nothing';
}
