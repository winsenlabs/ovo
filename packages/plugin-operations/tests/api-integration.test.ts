import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { PostgresControlStore, type Role } from '@winsendotai/ovo-plugin-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerOperationsRoutes } from '../../../apps/api/src/routes/operations.ts';
import {
  PostgresOperationsService,
  type HandoffProviderPort,
  type HandoffProviderResult,
  type HandoffReconciliation,
} from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const integration = postgresUrl ? describe : describe.skip;
const roleRank: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

class ApiHandoffProvider implements HandoffProviderPort {
  requests = 0;
  async request(): Promise<HandoffProviderResult> {
    this.requests += 1;
    return { kind: 'confirmed', receiptId: 'transfer-receipt' };
  }
  async reconcile(): Promise<HandoffReconciliation> {
    return { kind: 'pending' };
  }
  async fallback(): Promise<HandoffProviderResult> {
    return { kind: 'confirmed', receiptId: 'fallback-receipt' };
  }
}

integration('operations Fastify registrar with PostgreSQL services', () => {
  const workspaceId = `operations-api-${randomUUID()}`;
  const provider = new ApiHandoffProvider();
  const fromNumber = '+14155550000';
  let operations: PostgresOperationsService;
  let store: PostgresControlStore;
  let app: ReturnType<typeof Fastify>;
  let releaseId: string;

  function requireRole(request: FastifyRequest, expected: Role) {
    const role = String(request.headers['x-test-role'] ?? 'admin') as Role;
    if (!roleRank[role] || roleRank[role] < roleRank[expected])
      throw Object.assign(new Error('Insufficient role'), { statusCode: 403, code: 'forbidden' });
    return { identityId: `operator-${role}`, label: `Operator ${role}`, workspaceId, role };
  }

  const inject = (input: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    url: string;
    payload?: object;
    role?: Role;
  }) =>
    app.inject({
      method: input.method,
      url: input.url,
      payload: input.payload,
      headers: { 'x-test-role': input.role ?? 'admin' },
    });

  beforeAll(async () => {
    operations = new PostgresOperationsService({
      connectionString: postgresUrl,
      organizationId: workspaceId,
      handoffProvider: provider,
      config: { permittedFromNumbers: [fromNumber], liveEnabled: true },
    });
    store = await PostgresControlStore.open(postgresUrl!);
    await Promise.all([operations.migrate(), store.ensureWorkspace(workspaceId, 'Operations API')]);
    const agent = await store.createAgent(
      workspaceId,
      AgentConfig.parse({
        name: 'Operations release',
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
    const release = await store.createRelease({
      workspaceId,
      agent,
      plugins: [],
      createdBy: 'operator-admin',
      id: randomUUID(),
    });
    releaseId = release.id;
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

  it('fails closed when the production operations service is absent', async () => {
    const unavailable = Fastify();
    registerOperationsRoutes({ app: unavailable, operations: undefined, store, requireRole });
    const response = await unavailable.inject({
      method: 'GET',
      url: '/v1/operations/campaigns',
      headers: { 'x-test-role': 'viewer' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'operations_unavailable' } });
    await unavailable.close();
  });

  it('validates release and caller-number ownership, roles, CSV preview, campaign state, and audit', async () => {
    expect(
      (
        await inject({
          method: 'POST',
          url: '/v1/operations/campaigns/preview',
          role: 'editor',
          payload: {
            csv: 'phone,name\n+14155550100,A',
            mapping: { phone: 'phone', variables: { name: 'name' } },
          },
        })
      ).json().rows,
    ).toHaveLength(1);
    const payload = {
      operationId: randomUUID(),
      name: 'September campaign',
      releaseId,
      fromNumber,
      schedule: { localDateTime: '2026-01-15T12:00', timezone: 'UTC' },
      perNumberAttemptLimit: 2,
      maxAttemptsTotal: 10,
      maxAttemptsPerLocalDay: 5,
      activeCallPolicy: 'continue',
      contacts: [{ sourceRow: 2, phoneNumber: '+14155550100', variables: { name: 'A' } }],
    };
    expect(
      (await inject({ method: 'POST', url: '/v1/operations/campaigns', payload, role: 'viewer' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await inject({
          method: 'POST',
          url: '/v1/operations/campaigns',
          payload: { ...payload, operationId: randomUUID(), fromNumber: '+14155559999' },
          role: 'editor',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await inject({
          method: 'POST',
          url: '/v1/operations/campaigns',
          payload: { ...payload, operationId: randomUUID(), releaseId: randomUUID() },
          role: 'editor',
        })
      ).statusCode,
    ).toBe(404);
    const created = await inject({
      method: 'POST',
      url: '/v1/operations/campaigns',
      payload,
      role: 'editor',
    });
    expect(created.statusCode).toBe(201);
    const campaign = created.json();
    const detail = await inject({
      method: 'GET',
      url: `/v1/operations/campaigns/${campaign.id}`,
      role: 'viewer',
    });
    expect(detail.json()).toMatchObject({
      campaign: { id: campaign.id },
      counters: { contacts: { queued: 1 } },
    });
    const paused = await inject({
      method: 'POST',
      url: `/v1/operations/campaigns/${campaign.id}/pause`,
      role: 'editor',
      payload: { expectedVersion: campaign.version },
    });
    expect(paused.json().status).toBe('paused');
    const actions = (await store.listAudit(workspaceId, 100)).items.map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(['operations.campaign.create', 'operations.campaign.pause']),
    );
  });

  it('provides audited suppression and versioned inbound policy/capacity decisions', async () => {
    const phoneNumber = '+14155550110';
    expect(
      (
        await inject({
          method: 'POST',
          url: '/v1/operations/suppressions',
          role: 'editor',
          payload: { phoneNumber, reason: 'Customer request' },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await inject({ method: 'GET', url: '/v1/operations/suppressions', role: 'viewer' })).json()
        .items,
    ).toHaveLength(1);
    expect(
      (
        await inject({
          method: 'PUT',
          url: '/v1/operations/inbound/policy',
          role: 'viewer',
          payload: { expectedVersion: null, policy: { kind: 'busy', reason: 'No warm capacity' } },
        })
      ).statusCode,
    ).toBe(403);
    const policy = await inject({
      method: 'PUT',
      url: '/v1/operations/inbound/policy',
      payload: { expectedVersion: null, policy: { kind: 'busy', reason: 'No warm capacity' } },
    });
    expect(policy.json()).toMatchObject({ version: 1, policy: { kind: 'busy' } });
    const decision = await inject({
      method: 'POST',
      url: '/v1/operations/inbound/decisions',
      payload: { callId: 'inbound-api-1' },
    });
    expect(decision.json()).toMatchObject({ kind: 'busy', reason: 'No warm capacity' });
    expect(
      (
        await inject({ method: 'GET', url: '/v1/operations/inbound/capacity', role: 'viewer' })
      ).json(),
    ).toEqual({ readyProtected: 0 });
    expect(
      (
        await inject({ method: 'GET', url: '/v1/operations/inbound/decisions', role: 'viewer' })
      ).json().items,
    ).toHaveLength(1);
    const routeNumber = '+14155550120';
    expect(
      (
        await inject({
          method: 'PUT',
          url: `/v1/operations/inbound/routes/${routeNumber}`,
          role: 'viewer',
          payload: { expectedVersion: null, releaseId, variables: { name: 'Inbound' } },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await inject({
          method: 'PUT',
          url: `/v1/operations/inbound/routes/${routeNumber}`,
          payload: { expectedVersion: null, releaseId, variables: {} },
        })
      ).statusCode,
    ).toBe(422);
    const route = await inject({
      method: 'PUT',
      url: `/v1/operations/inbound/routes/${routeNumber}`,
      payload: { expectedVersion: null, releaseId, variables: { name: 'Inbound' } },
    });
    expect(route.json()).toMatchObject({
      phoneNumber: routeNumber,
      releaseId,
      variables: { name: 'Inbound' },
      version: 1,
    });
    expect(
      (await inject({ method: 'GET', url: '/v1/operations/inbound/routes', role: 'viewer' })).json()
        .items,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ phoneNumber: routeNumber })]));
    expect((await store.listAudit(workspaceId, 100)).items.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'operations.suppression.upsert',
        'operations.inbound.policy.update',
        'operations.inbound.decide',
        'operations.inbound.route.put',
      ]),
    );
  });

  it('returns handoff unavailable before persisting an operation without a carrier', async () => {
    const withoutCarrier = new PostgresOperationsService({
      pool: operations.pool,
      organizationId: workspaceId,
      config: { permittedFromNumbers: [fromNumber] },
    });
    const unavailable = Fastify();
    registerOperationsRoutes({
      app: unavailable,
      operations: withoutCarrier,
      store,
      requireRole,
    });
    const before = await operations.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ovo_ops_handoffs WHERE organization_id = $1',
      [workspaceId],
    );
    const response = await unavailable.inject({
      method: 'POST',
      url: '/v1/operations/handoffs',
      headers: { 'x-test-role': 'editor' },
      payload: {
        operationId: randomUUID(),
        callId: randomUUID(),
        target: { kind: 'phone', value: '+14155550130' },
        fallback: { kind: 'end', message: 'Goodbye' },
        confirmationRequired: false,
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'handoff_unavailable' } });
    const after = await operations.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ovo_ops_handoffs WHERE organization_id = $1',
      [workspaceId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    await unavailable.close();
  });

  it('resolves handoffs only from owned internal live-call bindings and audits confirmation', async () => {
    const call = await store.createCall({
      workspaceId,
      releaseId,
      kind: 'live',
      status: 'active',
      id: randomUUID(),
    });
    const payload = {
      operationId: randomUUID(),
      callId: call.id,
      target: { kind: 'queue', value: 'human-sales' },
      fallback: { kind: 'resume', message: 'I can continue helping.' },
      confirmationRequired: true,
    };
    expect(
      (
        await inject({
          method: 'POST',
          url: '/v1/operations/handoffs',
          payload: { ...payload, carrierCallId: 'CA-attacker-supplied' },
          role: 'editor',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await inject({ method: 'POST', url: '/v1/operations/handoffs', payload, role: 'editor' }))
        .statusCode,
    ).toBe(409);
    await operations.calls.bind({
      internalCallId: call.id,
      carrierCallId: 'CA-owned-api-call',
      releaseId,
      bindingReceiptId: 'orchestration-receipt-1',
    });
    const requested = await inject({
      method: 'POST',
      url: '/v1/operations/handoffs',
      payload,
      role: 'editor',
    });
    expect(requested.statusCode).toBe(202);
    expect(requested.body).not.toContain('CA-owned-api-call');
    expect(provider.requests).toBe(0);
    const confirmed = await inject({
      method: 'POST',
      url: `/v1/operations/handoffs/${requested.json().id}/confirm`,
      role: 'editor',
      payload: { accepted: true },
    });
    expect(confirmed.json()).toMatchObject({
      status: 'confirmed',
      providerReceiptId: 'transfer-receipt',
    });
    expect(provider.requests).toBe(1);
    const status = await inject({
      method: 'GET',
      url: `/v1/operations/handoffs/${requested.json().id}`,
      role: 'viewer',
    });
    expect(status.body).not.toContain('CA-owned-api-call');
    expect((await store.listAudit(workspaceId, 100)).items.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['operations.handoff.request', 'operations.handoff.confirm']),
    );
  });
});
