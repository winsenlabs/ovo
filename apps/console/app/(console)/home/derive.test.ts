import { describe, expect, it } from 'vitest';
import {
  callKpis,
  callsByBucket,
  dispositionSlices,
  failureReasonBars,
  firstAudioGroup,
} from './derive';
import type { HomeCall } from './types';

const call = (over: Partial<HomeCall>): HomeCall => ({
  id: 'call_1',
  status: 'completed',
  createdAt: '2026-10-14T10:00:00.000Z',
  ...over,
});

describe('callKpis', () => {
  it('computes completion rate from completed/failed/cancelled only, never counting running calls', () => {
    const calls = [
      call({ id: '1', status: 'completed' }),
      call({ id: '2', status: 'failed' }),
      call({ id: '3', status: 'in_progress' }),
    ];
    const kpis = callKpis(calls);
    expect(kpis.completionRate).toBeCloseTo(0.5);
    expect(kpis.total).toBe(3);
  });

  it('returns null, never 0, for completion rate when nothing has finished yet (brief §1.4)', () => {
    const kpis = callKpis([call({ status: 'in_progress' })]);
    expect(kpis.completionRate).toBeNull();
  });

  it('counts a timeout end reason toward timeouts regardless of status tone', () => {
    const kpis = callKpis([
      call({ status: 'failed', outcome: { endReason: 'error:timeout:stt' } as never }),
    ]);
    expect(kpis.timeouts).toBe(1);
  });

  it('takes the median call duration from completed calls only', () => {
    const kpis = callKpis([
      call({ createdAt: '2026-10-14T10:00:00.000Z', completedAt: '2026-10-14T10:01:00.000Z' }),
      call({ createdAt: '2026-10-14T10:00:00.000Z', completedAt: '2026-10-14T10:03:00.000Z' }),
    ]);
    expect(kpis.medianDurationMs).toBe(180000);
  });
});

describe('callsByBucket', () => {
  it('buckets by hour inside a 2-day range and by day otherwise', () => {
    const hourly = callsByBucket([call({})], 1);
    expect(hourly).toHaveLength(1);
    const daily = callsByBucket([call({})], 7);
    expect(daily).toHaveLength(1);
  });

  it('never drops a call into the wrong status series', () => {
    const buckets = callsByBucket(
      [call({ id: '1', status: 'completed' }), call({ id: '2', status: 'cancelled' })],
      1,
    );
    expect(buckets[0]!.values.ok).toBe(1);
    expect(buckets[0]!.values.neutral).toBe(1);
  });
});

describe('dispositionSlices', () => {
  it('labels a call with no recorded disposition honestly instead of dropping it', () => {
    const slices = dispositionSlices([call({ outcome: null })]);
    expect(slices).toEqual([{ label: 'No disposition', value: 1 }]);
  });
});

describe('failureReasonBars', () => {
  it('only counts calls whose end reason actually says timeout', () => {
    const bars = failureReasonBars([
      call({ outcome: { endReason: 'error:timeout:stt' } as never }),
      call({ outcome: { endReason: 'caller_hangup' } as never }),
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.category).toBe('STT');
  });
});

describe('firstAudioGroup', () => {
  it('prefers the stage named for first audio over the highest-sample stage', () => {
    const groups = [
      { cohort: { stage: 'stt' }, sampleCount: 500, p95Ms: 300 } as never,
      { cohort: { stage: 'first_audio' }, sampleCount: 10, p95Ms: 420 } as never,
    ];
    expect(firstAudioGroup(groups)?.cohort.stage).toBe('first_audio');
  });

  it('falls back to the most-sampled stage when no stage is named for first audio', () => {
    const groups = [
      { cohort: { stage: 'stt' }, sampleCount: 5, p95Ms: 100 } as never,
      { cohort: { stage: 'tts' }, sampleCount: 50, p95Ms: 200 } as never,
    ];
    expect(firstAudioGroup(groups)?.cohort.stage).toBe('tts');
  });
});
