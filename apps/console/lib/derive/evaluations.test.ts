import { expect, it } from 'vitest';
import {
  failedRunPoints,
  latestPassRateByDataset,
  passRateTrend,
  runDurationMs,
  runsSince,
} from './evaluations';
import type { EvaluationDataset, EvaluationRunRecord } from '../operator-api';

const dataset = (id: string, name: string): EvaluationDataset => ({
  id,
  name,
  description: '',
  currentVersion: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

const run = (overrides: Partial<EvaluationRunRecord>): EvaluationRunRecord => ({
  id: 'r1',
  datasetId: 'd1',
  datasetVersion: 1,
  datasetFingerprint: 'fp',
  releaseId: 'rel1',
  releaseFingerprint: 'rfp',
  fixtureBindingVersion: '1',
  executorKind: 'fixture',
  status: 'succeeded',
  attempt: 1,
  maxAttempts: 1,
  passed: 9,
  failed: 1,
  total: 10,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  ...overrides,
});

it('builds a pass-rate point per finished run, sorted oldest first', () => {
  const runs = [
    run({ id: 'r2', createdAt: '2026-10-11T00:00:00.000Z', passed: 8, total: 10 }),
    run({ id: 'r1', createdAt: '2026-10-10T00:00:00.000Z', passed: 9, total: 10 }),
  ];
  const series = passRateTrend(runs, [dataset('d1', 'Core flows')]);
  expect(series).toEqual([
    {
      key: 'd1',
      label: 'Core flows',
      points: [
        { x: Date.parse('2026-10-10T00:00:00.000Z'), y: 0.9 },
        { x: Date.parse('2026-10-11T00:00:00.000Z'), y: 0.8 },
      ],
    },
  ]);
});

it('skips queued/running/cancelled runs and zero-total runs in the trend', () => {
  const runs = [run({ status: 'queued' }), run({ total: 0, passed: 0 })];
  expect(passRateTrend(runs, [])).toEqual([]);
});

it('keeps a failed run off the pass-rate trend line, as a failed-run point instead', () => {
  const runs = [
    run({ id: 'r1', createdAt: '2026-10-10T00:00:00.000Z', passed: 9, total: 10 }),
    run({
      id: 'r2',
      status: 'failed',
      createdAt: '2026-10-11T00:00:00.000Z',
      passed: 0,
      total: 10,
    }),
  ];
  const series = passRateTrend(runs, [dataset('d1', 'Core flows')]);
  expect(series).toEqual([
    {
      key: 'd1',
      label: 'Core flows',
      points: [{ x: Date.parse('2026-10-10T00:00:00.000Z'), y: 0.9 }],
    },
  ]);
  expect(failedRunPoints(runs, [dataset('d1', 'Core flows')])).toEqual([
    {
      runId: 'r2',
      datasetId: 'd1',
      datasetName: 'Core flows',
      at: Date.parse('2026-10-11T00:00:00.000Z'),
    },
  ]);
});

it('keeps only the latest succeeded run per dataset for the KPI strip', () => {
  const runs = [
    run({ id: 'r1', createdAt: '2026-10-10T00:00:00.000Z', passed: 5, total: 10 }),
    run({ id: 'r2', createdAt: '2026-10-11T00:00:00.000Z', passed: 9, total: 10 }),
    run({ id: 'r3', status: 'failed', createdAt: '2026-10-12T00:00:00.000Z' }),
  ];
  expect(latestPassRateByDataset(runs)).toEqual(new Map([['d1', 0.9]]));
});

it('filters runs to the last N days', () => {
  const now = Date.now();
  const runs = [
    run({ id: 'old', createdAt: new Date(now - 10 * 86_400_000).toISOString() }),
    run({ id: 'recent', createdAt: new Date(now - 1 * 86_400_000).toISOString() }),
  ];
  expect(runsSince(runs, 7).map((r) => r.id)).toEqual(['recent']);
});

it('computes a run duration only once it has completed', () => {
  expect(
    runDurationMs(
      run({ createdAt: '2026-10-10T00:00:00.000Z', completedAt: '2026-10-10T00:00:05.000Z' }),
    ),
  ).toBe(5000);
  expect(runDurationMs(run({ completedAt: undefined }))).toBeNull();
});
