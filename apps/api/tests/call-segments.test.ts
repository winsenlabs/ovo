import Fastify, { type FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CallOutcomeSegment, CallOutcomeSummary } from '@winsendotai/ovo-contracts';
import type { CallRecord } from '@winsendotai/ovo-plugin-storage';
import { MemoryCallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { CallOutcomeReader, registerCallOutcomeRoute } from '../src/routes/call-outcomes.ts';
import { registerCallSegmentsRoute } from '../src/routes/call-segments.ts';

const at = '2026-10-15T10:00:00.000Z';
const ROUTER = '44444444-4444-4444-8444-444444444444';
const SALES = '66666666-6666-4666-8666-666666666666';
const BILLING = '99999999-0000-4000-8000-000000000001';

const call = (id: string): CallRecord => ({
  id,
  workspaceId: 'ws',
  releaseId: ROUTER,
  kind: 'live',
  status: 'completed',
  createdAt: at,
  completedAt: at,
});

const segment = (index: number, extra: Partial<CallOutcomeSegment>): CallOutcomeSegment => ({
  index,
  role: 'agent',
  agentId: 'sales-en',
  releaseId: SALES,
  reason: 'route',
  poolId: null,
  memberId: null,
  language: 'en',
  transfer: null,
  startedAt: at,
  durationMs: 1000,
  ended: 'handoff',
  ...extra,
});

/** The fold of a router → sales → billing call, as the outcome store keeps it (core lane). */
const SEGMENTS = [
  segment(0, { role: 'router', agentId: 'front-desk', releaseId: ROUTER, reason: 'start' }),
  segment(1, { reason: 'route', poolId: 'pool-sales', memberId: 'sales-en' }),
  segment(2, {
    agentId: 'billing',
    releaseId: BILLING,
    reason: 'transfer',
    transfer: 1,
    durationMs: 4000,
    ended: 'call_end',
  }),
];
const TRANSFERS = { requested: 2, refused: 1, connected: 1, failed: 0 };

/** Requests and completions as the worker records them: ids, keys, codes and timings only. */
const EVENTS = [
  {
    type: 'transfer.requested',
    payload: {
      transfer: 1,
      fromSegment: 1,
      source: 'llm',
      kind: 'agent',
      key: 'billing',
      result: 'refused',
      refusal: 'not_confirmed',
    },
  },
  {
    type: 'transfer.requested',
    payload: {
      transfer: 1,
      fromSegment: 1,
      source: 'llm',
      kind: 'queue',
      key: 'billing',
      result: 'accepted',
      queued: true,
    },
  },
  {
    type: 'transfer.completed',
    payload: {
      transfer: 1,
      outcome: 'connected',
      toSegment: 2,
      agentId: 'billing',
      releaseId: BILLING,
      holdMs: 4100,
      prepareMs: 900,
      steps: [],
    },
  },
  // The host's own fallback after a failed start has no request of its own.
  {
    type: 'transfer.completed',
    payload: {
      transfer: 2,
      outcome: 'fallback',
      holdMs: 0,
      steps: [{ step: 'default', result: 'taken' }],
    },
  },
];

const COSTS = [
  { index: 0, currency: 'INR', estimatedPaise: '0', reconciledPaise: '120', totalPaise: '120' },
  { index: 2, currency: 'INR', estimatedPaise: '0', reconciledPaise: '400', totalPaise: '400' },
  { index: null, currency: 'INR', estimatedPaise: '0', reconciledPaise: '90', totalPaise: '90' },
];

/** A memory outcome store holding the events, whose summary is the routed fold above. */
async function outcomeStore(summary: Partial<CallOutcomeSummary> = {}) {
  const store = new MemoryCallOutcomeStore();
  await store.append(
    'ws',
    'call-1',
    EVENTS.map((event, index) => ({ id: `e${index}`, at, ...event })),
  );
  const fold = store.get.bind(store);
  store.get = async (workspaceId, callId) => {
    const found = await fold(workspaceId, callId);
    return found && { ...found, segments: SEGMENTS, transfers: TRANSFERS, ...summary };
  };
  return store;
}

function build(
  reader: CallOutcomeReader,
  ledger?: { getCallCost: (...args: never[]) => Promise<unknown> },
) {
  const app = Fastify({ logger: false });
  const common = {
    app,
    outcomes: reader,
    store: {
      getCall: async (_workspace: string, id: string) =>
        ['call-1', 'call-2'].includes(id) ? call(id) : undefined,
    },
    requireRole: () => ({ workspaceId: 'ws' }),
    Id: z.string().min(1).max(200),
    error: (reply: FastifyReply, status: number, code: string, message: string) =>
      reply.code(status).send({ error: { code, message } }),
  };
  registerCallSegmentsRoute({ ...common, ledger: ledger as never });
  registerCallOutcomeRoute(common);
  return app;
}

describe('GET /v1/calls/:callId/segments (Wave 16 inspector data)', () => {
  it('returns the route, each segment with its cost, transfers and the call-level cost', async () => {
    const store = await outcomeStore();
    const getCallCost = vi.fn(async () => ({ segments: COSTS }));
    const app = build(new CallOutcomeReader(async () => store), { getCallCost });
    const response = await app.inject({ method: 'GET', url: '/v1/calls/call-1/segments' });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(getCallCost).toHaveBeenCalledWith('ws', 'call-1');
    expect(body).toMatchObject({ callId: 'call-1', available: true, route: null });
    expect(body.segments.map((s: { index: number; cost: unknown }) => [s.index, s.cost])).toEqual([
      [0, { currency: 'INR', estimatedPaise: '0', reconciledPaise: '120', totalPaise: '120' }],
      [1, null],
      [2, { currency: 'INR', estimatedPaise: '0', reconciledPaise: '400', totalPaise: '400' }],
    ]);
    expect(body.segments[2]).toMatchObject({ reason: 'transfer', transfer: 1, durationMs: 4000 });
    expect(body.callLevelCost).toEqual({
      currency: 'INR',
      estimatedPaise: '0',
      reconciledPaise: '90',
      totalPaise: '90',
    });
    expect(body.transfers).toEqual([
      { requested: EVENTS[0]!.payload, completed: null },
      { requested: EVENTS[1]!.payload, completed: EVENTS[2]!.payload },
      { requested: null, completed: EVENTS[3]!.payload },
    ]);
    await app.close();
  });

  it('still answers when the ledger is off or cannot price the call', async () => {
    const store = await outcomeStore();
    for (const ledger of [
      undefined,
      { getCallCost: async () => Promise.reject(new Error('ledger down')) },
    ]) {
      const app = build(new CallOutcomeReader(async () => store), ledger);
      const body = (await app.inject({ method: 'GET', url: '/v1/calls/call-1/segments' })).json();
      expect(body.segments.map((s: { cost: unknown }) => s.cost)).toEqual([null, null, null]);
      expect(body.callLevelCost).toBeNull();
      await app.close();
    }
  });

  it('has no segments for a direct call, nothing without outcomes, and 404s an unknown call', async () => {
    const direct = await outcomeStore({ segments: [] });
    const app = build(new CallOutcomeReader(async () => direct));
    expect(
      (await app.inject({ method: 'GET', url: '/v1/calls/call-1/segments' })).json().segments,
    ).toEqual([]);
    // A call the worker never wrote an event for.
    expect((await app.inject({ method: 'GET', url: '/v1/calls/call-2/segments' })).json()).toEqual({
      callId: 'call-2',
      available: true,
      route: null,
      segments: [],
      transfers: [],
      human: null,
      callLevelCost: null,
      events: [],
      eventsTruncated: false,
    });
    expect((await app.inject({ method: 'GET', url: '/v1/calls/call-3/segments' })).statusCode).toBe(
      404,
    );
    await app.close();
    const dark = build(new CallOutcomeReader());
    expect(
      (await dark.inject({ method: 'GET', url: '/v1/calls/call-1/segments' })).json(),
    ).toMatchObject({
      available: false,
      segments: [],
    });
    await dark.close();
  });

  it('exposes segments and transfer counts on the outcome summary', async () => {
    const store = await outcomeStore();
    const app = build(new CallOutcomeReader(async () => store));
    const outcome = (await app.inject({ method: 'GET', url: '/v1/calls/call-1/outcome' })).json();
    expect(outcome.summary).toMatchObject({ segments: SEGMENTS, transfers: TRANSFERS });
    await app.close();
  });
});

describe('GET /v1/calls/:callId/segments: timeline events (Wave 18, R4)', () => {
  const step = (type: string, payload: Record<string, unknown>, id: string) => ({
    id,
    at,
    type,
    payload,
  });
  const timeline = [
    step('route.node', { turn: 1, node: 'intent', engine: 'rules', outcome: 'no_match' }, 'a'),
    step('turn.route', { turn: 1, tier: 'llm', intent: 'sales', confidence: 0.9 }, 'b'),
    step('flow.state', { turn: 1, from: 'x', to: 'y' }, 'c'),
    step('disposition', { disposition: 'promise_to_pay', source: 'jev' }, 'd'),
    step(
      'route.fallback',
      { turn: 1, node: 'intent', step: 'default', result: 'taken', attempt: 1 },
      'e',
    ),
    step('disposition', { disposition: 'callback', source: 'system' }, 'f'),
    step('disclosure', { kinds: ['ai'], segment: 1 }, 'g'),
    step(
      'segment.ended',
      {
        index: 1,
        role: 'agent',
        agentId: 'sales',
        releaseId: SALES,
        ended: 'handoff',
        endReason: 'x',
        durationMs: 5,
        turns: 1,
      },
      'h',
    ),
    step('call.outcome', { outcome: 'completed', reason: 'caller_hangup' }, 'i'),
  ];

  async function run(events: ReturnType<typeof step>[]) {
    const store = new MemoryCallOutcomeStore();
    for (let at = 0; at < events.length; at += 100)
      await store.append('ws', 'call-1', events.slice(at, at + 100));
    const app = build(new CallOutcomeReader(async () => store));
    const body = (await app.inject({ method: 'GET', url: '/v1/calls/call-1/segments' })).json();
    await app.close();
    return body;
  }

  it('returns the route, segment, transfer, human and disclosure events in order, and nothing else', async () => {
    const body = await run(timeline);
    expect(body.events.map((event: { type: string }) => event.type)).toEqual([
      'route.node',
      'route.fallback',
      'disposition',
      'disclosure',
      'segment.ended',
    ]);
    // Only the router's own disposition (source system) is kept, not a flow agent's.
    expect(body.events[2]).toMatchObject({
      payload: { disposition: 'callback', source: 'system' },
    });
    expect(body.events[3]).toMatchObject({ sequence: 7, at, segment: 1 });
    expect(body.events[0]).not.toHaveProperty('segment');
    expect(body.eventsTruncated).toBe(false);
  });

  it('stops at 400 events and says so', async () => {
    const many = Array.from({ length: 450 }, (_, index) =>
      step(
        'route.node',
        { turn: 1, node: 'intent', engine: 'rules', outcome: 'no_match' },
        `n${index}`,
      ),
    );
    const body = await run(many);
    expect(body.events).toHaveLength(400);
    expect(body.events.at(-1).sequence).toBe(400);
    expect(body.eventsTruncated).toBe(true);
    // The summary and the transfers still cover the whole call.
    expect(body.available).toBe(true);
  });

  it('leaves out an event that no longer parses, not the call', async () => {
    const store = new MemoryCallOutcomeStore();
    await store.append('ws', 'call-1', timeline.slice(0, 1));
    const listed = store.listEvents.bind(store);
    store.listEvents = async (...args) => {
      const page = await listed(...args);
      return {
        ...page,
        items: [
          ...page.items,
          { callId: 'call-1', sequence: 2, at, type: 'route.node', payload: { node: 17 } },
        ] as never,
      };
    };
    const app = build(new CallOutcomeReader(async () => store));
    const body = (await app.inject({ method: 'GET', url: '/v1/calls/call-1/segments' })).json();
    expect(body.events.map((event: { sequence: number }) => event.sequence)).toEqual([1]);
    await app.close();
  });

  it('has no events for a direct call or an unknown one', async () => {
    const body = await run([step('call.outcome', { outcome: 'completed', reason: 'x' }, 'z')]);
    expect(body).toMatchObject({ events: [], eventsTruncated: false });
  });
});
