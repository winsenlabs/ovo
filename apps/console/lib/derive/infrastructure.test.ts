import { expect, it } from 'vitest';
import { capacitySegments, isStale, pushHistory, quotaRatio } from './infrastructure';
import type { InfrastructureSnapshot } from '../operator-api';

const workers: InfrastructureSnapshot['workers'] = {
  ready: 2,
  busy: 3,
  reserved: 1,
  active: 3,
  starting: 0,
  draining: 0,
  total: 6,
  capacityCeiling: 10,
  freshestHeartbeatAt: null,
  heartbeatMaxAgeMs: 30_000,
  sampledWorkers: 6,
  samplesTruncated: false,
};

it('builds capacity segments and omits zero/unknown ones', () => {
  expect(capacitySegments(workers)).toEqual({
    segments: [
      { label: 'Busy', value: 3, tone: 'info' },
      { label: 'Reserved', value: 1, tone: 'warn' },
      { label: 'Ready idle', value: 2, tone: 'ok' },
    ],
    max: 10,
  });
});

it('falls back to total when the ceiling is unknown', () => {
  expect(capacitySegments({ ...workers, capacityCeiling: null }).max).toBe(6);
});

it('keeps only the last 20 history samples', () => {
  const snapshot = (eventsLastFiveMinutes: number): InfrastructureSnapshot =>
    ({
      workers,
      queue: { depth: 1, eligibleDepth: 1, oldestAgeMs: 0, reconciliationDepth: 0 },
      telemetry: { eventsLastFiveMinutes, activeCalls: 0, newestEventAt: null },
    }) as InfrastructureSnapshot;
  let history: ReturnType<typeof pushHistory> = [];
  for (let i = 0; i < 25; i += 1) history = pushHistory(history, snapshot(i));
  expect(history).toHaveLength(20);
  expect(history[0].eventsPerFiveMin).toBe(5);
  expect(history.at(-1)?.eventsPerFiveMin).toBe(24);
});

it('flags a stale signal once its age exceeds the max', () => {
  expect(isStale(31_000, 30_000)).toBe(true);
  expect(isStale(10_000, 30_000)).toBe(false);
  expect(isStale(null, 30_000)).toBe(false);
});

it('computes a quota ratio, or null when unknown', () => {
  expect(quotaRatio(10, 100)).toBe(0.1);
  expect(quotaRatio(null, 100)).toBeNull();
  expect(quotaRatio(10, 0)).toBeNull();
});
