import type {
  CallRouteResponse,
  RouteEvent,
  RouteSegmentRow,
  SegmentCost,
} from '../lib/types/call-route';

// ---- Wave 18: routed-call fixtures (`GET /v1/calls/:id/segments`) -----------------------------

export const CALL_START = '2026-10-20T10:00:00.000Z';
const startMs = Date.parse(CALL_START);
/** An ISO time `seconds` after the call started. */
export const at = (seconds: number) => new Date(startMs + seconds * 1000).toISOString();

export function routeSegment(overrides: Partial<RouteSegmentRow> = {}): RouteSegmentRow {
  return {
    index: 0,
    role: 'agent',
    agentId: 'agent-sales',
    releaseId: 'rel-sales-0001',
    reason: 'route',
    poolId: null,
    memberId: null,
    language: 'hi',
    transfer: null,
    startedAt: at(0),
    durationMs: 10_000,
    ended: 'handoff',
    cost: null,
    ...overrides,
  };
}

let sequence = 0;
export function routeEvent(
  type: string,
  payload: Record<string, unknown>,
  seconds: number,
  extra: Partial<RouteEvent> = {},
): RouteEvent {
  sequence += 1;
  return { sequence, at: at(seconds), type, payload, ...extra };
}

const cost = (paise: number): SegmentCost => ({
  currency: 'INR',
  estimatedPaise: String(paise),
  reconciledPaise: '0',
  totalPaise: String(paise),
});

/**
 * The canonical routed call: a router that reasks once, a sales agent, a transfer refused and then
 * accepted to billing, and a hand-off to a person. 180 s long; hold gaps 4.2 s and 21 s.
 */
export function routedCall(): CallRouteResponse {
  sequence = 0;
  return {
    callId: 'call-routed-1',
    available: true,
    route: {
      routingPointId: 'point-1',
      routingReleaseId: 'rel-1',
      path: ['language', 'intent'],
      target: 'agent',
      agentId: 'agent-sales',
      releaseId: 'rel-sales-0001',
      poolId: 'pool-sales',
      memberId: 'sales-hi',
      language: 'hi',
      degraded: null,
      segments: 4,
      turns: 3,
      routeMs: 7400,
      fallbacks: 1,
      reasks: 1,
    },
    segments: [
      routeSegment({
        index: 0,
        role: 'router',
        agentId: 'agent-router',
        releaseId: 'rel-router-1',
        reason: 'start',
        durationMs: 8_000,
        cost: cost(120),
      }),
      routeSegment({
        index: 1,
        poolId: 'pool-sales',
        memberId: 'sales-hi',
        startedAt: at(8),
        durationMs: 62_000,
        cost: cost(840),
      }),
      routeSegment({
        index: 2,
        agentId: 'agent-billing',
        releaseId: 'rel-billing-0001',
        reason: 'transfer',
        transfer: 2,
        language: 'en',
        startedAt: at(74.2),
        durationMs: 40_000,
        cost: cost(510),
      }),
      routeSegment({
        index: 3,
        role: 'human',
        agentId: 'queue:desk',
        releaseId: 'q-desk',
        reason: 'transfer',
        transfer: 3,
        startedAt: at(135.2),
        durationMs: 44_800,
        ended: 'call_end',
      }),
    ],
    human: {
      queue: 'desk',
      queueId: 'q-desk',
      kind: 'managed',
      ticket: 'ticket-9',
      waitMs: 19_000,
      talkMs: 44_800,
      operator: 'u-asha',
      outcome: 'connected',
    },
    transfers: [
      {
        requested: {
          transfer: 1,
          fromSegment: 1,
          source: 'llm',
          kind: 'agent',
          key: 'vip',
          result: 'refused',
          refusal: 'no_eligible_member',
        },
        completed: null,
      },
      {
        requested: {
          transfer: 2,
          fromSegment: 1,
          source: 'llm',
          kind: 'agent',
          key: 'billing',
          confirm: 'asked',
          result: 'accepted',
        },
        completed: {
          transfer: 2,
          outcome: 'connected',
          toSegment: 2,
          holdMs: 4_200,
          prepareMs: 800,
          queueMs: 0,
          gapMs: 300,
          holdPolicy: 'target',
          steps: [],
        },
      },
      {
        requested: {
          transfer: 3,
          fromSegment: 2,
          source: 'llm',
          kind: 'human',
          key: 'desk',
          result: 'accepted',
          queued: true,
        },
        completed: {
          transfer: 3,
          outcome: 'connected',
          toSegment: 3,
          holdMs: 21_000,
          queueMs: 19_000,
          holdPolicy: 'queue',
          steps: [{ step: 'target', result: 'taken' }],
        },
      },
    ],
    callLevelCost: cost(60),
    events: [
      routeEvent(
        'route.node',
        {
          turn: 1,
          node: 'language',
          engine: 'rules',
          outcome: 'matched',
          branch: 'hi',
          confidence: 1,
          ms: 2,
        },
        3,
      ),
      routeEvent(
        'route.node',
        {
          turn: 2,
          node: 'intent',
          engine: 'llm',
          outcome: 'low_confidence',
          confidence: 0.42,
          ms: 380,
        },
        5,
      ),
      routeEvent(
        'route.fallback',
        { turn: 2, node: 'intent', step: 'reask', result: 'taken', attempt: 1 },
        5.1,
      ),
      routeEvent(
        'route.node',
        {
          turn: 3,
          node: 'intent',
          engine: 'llm',
          outcome: 'matched',
          branch: 'sales',
          confidence: 0.91,
          ms: 410,
        },
        7,
      ),
      routeEvent('disclosure', { kinds: ['ai', 'recording'], segment: 0 }, 1),
      routeEvent(
        'segment.ended',
        { index: 0, turns: 3, durationMs: 8_000, usage: { 'stt.seconds': 8 } },
        8,
      ),
      routeEvent(
        'segment.ended',
        { index: 1, turns: 9, durationMs: 62_000, endReason: 'handoff:billing' },
        70,
      ),
      routeEvent(
        'human.state',
        { ticket: 'ticket-9', state: 'connected', by: 'operator', callback: 'accepted' },
        150,
      ),
    ],
    eventsTruncated: false,
  };
}
