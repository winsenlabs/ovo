import { expect, it } from 'vitest';
import type { PerformanceGroupResult } from '@winsendotai/ovo-contracts';
import {
  autoBucket,
  compareByBars,
  distinctCohortValues,
  dominantStage,
  latestBucketFor,
  rangeTotals,
  resolvePerformanceRange,
  stageBreakdownBars,
  stageTimeSeries,
} from './performance';

const group = (overrides: Partial<PerformanceGroupResult>): PerformanceGroupResult => ({
  cohort: {},
  eventCount: 0,
  sampleCount: 0,
  callCount: 0,
  errors: 0,
  timeouts: 0,
  p50Ms: null,
  p95Ms: null,
  p99Ms: null,
  callIds: [],
  ...overrides,
});

const groups: PerformanceGroupResult[] = [
  group({
    cohort: { stage: 'stt', time: '2026-10-13T20:00:00.000Z' },
    sampleCount: 50,
    callCount: 10,
    errors: 1,
    timeouts: 0,
    p50Ms: 200,
    p95Ms: 400,
    p99Ms: 500,
    callIds: ['c1'],
  }),
  group({
    cohort: { stage: 'stt', time: '2026-10-13T21:00:00.000Z' },
    sampleCount: 60,
    callCount: 12,
    errors: 0,
    timeouts: 1,
    p50Ms: 210,
    p95Ms: 420,
    p99Ms: 510,
  }),
  group({
    cohort: { stage: 'llm', time: '2026-10-13T20:00:00.000Z' },
    sampleCount: 10,
    callCount: 10,
    p50Ms: 900,
    p95Ms: 1400,
    p99Ms: 1600,
  }),
];

it('picks the stage with the most samples, not a hardcoded name', () => {
  expect(dominantStage(groups)).toBe('stt');
});

it('finds the most recent time bucket for a stage', () => {
  expect(latestBucketFor(groups, 'stt')?.cohort.time).toBe('2026-10-13T21:00:00.000Z');
});

it('sums calls/errors/timeouts/samples across a stage', () => {
  expect(rangeTotals(groups, 'stt')).toEqual({ calls: 22, errors: 1, timeouts: 1, samples: 110 });
});

it('builds one sorted line series per stage', () => {
  const series = stageTimeSeries(groups, 'p95Ms');
  expect(series).toHaveLength(2);
  const stt = series.find((s) => s.key === 'stt')!;
  expect(stt.points.map((p) => p.y)).toEqual([400, 420]);
});

it('builds stage breakdown bars with p50 and p95', () => {
  expect(
    stageBreakdownBars(groups.filter((g) => g.cohort.time === '2026-10-13T20:00:00.000Z')),
  ).toEqual([
    { category: 'STT', values: { p50: 200, p95: 400 } },
    { category: 'LLM', values: { p50: 900, p95: 1400 } },
  ]);
});

it('flags low-sample cohorts in a compare-by view', () => {
  const compareGroups: PerformanceGroupResult[] = [
    group({ cohort: { provider: 'twilio' }, sampleCount: 5, p95Ms: 300 }),
    group({ cohort: { provider: 'exotel' }, sampleCount: 40, p95Ms: 200 }),
  ];
  expect(compareByBars(compareGroups, 'provider')).toEqual([
    { category: 'twilio', p95: 300, samples: 5, lowSample: true },
    { category: 'exotel', p95: 200, samples: 40, lowSample: false },
  ]);
});

it('picks an hourly bucket under 48h and a daily bucket beyond it', () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  expect(autoBucket(now - 24 * 3600_000, now)).toBe('hour');
  expect(autoBucket(now - 7 * 86_400_000, now)).toBe('day');
});

it('resolves a preset to a fromMs/toMs window ending now', () => {
  const { fromMs, toMs } = resolvePerformanceRange('24h', { from: '', to: '' });
  expect(toMs - fromMs).toBe(86_400_000);
});

it('resolves a custom range from explicit dates, falling back to 24h on bad input', () => {
  const custom = resolvePerformanceRange('custom', { from: '2026-10-01', to: '2026-10-02' });
  expect(custom.fromMs).toBe(Date.parse('2026-10-01'));
  expect(custom.toMs).toBe(Date.parse('2026-10-02'));
  const fallback = resolvePerformanceRange('custom', { from: 'not-a-date', to: '' });
  expect(fallback.toMs - fallback.fromMs).toBe(86_400_000);
});

it('collects distinct non-null cohort values for one dimension', () => {
  expect(
    distinctCohortValues(
      [
        group({ cohort: { provider: 'twilio' } }),
        group({ cohort: { provider: 'exotel' } }),
        group({ cohort: {} }),
      ],
      'provider',
    ),
  ).toEqual(['twilio', 'exotel']);
});
