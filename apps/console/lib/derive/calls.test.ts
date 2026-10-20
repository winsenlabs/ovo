import { describe, expect, it } from 'vitest';
import {
  callRouteSummary,
  callDurationMs,
  callsKpis,
  callsOverTime,
  endReasonLabel,
  endReasonTop,
  routingFilterUnavailable,
  type CallRow,
} from './calls';

function row(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: 'call_1',
    status: 'completed',
    createdAt: '2026-10-15T10:00:00.000Z',
    completedAt: '2026-10-15T10:03:00.000Z',
    outcome: null,
    ...overrides,
  };
}

describe('callDurationMs', () => {
  it('is the gap between created and completed', () => {
    expect(callDurationMs(row())).toBe(180_000);
  });
  it('is null, never 0, while the call has not ended', () => {
    expect(callDurationMs(row({ completedAt: null }))).toBeNull();
  });
});

describe('callsKpis', () => {
  it('summarises the loaded window without counting in-progress calls as finished', () => {
    const rows: CallRow[] = [
      row({ id: 'c1', status: 'completed' }),
      row({ id: 'c2', status: 'completed' }),
      row({
        id: 'c3',
        status: 'failed',
        outcome: {
          callId: 'c3',
          outcome: 'failed',
          endReason: 'error:timeout:stt:sarvam',
          disposition: null,
          dispositionSource: null,
          finalNode: null,
          statePath: [],
          variables: {},
          tiers: {},
          guardrail: { flagged: 0, blocked: 0 },
          events: 0,
          route: null,
          segments: [],
          transfers: { requested: 0, refused: 0, connected: 0, failed: 0 },
          human: null,
          updatedAt: row().createdAt!,
        },
      }),
      row({ id: 'c4', status: 'in_progress', completedAt: null }),
    ];
    const kpis = callsKpis(rows);
    expect(kpis.total).toBe(4);
    expect(kpis.completed).toBe(2);
    expect(kpis.completionRate).toBeCloseTo(2 / 3);
    expect(kpis.failed).toBe(1);
    expect(kpis.failedTimeoutShare).toBe(1);
    expect(kpis.liveNow).toBe(1);
    expect(kpis.medianDurationMs).toBe(180_000);
  });

  it('never divides by zero into a false rate', () => {
    expect(callsKpis([]).completionRate).toBeNull();
    expect(
      callsKpis([row({ status: 'in_progress', completedAt: null })]).completionRate,
    ).toBeNull();
  });
});

describe('callsOverTime', () => {
  it('buckets hourly inside a 48h span and daily beyond it', () => {
    const hourly = callsOverTime([
      row({ createdAt: '2026-10-15T10:15:00.000Z' }),
      row({ createdAt: '2026-10-15T10:45:00.000Z' }),
      row({ createdAt: '2026-10-15T12:00:00.000Z', status: 'failed' }),
    ]);
    expect(hourly.granularity).toBe('hour');
    expect(hourly.points).toHaveLength(2);
    expect(hourly.points[0]!.values.completed).toBe(2);

    const daily = callsOverTime([
      row({ createdAt: '2026-10-01T10:00:00.000Z' }),
      row({ createdAt: '2026-10-10T10:00:00.000Z' }),
    ]);
    expect(daily.granularity).toBe('day');
    expect(daily.points).toHaveLength(2);
  });

  it('widens the bucket instead of emitting one crammed column per hour across a long window', () => {
    // `BarChart` labels every category it is given (no sparse-tick thinning); 40 hourly buckets
    // rendered as 40 overlapping x-axis labels before this widened the bucket.
    const start = Date.parse('2026-10-15T00:00:00.000Z');
    const rows = Array.from({ length: 40 }, (_, hour) =>
      row({ id: `c${hour}`, createdAt: new Date(start + hour * 3_600_000).toISOString() }),
    );
    const { points } = callsOverTime(rows);
    expect(points.length).toBeLessThanOrEqual(14);
  });
});

describe('endReasonLabel / endReasonTop', () => {
  it('names the stage for a timeout instead of the raw error string', () => {
    expect(endReasonLabel('error:timeout:stt:sarvam')).toBe('Timed out · STT (sarvam)');
    expect(endReasonLabel('caller_hangup')).toBe('Caller hung up');
    expect(endReasonLabel(null)).toBe('Unknown');
  });

  it('ranks the top end reasons by volume', () => {
    const rows = [
      row({ outcome: { ...row().outcome, endReason: 'caller_hangup' } as never }),
      row({ outcome: { ...row().outcome, endReason: 'caller_hangup' } as never }),
      row({ outcome: { ...row().outcome, endReason: 'max_duration' } as never }),
      row({ outcome: null }),
    ];
    expect(endReasonTop(rows)).toEqual([
      { label: 'Caller hung up', count: 2 },
      { label: 'Max duration', count: 1 },
    ]);
  });
});

describe('routing facts on a call row (Wave 18)', () => {
  const route = {
    routingPointId: 'point-1',
    routingReleaseId: 'rel-1',
    path: ['intent'],
    target: 'agent' as const,
    agentId: 'agent-sales',
    releaseId: 'rel-sales',
    poolId: null,
    memberId: null,
    language: 'hi',
    degraded: null,
    segments: 2,
  };
  const base = {
    callId: 'c',
    transfers: { requested: 0, refused: 0, connected: 0, failed: 0 },
    human: null,
    segments: [],
  };
  const summary = (patch: object) => callRouteSummary({ ...base, route, ...patch } as never);

  it('is null for a direct call, a call with no outcome and a pre-routing outcome', () => {
    expect(callRouteSummary(null)).toBeNull();
    expect(callRouteSummary(undefined)).toBeNull();
    expect(callRouteSummary({ ...base, route: null } as never)).toBeNull();
    expect(callRouteSummary({ tiers: {} } as never)).toBeNull();
  });

  it.each([
    [
      'a plain routed call',
      {},
      { segments: 2, transferred: false, person: false, usedFallback: false },
    ],
    [
      'a connected transfer',
      { transfers: { requested: 1, refused: 0, connected: 1, failed: 0 } },
      { transferred: true },
    ],
    [
      'a refused transfer only',
      { transfers: { requested: 1, refused: 1, connected: 0, failed: 0 } },
      { transferred: false },
    ],
    ['a person', { human: { queueKey: 'desk' } }, { person: true }],
    [
      'a degraded route',
      { route: { ...route, degraded: 'router_compose_failed' } },
      { usedFallback: true },
    ],
    ['a recorded fallback', { route: { ...route, fallbacks: 2 } }, { usedFallback: true }],
    ['more segments than the route counted', { segments: [{}, {}, {}] }, { segments: 3 }],
  ])('summarises %s', (_name, patch, expected) => {
    expect(summary(patch)).toMatchObject({ pointId: 'point-1', target: 'agent', ...expected });
  });

  it('reads filterUnavailable off the page the cursor hook spread', () => {
    expect(routingFilterUnavailable({ items: [], filterUnavailable: true })).toBe(true);
    expect(routingFilterUnavailable({ items: [], filterUnavailable: false })).toBe(false);
    expect(routingFilterUnavailable({ items: [] })).toBe(false);
  });
});
