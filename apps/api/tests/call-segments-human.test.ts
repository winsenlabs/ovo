import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import { MemoryCallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { registerCallSegmentsRoute } from '../src/routes/call-segments.ts';
import { CallOutcomeReader } from '../src/routes/call-outcomes.ts';

const CALL = 'call-1';
const WORKSPACE = 'ws';

/** The segments route over an in-memory outcome store and a ledger that prices each segment. */
async function setup(events: { type: string; payload: Record<string, unknown> }[]) {
  const store = new MemoryCallOutcomeStore();
  await store.append(
    WORKSPACE,
    CALL,
    events.map((event, index) => ({
      id: `e${index}`,
      at: `2026-10-15T09:00:0${index}.000Z`,
      ...event,
    })),
  );
  const app = Fastify();
  registerCallSegmentsRoute({
    app,
    store: { getCall: async () => ({ id: CALL }) as never },
    outcomes: new CallOutcomeReader(async () => store),
    requireRole: () => ({ workspaceId: WORKSPACE }),
    Id: z.string(),
    error: (reply, status, code, message) => reply.code(status).send({ error: { code, message } }),
    ledger: {
      getCallCost: async () =>
        ({
          segments: [
            { index: 1, estimatedPaise: '10', reconciledPaise: '0', totalPaise: '10', lines: [] },
            {
              index: 2,
              estimatedPaise: '40',
              reconciledPaise: '0',
              totalPaise: '40',
              lines: [{ meter: 'ovo.human.operator_seconds', quantity: '95' }],
            },
          ],
        }) as never,
    },
  } as never);
  return app;
}

const humanEvents = [
  {
    type: 'route.segment',
    payload: { index: 1, role: 'router', agentId: 'front-desk', releaseId: 'r1', reason: 'start' },
  },
  {
    type: 'route.segment',
    payload: {
      index: 2,
      role: 'human',
      agentId: 'queue:support',
      releaseId: 'q1',
      reason: 'route',
      queueId: 'q1',
      ticketId: 't1',
      kind: 'managed',
    },
  },
  {
    type: 'human.requested',
    payload: {
      queue: 'support',
      queueId: 'q1',
      kind: 'managed',
      ticket: 't1',
      source: 'fallback',
      result: 'accepted',
    },
  },
  {
    type: 'human.state',
    payload: { ticket: 't1', state: 'connected', by: 'operator', operator: 'asha', waitMs: 8000 },
  },
  {
    type: 'human.completed',
    payload: {
      ticket: 't1',
      queue: 'support',
      kind: 'managed',
      outcome: 'ended',
      waitMs: 8000,
      talkMs: 95000,
      operator: 'asha',
    },
  },
];

describe('GET /v1/calls/:id/segments with a human segment', () => {
  it('shows the human segment’s queue, wait, talk and operator, with its cost', async () => {
    const app = await setup(humanEvents);
    const body = (await app.inject({ method: 'GET', url: `/v1/calls/${CALL}/segments` })).json();
    expect(body.available).toBe(true);
    const human = body.segments.find((segment: { role: string }) => segment.role === 'human');
    expect(human).toMatchObject({
      index: 2,
      cost: { totalPaise: '40' },
      human: {
        queue: 'support',
        ticket: 't1',
        kind: 'managed',
        operator: 'asha',
        outcome: 'ended',
      },
    });
    expect(body.human).toEqual(human.human);
    const router = body.segments.find((segment: { role: string }) => segment.role === 'router');
    expect(router.human).toBeUndefined();
  });

  it('carries no caller number, destination or summary', async () => {
    const app = await setup(humanEvents);
    const text = (await app.inject({ method: 'GET', url: `/v1/calls/${CALL}/segments` })).body;
    expect(text).not.toMatch(/\+\d{6}/);
  });

  it('reports no human block for a call that never asked for a person', async () => {
    const app = await setup([humanEvents[0]!]);
    const body = (await app.inject({ method: 'GET', url: `/v1/calls/${CALL}/segments` })).json();
    expect(body.human).toBeNull();
  });
});
