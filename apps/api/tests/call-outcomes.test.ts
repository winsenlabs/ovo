import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CallRecord, ControlStore } from '@winsendotai/ovo-plugin-storage';
import {
  MemoryCallOutcomeStore,
  PostgresCallOutcomeStore,
} from '@winsendotai/ovo-plugin-storage/outcomes';
import { buildManagementApi } from '../src/server.ts';
import { CallOutcomeReader, registerCallOutcomeRoute } from '../src/routes/call-outcomes.ts';
import { selectedSpeechFixture, selectedSpeechVoice } from './selected-speech-fixture.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const integration = databaseUrl ? describe : describe.skip;
const at = '2026-10-06T10:00:00.000Z';

const call = (id: string): CallRecord => ({
  id,
  workspaceId: 'ws',
  releaseId: 'release',
  kind: 'live',
  status: 'completed',
  createdAt: at,
  completedAt: at,
});

function build(reader: CallOutcomeReader) {
  const app = Fastify({ logger: false });
  registerCallOutcomeRoute({
    app,
    outcomes: reader,
    store: { getCall: async (_workspace, id) => (id === 'call-1' ? call(id) : undefined) },
    requireRole: () => ({ workspaceId: 'ws' }),
    Id: z.string().min(1).max(200),
    error: (reply, status, code, message) => reply.code(status).send({ error: { code, message } }),
  });
  return app;
}

describe('GET /v1/calls/:callId/outcome (AGT-8)', () => {
  it('returns the summary and the session events in order, paged', async () => {
    const store = new MemoryCallOutcomeStore();
    await store.append('ws', 'call-1', [
      {
        id: 'a',
        at,
        type: 'turn.route',
        payload: { turn: 1, tier: 'jev', intent: 'busy', confidence: 0.92 },
      },
      { id: 'b', at, type: 'disposition', payload: { disposition: 'callback', source: 'jev' } },
      {
        id: 'c',
        at,
        type: 'call.outcome',
        payload: { outcome: 'completed', reason: 'behavior_completed' },
      },
    ]);
    const app = build(new CallOutcomeReader(async () => store));
    const first = await app.inject({ method: 'GET', url: '/v1/calls/call-1/outcome?limit=2' });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      callId: 'call-1',
      status: 'completed',
      available: true,
      summary: { disposition: 'callback', outcome: 'completed', tiers: { jev: 1 } },
      events: [
        { sequence: 1, type: 'turn.route', payload: { intent: 'busy', confidence: 0.92 } },
        { sequence: 2, type: 'disposition' },
      ],
      nextCursor: '2',
    });
    const rest = await app.inject({ method: 'GET', url: '/v1/calls/call-1/outcome?cursor=2' });
    expect(rest.json().events.map((event: { type: string }) => event.type)).toEqual([
      'call.outcome',
    ]);
    expect((await app.inject({ method: 'GET', url: '/v1/calls/call-2/outcome' })).statusCode).toBe(
      404,
    );
    await app.close();
  });

  it('reports an installation without durable outcomes instead of failing', async () => {
    const app = build(new CallOutcomeReader());
    const response = await app.inject({ method: 'GET', url: '/v1/calls/call-1/outcome' });
    expect(response.json()).toEqual({
      callId: 'call-1',
      status: 'completed',
      available: false,
      summary: null,
      events: [],
      nextCursor: null,
    });
    await app.close();
  });

  it('lists calls without outcomes when the outcome store cannot be read', async () => {
    const reader = new CallOutcomeReader(async () => {
      throw new Error('database down');
    });
    const warnings: unknown[] = [];
    const page = await reader.attach('ws', { items: [call('call-1')], nextCursor: null }, {
      warn: (entry: unknown) => warnings.push(entry),
    } as never);
    expect(page.items).toEqual([{ ...call('call-1'), outcome: null }]);
    expect(warnings).toHaveLength(1);
  });
});

integration('call outcomes through the PostgreSQL management API', () => {
  it('attaches each call outcome to the call list and serves the outcome endpoint', async () => {
    const workspaceId = `outcomes-${randomUUID()}`;
    const headers = { authorization: 'Bearer outcomes-token' };
    const { app, composition } = await buildManagementApi({
      storageAdapter: 'postgres',
      controlDatabaseUrl: databaseUrl,
      storageMaxConnections: 4,
      secretBackend: 'encrypted-store',
      secretsMasterKey: Buffer.alloc(32, 9).toString('base64'),
      sessionSecret: 'outcomes-api-test-session',
      pluginCatalog: [selectedSpeechFixture],
      identities: [
        {
          id: 'operator',
          label: 'Operator',
          token: 'outcomes-token',
          defaultWorkspaceId: workspaceId,
          workspaces: { [workspaceId]: 'admin' },
        },
      ],
    });
    const outcomes = await PostgresCallOutcomeStore.open({ connectionString: databaseUrl! });
    try {
      const store = composition.ctx.get('controlStore') as ControlStore;
      const agent = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers,
        payload: {
          config: {
            name: 'Outcomes',
            mode: 'announcement',
            message: 'Hello.',
            voice: selectedSpeechVoice,
          },
        },
      });
      expect(agent.statusCode, agent.body).toBe(201);
      const release = await app.inject({
        method: 'POST',
        url: `/v1/agents/${agent.json().id}/releases`,
        headers,
        payload: {},
      });
      expect(release.statusCode, release.body).toBe(201);
      const recorded = await store.createCall({
        workspaceId,
        releaseId: release.json().id,
        kind: 'live',
        status: 'completed',
      });
      const silent = await store.createCall({
        workspaceId,
        releaseId: release.json().id,
        kind: 'live',
        status: 'active',
      });
      await outcomes.append(workspaceId, recorded.id, [
        { id: 'e1', at, type: 'flow.state', payload: { to: 'ptp_ask' } },
        {
          id: 'e2',
          at,
          type: 'disposition',
          payload: { disposition: 'promise_to_pay', source: 'jev' },
        },
      ]);
      const list = await app.inject({ method: 'GET', url: '/v1/calls', headers });
      expect(list.statusCode, list.body).toBe(200);
      const byId = new Map(list.json().items.map((item: { id: string }) => [item.id, item]));
      expect(byId.get(recorded.id)).toMatchObject({
        outcome: { disposition: 'promise_to_pay', finalNode: 'ptp_ask', statePath: ['ptp_ask'] },
      });
      expect(byId.get(silent.id)).toMatchObject({ outcome: null });
      const outcome = await app.inject({
        method: 'GET',
        url: `/v1/calls/${recorded.id}/outcome`,
        headers,
      });
      expect(outcome.statusCode, outcome.body).toBe(200);
      expect(outcome.json()).toMatchObject({
        available: true,
        summary: { disposition: 'promise_to_pay' },
        events: [{ type: 'flow.state' }, { type: 'disposition' }],
      });
      const invalid = await app.inject({
        method: 'GET',
        url: `/v1/calls/${recorded.id}/outcome?cursor=x`,
        headers,
      });
      expect(invalid.statusCode, invalid.body).toBe(400);
    } finally {
      await outcomes.close();
      await app.close();
      await composition.dispose();
    }
  });
});
