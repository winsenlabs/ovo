import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { InboundRoute, InboundRouteInput } from '@winsendotai/ovo-plugin-operations';
import { registerOperationsRoutes } from '../src/routes/operations.ts';
import {
  fakeStore,
  FakeRoutingService,
  release,
  ROUTER_RELEASE,
  WORKSPACE,
} from './routing-fixtures.ts';

const NUMBER = '+918040001234';
const AGENT_RELEASE = '13131313-1313-4131-8131-131313131313';
const MISSING = '99999999-9999-4999-8999-999999999999';
const variables = (properties: Record<string, unknown>, required: string[] = []) => ({
  variables: { type: 'object', properties, required, additionalProperties: false },
});

/** The inbound route store as design 5.3 has it: put writes one target and NULLs the other. */
function fakeInboundRoutes() {
  const rows = new Map<string, InboundRoute>();
  const inputs: InboundRouteInput[] = [];
  return {
    rows,
    inputs,
    async get(phoneNumber: string) {
      return rows.get(phoneNumber);
    },
    async list() {
      return [...rows.values()];
    },
    async put(input: InboundRouteInput) {
      inputs.push(input);
      const current = rows.get(input.phoneNumber);
      if ((current?.version ?? null) !== input.expectedVersion) return undefined;
      const now = new Date();
      const route: InboundRoute = {
        organizationId: WORKSPACE,
        phoneNumber: input.phoneNumber,
        releaseId: input.releaseId ?? null,
        routingReleaseId: input.routingReleaseId ?? null,
        routing: input.routingReleaseId
          ? { pointId: 'point-1', pointName: 'Main line', version: 1 }
          : null,
        variables: input.variables ?? {},
        enabled: input.enabled ?? true,
        version: (current?.version ?? 0) + 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      } as InboundRoute;
      rows.set(input.phoneNumber, route);
      return route;
    },
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function setup(routingEnabled = true) {
  const routing = new FakeRoutingService();
  const store = fakeStore([
    release(ROUTER_RELEASE, 'front-desk', {
      config: variables({ campaign: { type: 'string' } }, ['campaign']),
    }),
    release(AGENT_RELEASE, 'sales-en', { config: variables({ region: { type: 'string' } }) }),
  ]);
  const point = await routing.points.create({} as never);
  const routingRelease = await routing.releases.create({
    pointId: point.id,
    draftVersion: 1,
    snapshot: {
      router: { agentId: 'front-desk', release: { kind: 'pinned', releaseId: ROUTER_RELEASE } },
      defaultTarget: { agentId: 'sales-en', release: { kind: 'pinned', releaseId: AGENT_RELEASE } },
    } as never,
    digest: 'a'.repeat(64),
    createdBy: 'test',
  });
  const inboundRoutes = fakeInboundRoutes();
  const app = Fastify({ logger: false });
  apps.push(app);
  app.setErrorHandler((caught, _request, reply) => {
    const thrown = caught as Error & { statusCode?: number; code?: string };
    if (thrown instanceof z.ZodError)
      return reply.code(400).send({ error: { code: 'validation_error' } });
    return reply.code(thrown.statusCode ?? 500).send({ error: { code: thrown.code } });
  });
  registerOperationsRoutes({
    app,
    store: store as never,
    requireRole: () => ({
      identityId: 'admin',
      label: 'Admin',
      workspaceId: WORKSPACE,
      role: 'admin',
    }),
    operations: { organizationId: WORKSPACE, routing, inboundRoutes } as never,
    routingEnabled,
  });
  const put = (body: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: `/v1/operations/inbound/routes/${encodeURIComponent(NUMBER)}`,
      payload: { expectedVersion: inboundRoutes.rows.get(NUMBER)?.version ?? null, ...body },
    });
  return { put, store, inboundRoutes, routingReleaseId: routingRelease!.id };
}

describe('the inbound route PUT target union (A6)', () => {
  it('switches a number from an agent to a routing release and back, auditing the previous target', async () => {
    const { put, store, routingReleaseId } = await setup();
    const direct = await put({ releaseId: AGENT_RELEASE });
    expect(direct.statusCode, direct.body).toBe(200);
    expect(direct.json()).toMatchObject({ releaseId: AGENT_RELEASE, routingReleaseId: null });

    const routed = await put({ routingReleaseId, variables: { campaign: 'diwali' } });
    expect(routed.statusCode, routed.body).toBe(200);
    expect(routed.json()).toMatchObject({ releaseId: null, routingReleaseId, version: 2 });

    const back = await put({ releaseId: AGENT_RELEASE });
    expect(back.json()).toMatchObject({
      releaseId: AGENT_RELEASE,
      routingReleaseId: null,
      version: 3,
    });

    const resourceId = createHash('sha256').update(NUMBER).digest('hex');
    expect(store.audits.map((entry) => [entry.action, entry.resourceId, entry.payload])).toEqual([
      [
        'operations.inbound.route.put',
        resourceId,
        expect.objectContaining({
          releaseId: AGENT_RELEASE,
          routingReleaseId: null,
          previousTarget: null,
        }),
      ],
      [
        'operations.inbound.route.put',
        resourceId,
        expect.objectContaining({
          releaseId: null,
          routingReleaseId,
          previousTarget: { releaseId: AGENT_RELEASE },
        }),
      ],
      [
        'operations.inbound.route.put',
        resourceId,
        expect.objectContaining({ previousTarget: { routingReleaseId } }),
      ],
    ]);
  });

  it('refuses a routing release while routing is off (409 routing_disabled)', async () => {
    const { put, inboundRoutes, routingReleaseId } = await setup(false);
    const refused = await put({ routingReleaseId, variables: { campaign: 'x' } });
    expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'routing_disabled']);
    expect(inboundRoutes.rows.size).toBe(0);
    // A direct number still binds as before.
    expect((await put({ releaseId: AGENT_RELEASE })).statusCode).toBe(200);
  });

  it('refuses an unknown routing release (404) and a body naming both or neither target', async () => {
    const { put, routingReleaseId } = await setup();
    const missing = await put({ routingReleaseId: MISSING });
    expect([missing.statusCode, missing.json().error.code]).toEqual([
      404,
      'routing_release_not_found',
    ]);
    expect((await put({ releaseId: AGENT_RELEASE, routingReleaseId })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
  });

  it("binds a routed number with its default agent's variable schema, a direct one without", async () => {
    // R1 audit gap 2: operations filters an overflow callback's variables by this schema.
    const { put, inboundRoutes, routingReleaseId } = await setup();
    expect((await put({ routingReleaseId, variables: { campaign: 'diwali' } })).statusCode).toBe(
      200,
    );
    expect((await put({ releaseId: AGENT_RELEASE })).statusCode).toBe(200);
    expect(inboundRoutes.inputs.map((input) => input.defaultVariablesSchema)).toEqual([
      variables({ region: { type: 'string' } }).variables,
      undefined,
    ]);
  });

  it("validates variables against the router release's schema", async () => {
    const { put, routingReleaseId } = await setup();
    const refused = await put({ routingReleaseId, variables: { region: 'south' } });
    expect([refused.statusCode, refused.json().error.code]).toEqual([
      422,
      'invalid_inbound_route_variables',
    ]);
    expect((await put({ routingReleaseId, variables: { campaign: 'diwali' } })).statusCode).toBe(
      200,
    );
  });

  it('refuses variable names with the reserved ovo_route_ prefix, routed or direct', async () => {
    const { put, routingReleaseId } = await setup();
    for (const target of [{ releaseId: AGENT_RELEASE }, { routingReleaseId }]) {
      const refused = await put({
        ...target,
        variables: { ovo_route_intent: 'sales', campaign: 'x' },
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error).toMatchObject({
        code: 'invalid_inbound_route_variables',
        details: ['ovo_route_intent'],
      });
    }
  });

  it('validates the carrier for a routed number as for a direct one', async () => {
    const { put, routingReleaseId } = await setup();
    const refused = await put({
      routingReleaseId,
      variables: { campaign: 'x' },
      carrierBindingId: 'binding-1',
    });
    expect([refused.statusCode, refused.json().error.code]).toEqual([
      422,
      'inbound_carrier_invalid',
    ]);
  });
});
