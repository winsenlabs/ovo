import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresCallOutcomeStore,
  runCallOutcomeMigrations,
} from '@winsendotai/ovo-plugin-storage/outcomes';
import { PostgresOrchestrationStore } from '../../../packages/plugin-orchestration/src/index.ts';
import { runCallbackMigrations } from '../src/callback-store.ts';
import { registerCallbacks } from '../src/routes/callbacks.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

/** A closed variable schema: only `names` (all strings) are accepted. */
const closed = (...names: string[]) => ({
  config: {
    variables: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(names.map((name) => [name, { type: 'string' }])),
    },
  },
});

describe.skipIf(!postgresUrl)('callback dials pass only declared variables (R1 audit 2)', () => {
  const schema = `callbacks_vars_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(postgresUrl ?? 'postgres://localhost/none');
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString(), max: 3 });
  const workspaceId = `callbacks-vars-${randomUUID()}`;
  const routerRelease = randomUUID();
  const memberRelease = randomUUID();
  const defaultRelease = randomUUID();
  const directRelease = randomUUID();
  const routedCall = randomUUID();
  const directCall = randomUUID();
  /** What each release accepts; the router keeps an open schema, like a front desk does. */
  const releases: Record<string, { config: { variables: Record<string, unknown> } }> = {
    [routerRelease]: { config: { variables: { type: 'object' } } },
    [memberRelease]: closed('customer_name'),
    [defaultRelease]: closed('customer_name', 'account'),
    [directRelease]: closed('customer_name', 'account'),
  };
  const placed: Record<string, unknown>[] = [];
  let app: FastifyInstance;

  const job = (id: string, releaseId: string, variables: Record<string, unknown>) =>
    pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status)
       VALUES ($1,$2,$3,$4::jsonb,'completed')`,
      [
        id,
        workspaceId,
        id,
        JSON.stringify({
          kind: 'inbound_call',
          releaseId,
          from: '+919800000001',
          to: '+918040000000',
          variables,
        }),
      ],
    );
  const callback = (id: string, dueAt: string, extra: Record<string, unknown>) => ({
    id,
    at: '2026-10-15T08:00:00.000Z',
    type: 'disposition' as const,
    payload: { disposition: 'callback', callback: { dueAt, timezone: 'Asia/Kolkata', ...extra } },
  });

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await runCallOutcomeMigrations(pool);
    await runCallbackMigrations(pool);
    await new PostgresOrchestrationStore(pool).migrate();
    // A routed call: the job carries the router's release and its variables.
    await job(routedCall, routerRelease, {
      customer_name: 'Asha',
      account: 42,
      ovo_route_intent: 'billing',
    });
    await job(directCall, directRelease, { customer_name: 'Ravi', account: 'A-7' });
    const outcomes = new PostgresCallOutcomeStore(pool);
    await outcomes.append(workspaceId, routedCall, [
      // The member agent promised it and the worker stamped its release.
      callback('e1', '2026-10-15T10:00:00.000Z', { source: 'route', releaseId: memberRelease }),
      // A hold timeout or route fallback callback: the default agent calls back.
      callback('e2', '2026-10-15T11:00:00.000Z', { source: 'route', releaseId: defaultRelease }),
    ]);
    await outcomes.append(workspaceId, directCall, [
      callback('e3', '2026-10-15T12:00:00.000Z', { source: 'flow' }),
    ]);
    app = Fastify({ logger: false });
    registerCallbacks({
      app,
      requireRole: () => ({ workspaceId, identityId: 'operator' }),
      error: (reply, status, code, message) =>
        reply.code(status).send({ error: { code, message } }),
      store: {
        audit: async () => undefined,
        getRelease: async (workspace, id) =>
          workspace === workspaceId ? (releases[id] as never) : undefined,
      },
      options: { storageAdapter: 'postgres', controlDatabaseUrl: url.toString() },
    });
    app.post('/v1/calls', async (request, reply) => {
      placed.push(request.body as Record<string, unknown>);
      return reply
        .code(202)
        .send({ callId: (request.body as { operationId: string }).operationId });
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  // Busy-number overflow callbacks never reach this route: confirmInboundCallback turns them
  // into campaign contacts (plugin-operations), so their filtering is not covered here.
  it('dials routed, default-agent fallback and direct callbacks with what each release declares', async () => {
    const { items } = (await app.inject({ method: 'GET', url: '/v1/callbacks' })).json();
    expect(items).toHaveLength(3);
    for (const item of items) {
      const dialed = await app.inject({ method: 'POST', url: `/v1/callbacks/${item.id}/dial` });
      expect(dialed.statusCode, dialed.body).toBe(202);
    }
    expect(placed.map((body) => [body.releaseId, body.variables])).toEqual([
      // Routed: the member declares only the name; the router's own variables never reach it.
      [memberRelease, { customer_name: 'Asha' }],
      // Route fallback to the default agent: its declared variables, as the strings a call carries.
      [defaultRelease, { customer_name: 'Asha', account: '42' }],
      // Direct: the call's own release, its variables unchanged.
      [directRelease, { customer_name: 'Ravi', account: 'A-7' }],
    ]);
  });
});
