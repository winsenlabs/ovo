// Pure aggregation for the Evaluations screen: pass-rate trend and per-run bar shapes from
// `EvaluationRunRecord[]`. No fetching here.
import type { LineSeries } from '../../components/charts/line-chart';
import type { EvaluationDataset, EvaluationRunRecord } from '../operator-api';

const FINISHED = new Set(['succeeded', 'failed']);

/** One line series per dataset: pass rate (passed/total) of every finished run, oldest first. */
export function passRateTrend(
  runs: readonly EvaluationRunRecord[],
  datasets: readonly EvaluationDataset[],
): LineSeries[] {
  const nameOf = (id: string) => datasets.find((dataset) => dataset.id === id)?.name ?? id;
  const byDataset = new Map<string, { x: number; y: number }[]>();
  const sorted = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const run of sorted) {
    if (!FINISHED.has(run.status) || run.total === 0) continue;
    const points = byDataset.get(run.datasetId) ?? [];
    points.push({ x: new Date(run.createdAt).getTime(), y: run.passed / run.total });
    byDataset.set(run.datasetId, points);
  }
  return [...byDataset.entries()].map(([datasetId, points]) => ({
    key: datasetId,
    label: nameOf(datasetId),
    points,
  }));
}

/** Latest succeeded run's pass rate per dataset, for the KPI strip. */
export function latestPassRateByDataset(runs: readonly EvaluationRunRecord[]): Map<string, number> {
  const latest = new Map<string, EvaluationRunRecord>();
  for (const run of runs) {
    if (run.status !== 'succeeded') continue;
    const current = latest.get(run.datasetId);
    if (!current || run.createdAt > current.createdAt) latest.set(run.datasetId, run);
  }
  return new Map(
    [...latest].map(([datasetId, run]) => [datasetId, run.total ? run.passed / run.total : 0]),
  );
}

export function runsSince(
  runs: readonly EvaluationRunRecord[],
  days: number,
): EvaluationRunRecord[] {
  const cutoff = Date.now() - days * 86_400_000;
  return runs.filter((run) => new Date(run.createdAt).getTime() >= cutoff);
}

export function runDurationMs(run: EvaluationRunRecord): number | null {
  if (!run.completedAt) return null;
  return new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime();
}
