import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { PostgresControlStore, type Role } from '@winsendotai/ovo-plugin-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerOperationsRoutes } from '../../../apps/api/src/routes/operations.ts';
import { PostgresOperationsService } from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const integration = postgresUrl ? describe : describe.skip;

integration('operations direct live API with PostgreSQL services', () => {
  const workspaceId = `operations-live-api-${randomUUID()}`;
  const fromNumber = '+14155550000';
  let operations: PostgresOperationsService;
  let store: PostgresControlStore;
  let app: ReturnType<typeof Fastify>;
  let releaseId: string;

  function requireRole(request: FastifyRequest, expected: Role) {
    const role = String(request.headers['x-test-role'] ?? 'admin') as Role;
    const rank: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };
    if (!rank[role] || rank[role] < rank[expected])
      throw Object.assign(new Error('Insufficient role'), { statusCode: 403, code: 'forbidden' });
    return { identityId: `operator-${role}`, label: `Operator ${role}`, workspaceId, role };
  }

  beforeAll(async () => {
    operations = new PostgresOperationsService({
      connectionString: postgresUrl,
      organizationId: workspaceId,
      config: { permittedFromNumbers: [fromNumber], liveEnabled: true },
    });
    store = await PostgresControlStore.open(postgresUrl!);
    await Promise.all([
      operations.migrate(),
      store.ensureWorkspace(workspaceId, 'Operations Live API'),
    ]);
    const agent = await store.createAgent(
      workspaceId,
      AgentConfig.parse({
        name: 'Live release',
        mode: 'announcement',
        message: 'Hello {{name}}',
        variables: {
          type: 'object',
          properties: { name: { type: 'string', minLength: 1 } },
          required: ['name'],
          additionalProperties: false,
        },
      }),
    );
    releaseId = (
      await store.createRelease({
        workspaceId,
        agent,
        plugins: [],
        createdBy: 'operator-admin',
        id: randomUUID(),
      })
    ).id;
    app = Fastify();
    app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      const typed = error as Error & { statusCode?: number; code?: string };
      reply.code(typed.statusCode ?? 400).send({
        error: { code: typed.code ?? 'request_error', message: typed.message },
      });
    });
    registerOperationsRoutes({ app, operations, store, requireRole });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await operations?.close();
    await store?.close();
  });

  it('keeps launch default-off and creates one idempotent traceable job when enabled', async () => {
    const disabledOperations = new PostgresOperationsService({
      pool: operations.pool,
      organizationId: workspaceId,
      config: { permittedFromNumbers: [fromNumber] },
    });
    const disabled = Fastify();
    registerOperationsRoutes({ app: disabled, operations: disabledOperations, store, requireRole });
    const operationId = randomUUID();
    const payload = {
      operationId,
      releaseId,
      fromNumber,
      to: '+14155550120',
      variables: { name: 'Ada' },
    };
    const disabledResponse = await disabled.inject({
      method: 'POST',
      url: '/v1/calls',
      payload,
      headers: { 'x-test-role': 'admin' },
    });
    expect(disabledResponse.json()).toMatchObject({ error: { code: 'live_calls_disabled' } });
    await disabled.close();

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/calls',
          payload,
          headers: { 'x-test-role': 'editor' },
        })
      ).statusCode,
    ).toBe(403);
    const missingVariables = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      payload: { ...payload, operationId: randomUUID(), variables: {} },
      headers: { 'x-test-role': 'admin' },
    });
    expect(missingVariables.statusCode).toBe(422);

    const launched = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      payload,
      headers: { 'x-test-role': 'admin' },
    });
    expect(launched.statusCode).toBe(202);
    expect(launched.json()).toMatchObject({
      callId: operationId,
      jobId: operationId,
      status: 'queued',
      campaignId: expect.any(String),
      contactId: expect.any(String),
    });
    const retried = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      payload,
      headers: { 'x-test-role': 'admin' },
    });
    expect(retried.json()).toEqual(launched.json());
    expect(await store.getCall(workspaceId, operationId)).toMatchObject({
      id: operationId,
      releaseId,
      kind: 'live',
      status: 'queued',
    });
    expect(await operations.outbox.getByJobId(operationId)).toMatchObject({
      aggregateId: operationId,
      payload: { kind: 'campaign_dial_candidate', jobId: operationId },
    });
    const persisted = await operations.pool.query<{ outbox_count: string; contact_count: string }>(
      `SELECT
         (SELECT count(*) FROM ovo_ops_outbox WHERE aggregate_id = $1)::text AS outbox_count,
         (SELECT count(*) FROM ovo_ops_campaign_contacts WHERE campaign_id = $2)::text AS contact_count`,
      [operationId, launched.json().campaignId],
    );
    expect(persisted.rows[0]).toEqual({ outbox_count: '1', contact_count: '1' });
    expect((await store.listAudit(workspaceId, 100)).items.map((entry) => entry.action)).toContain(
      'operations.live_call.launch',
    );
  });
});
