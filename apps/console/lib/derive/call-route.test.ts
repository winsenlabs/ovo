import { describe, expect, it } from 'vitest';
import { at, CALL_START, routedCall, routeEvent, routeSegment } from '../../tests/route-fixtures';
import type { CallRouteResponse } from '../types/call-route';
import {
  buildHuman,
  buildKpis,
  buildTransferRows,
  costRollup,
  eventsForSegment,
  hasRouteData,
} from './call-route-summary';
import { buildTimeline, paise, segmentName } from './call-route';

const WINDOW = { createdAt: CALL_START, durationMs: 180_000 };
const names = new Map([['agent-sales', 'Sales agent']]);

function withSegments(
  segments: CallRouteResponse['segments'],
  rest: Partial<CallRouteResponse> = {},
): CallRouteResponse {
  return {
    ...routedCall(),
    route: null,
    transfers: [],
    events: [],
    human: null,
    ...rest,
    segments,
  };
}

describe('segment offsets', () => {
  const timeline = buildTimeline(routedCall(), WINDOW, names);

  it.each([
    [0, 0, 8_000, 'Router'],
    [1, 8_000, 70_000, 'Sales agent'],
    [2, 74_200, 114_200, 'agent-billing'],
    [3, 135_200, 180_000, 'Person · desk'],
  ])('segment %i runs %i to %i ms as %s', (index, start, end, label) => {
    const segment = timeline.segments.find((item) => item.index === index)!;
    expect([segment.startMs, segment.endMs, segment.label]).toEqual([start, end, label]);
    expect(segment.open).toBe(false);
  });

  it('spans the call and lists only the lanes in use, in role order', () => {
    expect(timeline.totalMs).toBe(180_000);
    expect(timeline.lanes).toEqual(['router', 'agent', 'human']);
    expect(buildTimeline(withSegments([routeSegment()]), WINDOW).lanes).toEqual(['agent']);
  });

  it('takes the end from segment.ended when the segment row has no duration', () => {
    const response = withSegments([routeSegment({ durationMs: null, ended: null })], {
      events: [routeEvent('segment.ended', { index: 0, durationMs: 12_345, turns: 4 }, 12)],
    });
    const [segment] = buildTimeline(response, WINDOW).segments;
    expect([segment!.durationMs, segment!.endMs, segment!.turns, segment!.open]).toEqual([
      12_345,
      12_345,
      4,
      false,
    ]);
  });

  it.each([
    [
      'the next segment start',
      [routeSegment({ durationMs: null }), routeSegment({ index: 1, startedAt: at(20) })],
      20_000,
    ],
    ['the call end for the last segment', [routeSegment({ durationMs: null })], 180_000],
  ])('closes a segment with no recorded end at %s', (_name, segments, end) => {
    const [first] = buildTimeline(withSegments(segments), WINDOW).segments;
    expect(first!.open).toBe(true);
    expect(first!.endMs).toBe(end);
  });

  it('leaves an open segment empty when nothing says where it ends', () => {
    const [segment] = buildTimeline(
      withSegments([routeSegment({ durationMs: null, startedAt: at(5) })]),
      {
        createdAt: CALL_START,
      },
    ).segments;
    expect([segment!.startMs, segment!.endMs]).toEqual([5_000, 5_000]);
  });

  it('measures from the first segment when the call has no clock', () => {
    const response = withSegments([routeSegment({ startedAt: at(30), durationMs: 5_000 })]);
    const timeline = buildTimeline(response, {});
    expect(timeline.segments[0]!.startMs).toBe(0);
    expect(timeline.totalMs).toBe(5_000);
  });

  it('is empty and safe with no segments', () => {
    const timeline = buildTimeline(withSegments([]), {});
    expect(timeline.segments).toEqual([]);
    expect(timeline.totalMs).toBe(1);
  });

  it('puts segments in index order whatever order the API sent them', () => {
    const response = withSegments([
      routeSegment({ index: 2, startedAt: at(9) }),
      routeSegment({ index: 1, startedAt: at(4) }),
    ]);
    expect(buildTimeline(response, WINDOW).segments.map((s) => s.index)).toEqual([1, 2]);
  });
});

describe('transfer hold gaps', () => {
  it('runs each hold from the sending segment end to the receiving segment start', () => {
    const { gaps } = buildTimeline(routedCall(), WINDOW);
    expect(
      gaps.map((g) => [g.transfer, g.fromSegment, g.toSegment, g.startMs, g.endMs, g.holdMs]),
    ).toEqual([
      [2, 1, 2, 70_000, 74_200, 4_200],
      [3, 2, 3, 114_200, 135_200, 21_000],
    ]);
  });

  it('measures the hold back from the receiving segment when the sender never reported its end', () => {
    const response = routedCall();
    response.segments[1] = { ...response.segments[1]!, durationMs: null };
    response.events = [];
    // The sender's end would only be inferred (it is the next segment's start), so it cannot
    // bound the gap: the recorded hold does.
    const gap = buildTimeline(response, WINDOW).gaps.find((g) => g.transfer === 2)!;
    expect([gap.startMs, gap.endMs, gap.holdMs]).toEqual([70_000, 74_200, 4_200]);
  });

  it('places a hold with no receiving segment (callback, caller hung up) after the sender', () => {
    const response = routedCall();
    response.transfers = [
      {
        requested: { transfer: 1, fromSegment: 1, result: 'accepted', kind: 'queue', key: 'x' },
        completed: { transfer: 1, outcome: 'callback', holdMs: 6_000, steps: [] },
      },
    ];
    const [gap] = buildTimeline(response, WINDOW).gaps;
    expect([gap!.toSegment, gap!.startMs, gap!.endMs, gap!.outcome]).toEqual([
      null,
      70_000,
      76_000,
      'callback',
    ]);
  });

  it('finds the receiving segment by its transfer number when toSegment is absent', () => {
    const response = routedCall();
    delete response.transfers[1]!.completed!.toSegment;
    expect(buildTimeline(response, WINDOW).gaps[0]!.toSegment).toBe(2);
  });

  it('never runs a gap past the end of the call', () => {
    const response = routedCall();
    response.transfers = [
      {
        requested: { transfer: 1, fromSegment: 3, result: 'accepted' },
        completed: { transfer: 1, outcome: 'ended', holdMs: 60_000, steps: [] },
      },
    ];
    expect(buildTimeline(response, WINDOW).gaps[0]!.endMs).toBe(180_000);
  });

  it('ignores a completion with no hold time', () => {
    const response = routedCall();
    response.transfers = [{ requested: null, completed: { transfer: 1, outcome: 'failed' } }];
    expect(buildTimeline(response, WINDOW).gaps).toEqual([]);
  });
});

describe('disclosure pins', () => {
  it('pins each disclosure at its offset with the segment it played in', () => {
    const response = routedCall();
    response.events.push(
      routeEvent('disclosure', { kinds: ['identity'] }, 76, { segment: 2 }),
      routeEvent('disclosure', { kinds: [] }, 90),
    );
    const { pins } = buildTimeline(response, WINDOW);
    expect(pins).toEqual([
      { atMs: 1_000, segment: 0, kinds: ['ai', 'recording'] },
      { atMs: 76_000, segment: 2, kinds: ['identity'] },
    ]);
  });

  it('extends the axis to a pin recorded after the last segment', () => {
    const response = withSegments([routeSegment({ durationMs: 1_000 })], {
      events: [routeEvent('disclosure', { kinds: ['ai'] }, 40)],
    });
    expect(buildTimeline(response, {}).totalMs).toBeGreaterThan(1_000);
  });
});

describe('cost roll-up', () => {
  it('adds every segment and the call-level usage', () => {
    expect(costRollup(routedCall())).toEqual({
      currency: 'INR',
      totalPaise: 120 + 840 + 510 + 60,
      segmentsPaise: 1_470,
      callLevelPaise: 60,
    });
  });

  it('keeps each segment cost on the timeline, null when unpriced', () => {
    const costs = buildTimeline(routedCall(), WINDOW).segments.map((s) => s.costPaise);
    expect(costs).toEqual([120, 840, 510, null]);
  });

  it.each([
    ['nothing priced', { callLevelCost: null, segments: [routeSegment()] }, null],
    [
      'only call-level usage',
      { callLevelCost: routedCall().callLevelCost, segments: [routeSegment()] },
      60,
    ],
  ])('is %s', (_name, patch, total) => {
    expect(costRollup({ ...routedCall(), ...patch }).totalPaise).toBe(total);
  });

  it.each([
    ['150', 150],
    ['0', 0],
    ['', null],
    ['x', null],
    [null, null],
    [undefined, null],
  ])('reads paise %j as %j', (value, expected) => {
    expect(paise(value as string | null | undefined)).toBe(expected);
  });
});

describe('transfer rows and kpis', () => {
  it('lists requested against completed in call order', () => {
    const rows = buildTransferRows(routedCall());
    expect(
      rows.map((r) => [r.transfer, r.kind, r.key, r.result, r.refusal, r.outcome, r.holdMs]),
    ).toEqual([
      [1, 'agent', 'vip', 'refused', 'no_eligible_member', null, null],
      [2, 'agent', 'billing', 'accepted', null, 'connected', 4_200],
      [3, 'human', 'desk', 'accepted', null, 'connected', 21_000],
    ]);
    expect(rows[2]).toMatchObject({ queued: true, queueMs: 19_000, holdPolicy: 'queue' });
    expect(rows[2]!.steps).toEqual([{ step: 'target', result: 'taken', reason: null }]);
  });

  it('keeps a completion with no request and marks its result unknown', () => {
    const response = routedCall();
    response.transfers = [
      { requested: null, completed: { transfer: 4, outcome: 'fallback', holdMs: 1_000 } },
    ];
    expect(buildTransferRows(response)).toMatchObject([
      { transfer: 4, result: 'unknown', outcome: 'fallback' },
    ]);
  });

  it('rolls the call up for the strip', () => {
    expect(buildKpis(routedCall())).toEqual({
      target: 'agent',
      degraded: null,
      segments: 4,
      transfersRequested: 3,
      transfersRefused: 1,
      transfersConnected: 2,
      holdTotalMs: 25_200,
      waitMs: 19_000,
      talkMs: 44_800,
    });
  });

  it('has no hold total or person times when there were none', () => {
    const kpis = buildKpis(withSegments([routeSegment()]));
    expect([kpis.holdTotalMs, kpis.waitMs, kpis.talkMs, kpis.transfersRequested]).toEqual([
      null,
      null,
      null,
      0,
    ]);
  });
});

describe('the person segment', () => {
  it('reads callbacks from human.state events while the API summary omits them', () => {
    expect(buildHuman(routedCall())).toMatchObject({
      queue: 'desk',
      operator: 'u-asha',
      callbacks: { accepted: true, released: false, outcome: null },
      refusals: [],
    });
  });

  it('prefers callbacks the API sends, and lists refused requests', () => {
    const response = routedCall();
    response.human = {
      ...response.human!,
      callbacks: { accepted: true, released: true, outcome: 'resolved' },
    };
    response.events.push(
      routeEvent(
        'human.requested',
        { queue: 'desk', result: 'refused', refusal: 'queue_closed' },
        100,
      ),
      routeEvent('human.requested', { queue: 'desk', result: 'accepted' }, 101),
    );
    expect(buildHuman(response)).toMatchObject({
      callbacks: { accepted: true, released: true, outcome: 'resolved' },
      refusals: ['queue_closed'],
    });
  });

  it('reads an outcome callback and falls back to the segment copy', () => {
    const response = routedCall();
    const human = response.human!;
    response.segments[3] = { ...response.segments[3]!, human };
    response.human = null;
    response.events = [
      routeEvent(
        'human.state',
        { ticket: 't', state: 'released', by: 'callback', callback: 'outcome', code: 'sold' },
        1,
      ),
    ];
    expect(buildHuman(response)!.callbacks.outcome).toBe('sold');
  });

  it('is null for a call that never asked for a person', () => {
    expect(buildHuman(withSegments([routeSegment()]))).toBeNull();
  });
});

describe('route data and events', () => {
  it.each([
    ['a route', { route: routedCall().route, segments: [] }, true],
    ['segments only', { route: null, segments: [routeSegment()] }, true],
    ['neither (a direct call)', { route: null, segments: [] }, false],
  ])('hasRouteData with %s', (_name, patch, expected) => {
    expect(hasRouteData({ ...routedCall(), ...patch })).toBe(expected);
  });

  it('selects the events a segment owns, moves into, or moves out of', () => {
    const response = routedCall();
    response.transfers = [];
    response.events.push(
      routeEvent('transfer.requested', { transfer: 2, fromSegment: 1 }, 70),
      routeEvent('transfer.completed', { transfer: 2, toSegment: 2 }, 74),
    );
    const types = (index: number) => eventsForSegment(response.events, index).map((e) => e.type);
    expect(types(1)).toEqual(['segment.ended', 'transfer.requested']);
    expect(types(2)).toEqual(['transfer.completed']);
    expect(types(0)).toEqual(['disclosure', 'segment.ended']);
  });

  it('names segments by role', () => {
    expect(segmentName({ role: 'router', agentId: 'r' })).toBe('Router');
    expect(segmentName({ role: 'human', agentId: 'queue:desk' })).toBe('Person · desk');
    expect(segmentName({ role: 'agent', agentId: 'a1' }, new Map([['a1', 'Alpha']]))).toBe('Alpha');
    expect(segmentName({ role: 'agent', agentId: 'a1' })).toBe('a1');
  });
});
