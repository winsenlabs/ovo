import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordCallback } from '@winsendotai/ovo-behaviors';
import type { CallbackRequest } from '@winsendotai/ovo-contracts';
import { PostgresCallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { PostgresOrchestrationStore } from '../../../packages/plugin-orchestration/src/index.ts';
import { dialFromJob } from '../src/callback-store.ts';
import {
  CallbackService,
  createCallbackService,
  registerCallbackRoutes,
} from '../src/routes/callbacks.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const at = '2026-10-06T10:00:00.000Z';

function build(callbacks: CallbackService, workspaceId: string) {
  const app = Fastify({ logger: false });
  const audits: string[] = [];
  registerCallbackRoutes({
    app,
    callbacks,
    requireRole: () => ({ workspaceId, identityId: 'operator' }),
    error: (reply, status, code, message) => reply.code(status).send({ error: { code, message } }),
    audit: async (_principal, action, id) => audits.push(`${action}:${id}`),
  });
  return { app, audits };
}

describe('callbacks without PostgreSQL (AGT-15)', () => {
  it('lists nothing and reports the store unavailable', async () => {
    const { app } = build(createCallbackService({ storageAdapter: 'sqlite' }), 'ws');
    expect((await app.inject({ method: 'GET', url: '/v1/callbacks' })).json()).toEqual({
      available: false,
      items: [],
      nextCursor: null,
    });
    const dial = await app.inject({ method: 'POST', url: `/v1/callbacks/${randomUUID()}/dial` });
    expect(dial.statusCode).toBe(503);
    await app.close();
  });
});

describe('dialFromJob', () => {
  it('calls an inbound caller back from the number they dialled, and repeats an outbound call', () => {
    const variables = { name: 'Ravi', amount_due: 12500, nested: { no: 1 } };
    expect(
      dialFromJob({
        kind: 'inbound_call',
        releaseId: 'r',
        from: '+919800000001',
        to: '+918040000000',
        variables,
      }),
    ).toEqual({
      releaseId: 'r',
      to: '+919800000001',
      fromNumber: '+918040000000',
      variables: { name: 'Ravi', amount_due: '12500' },
    });
    expect(dialFromJob({ releaseId: 'r', to: '+919800000002', from: '+918040000000' })).toEqual({
      releaseId: 'r',
      to: '+919800000002',
      fromNumber: '+918040000000',
      variables: {},
    });
    expect(dialFromJob({ releaseId: 'r', to: '+919800000002' })).toBeUndefined();
  });
});

describe.skipIf(!postgresUrl)('callbacks in PostgreSQL (AGT-15)', () => {
  const pool = new Pool({ connectionString: postgresUrl, max: 2 });
  const workspaceId = `callbacks-${randomUUID()}`;
  const inbound = randomUUID();
  const outbound = randomUUID();
  const releaseId = randomUUID();
  let outcomes: PostgresCallOutcomeStore;
  let callbacks: CallbackService;
  let app: FastifyInstance;
  let audits: string[];
  const placed: Record<string, unknown>[] = [];
  let liveStatus = 202;

  /** The event exactly as the agent records it (`recordCallback`), so the two cannot drift. */
  const callback = (id: string, dueAt: string, extra: Record<string, unknown> = {}) => {
    const recorded: Record<string, unknown>[] = [];
    recordCallback(
      { append: async (_type, payload) => void recorded.push(payload) },
      {
        turn: 1,
        disposition: 'callback:this_evening',
        source: extra.source === 'llm' ? 'llm' : 'flow',
        request: {
          dueAt,
          timezone: 'Asia/Kolkata',
          source: 'flow',
          node: 'cb_evening',
          ...extra,
        } as CallbackRequest,
      },
    );
    return { id, at, type: 'disposition', payload: recorded[0]! };
  };

  beforeAll(async () => {
    await new PostgresOrchestrationStore(pool).migrate();
    for (const [id, payload] of [
      [
        inbound,
        {
          kind: 'inbound_call',
          callId: inbound,
          releaseId,
          from: '+919800000001',
          to: '+918040000000',
          variables: { name: 'Ravi' },
        },
      ],
      [outbound, { callId: outbound, releaseId, to: '+919800000002', from: '+918040000000' }],
    ] as const)
      await pool.query(
        `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status)
         VALUES ($1,$2,$3,$4::jsonb,'completed')`,
        [id, workspaceId, id, JSON.stringify(payload)],
      );
    outcomes = await PostgresCallOutcomeStore.open({ connectionString: postgresUrl! });
    await outcomes.append(workspaceId, inbound, [
      callback('e1', '2026-10-06T12:30:00.000Z'),
      // Not a callback, and a callback whose time is not an instant: neither is kept.
      { id: 'e2', at, type: 'disposition', payload: { disposition: 'paid', source: 'jev' } },
      callback('e3', 'this evening'),
    ]);
    await outcomes.append(workspaceId, outbound, [
      callback('e1', '2026-10-06T11:00:00+05:30', { source: 'llm', node: undefined }),
    ]);
    callbacks = createCallbackService({
      storageAdapter: 'postgres',
      controlDatabaseUrl: postgresUrl,
    });
    ({ app, audits } = build(callbacks, workspaceId));
    app.post('/v1/calls', async (request, reply) => {
      placed.push(request.body as Record<string, unknown>);
      if (liveStatus !== 202)
        return reply.code(liveStatus).send({ error: { code: 'live_calls_disabled' } });
      return reply
        .code(202)
        .send({ callId: (request.body as { operationId: string }).operationId });
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.query('DELETE FROM ovo_callbacks WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM ovo_session_events WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM ovo_jobs WHERE workspace_id = $1', [workspaceId]);
    await outcomes.close();
    await pool.end();
  });

  const list = async (query = '') =>
    (await app.inject({ method: 'GET', url: `/v1/callbacks${query}` })).json();

  it('keeps every promised callback, soonest due first, with the number masked', async () => {
    const first = await list();
    expect(first.available).toBe(true);
    expect(
      first.items.map((item: Record<string, unknown>) => [
        item.callId,
        item.dueAt,
        item.source,
        item.status,
        item.phone,
      ]),
    ).toEqual([
      [outbound, '2026-10-06T05:30:00.000Z', 'llm', 'pending', '••••0002'],
      [inbound, '2026-10-06T12:30:00.000Z', 'flow', 'pending', '••••0001'],
    ]);
    // A second sync keeps the same callbacks, never a copy.
    expect((await list()).items.map((item: { id: string }) => item.id)).toEqual(
      first.items.map((item: { id: string }) => item.id),
    );
    const paged = await list('?limit=1');
    expect(paged.items).toHaveLength(1);
    expect(
      (await list(`?limit=1&cursor=${encodeURIComponent(paged.nextCursor)}`)).items[0].callId,
    ).toBe(inbound);
  });

  it('dials a callback through the live-call route, retrying with the same operation id', async () => {
    const { items } = await list();
    const target = items.find((item: { callId: string }) => item.callId === inbound);
    liveStatus = 503;
    const refused = await app.inject({ method: 'POST', url: `/v1/callbacks/${target.id}/dial` });
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe('live_calls_disabled');
    expect((await list('?status=pending')).items).toHaveLength(2);
    liveStatus = 202;
    const dialed = await app.inject({ method: 'POST', url: `/v1/callbacks/${target.id}/dial` });
    expect(dialed.statusCode, dialed.body).toBe(202);
    expect(placed).toHaveLength(2);
    expect(placed[1]).toEqual(placed[0]);
    expect(placed[1]).toEqual({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      releaseId,
      to: '+919800000001',
      fromNumber: '+918040000000',
      variables: { name: 'Ravi' },
    });
    expect(dialed.json()).toMatchObject({ status: 'dialed', dialedCallId: placed[1]!.operationId });
    const again = await app.inject({ method: 'POST', url: `/v1/callbacks/${target.id}/dial` });
    expect(again.statusCode).toBe(409);
    expect(audits).toEqual([`callback.dial:${target.id}`]);
  });

  it('completes a dialled callback and cancels a pending one, once', async () => {
    const { items } = await list();
    const dialed = items.find((item: { status: string }) => item.status === 'dialed');
    const pending = items.find((item: { status: string }) => item.status === 'pending');
    const post = (id: string, action: string) =>
      app.inject({ method: 'POST', url: `/v1/callbacks/${id}/${action}` });
    expect((await post(dialed.id, 'cancel')).statusCode).toBe(409);
    expect((await post(dialed.id, 'complete')).json()).toMatchObject({ status: 'completed' });
    expect((await post(pending.id, 'cancel')).json()).toMatchObject({ status: 'cancelled' });
    expect((await post(pending.id, 'dial')).statusCode).toBe(409);
    expect((await post(randomUUID(), 'cancel')).statusCode).toBe(404);
    expect((await list('?status=pending')).items).toEqual([]);
  });

  it('frees a callback an API left dialing: re-dialled after the lease, or closed', async () => {
    const stuck = randomUUID();
    await pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status)
       VALUES ($1,$2,$3,$4::jsonb,'completed')`,
      [
        stuck,
        workspaceId,
        stuck,
        JSON.stringify({ releaseId, to: '+919800000003', from: '+918040000000' }),
      ],
    );
    await outcomes.append(workspaceId, stuck, [callback('e1', '2026-10-07T05:00:00.000Z')]);
    await list();
    const operationId = randomUUID();
    // The claim an API took before it stopped: `dialing`, with its operation id, never moved on.
    const leave = (age: string) =>
      pool.query(
        `UPDATE ovo_callbacks SET status = 'dialing', dial_operation_id = $3::uuid,
           updated_at = now() - $4::interval WHERE workspace_id = $1 AND call_id = $2`,
        [workspaceId, stuck, operationId, age],
      );
    expect((await list('?status=dialing')).items).toEqual([]);
    await leave('0 seconds');
    const { items } = await list('?status=dialing');
    expect(items.map((item: { callId: string }) => item.callId)).toEqual([stuck]);
    const id = items[0].id;
    const post = (action: string) =>
      app.inject({ method: 'POST', url: `/v1/callbacks/${id}/${action}` });
    // A dial still inside its lease is left alone.
    expect((await post('dial')).statusCode).toBe(409);
    await leave('10 minutes');
    const before = placed.length;
    const redialed = await post('dial');
    expect(redialed.statusCode, redialed.body).toBe(202);
    expect(placed.slice(before)).toEqual([expect.objectContaining({ operationId })]);
    expect(redialed.json()).toMatchObject({ status: 'dialed', dialedCallId: operationId });
    await leave('0 seconds');
    expect((await post('cancel')).json()).toMatchObject({ status: 'cancelled' });
  });
});
