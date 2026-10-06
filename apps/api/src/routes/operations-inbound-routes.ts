import { createHash } from 'node:crypto';
import {
  operationsApiSchemas as schemas,
  operationsPage,
  validateReleaseVariables,
  operationsRequestError,
  type InboundOverflowPolicy,
} from '@winsendotai/ovo-plugin-operations';
import type { RealtimeRouteDependencies } from './operations-realtime.ts';
import { validateInboundCarrier } from '../operations-plugin.ts';

export function registerOperationsInboundRouteManagement(input: RealtimeRouteDependencies): void {
  const { app, store, requireRole, use, audit } = input;

  app.get('/v1/operations/inbound/policy', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const operations = use(reply, principal);
    if (!operations) return;
    return { policy: await operations.inbound.getPolicy() };
  });

  app.put('/v1/operations/inbound/policy', async (request, reply) => {
    const principal = requireRole(request, 'admin'),
      operations = use(reply, principal);
    if (!operations) return;
    const body = schemas.inboundPolicy.parse(request.body);
    const policy = await operations.inbound.setPolicy(
      body.policy as InboundOverflowPolicy,
      body.expectedVersion,
    );
    if (!policy)
      return reply.code(409).send({
        error: { code: 'inbound_policy_conflict', message: 'Inbound policy state changed' },
        current: await operations.inbound.getPolicy(),
      });
    await audit(principal, 'operations.inbound.policy.update', 'inbound_policy', 'default', {
      version: policy.version,
      kind: policy.policy.kind,
    });
    return policy;
  });

  // OPS-4: `readiness` says why readyProtected is what it is (admission off, no ready worker,
  // no warm floor) as the dispatcher last saw it; null before any dispatcher published it.
  app.get('/v1/operations/inbound/capacity', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const operations = use(reply, principal);
    if (!operations) return;
    const [readyProtected, readiness] = await Promise.all([
      operations.inbound.readyProtectedCapacity(),
      input.inboundReadiness?.() ?? Promise.resolve(null),
    ]);
    return { readyProtected, readiness };
  });

  app.get('/v1/operations/inbound/decisions', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const operations = use(reply, principal);
    if (!operations) return;
    const query = schemas.uuidPage.parse(request.query),
      items = await operations.inbound.listDecisions(query.limit, query.cursor);
    return operationsPage(items, query.limit);
  });

  app.post('/v1/operations/inbound/decisions', async (request, reply) => {
    const principal = requireRole(request, 'admin'),
      operations = use(reply, principal);
    if (!operations) return;
    const { callId } = schemas.inboundDecision.parse(request.body);
    let decision;
    try {
      decision = await operations.inbound.admitUsingPolicy(callId);
    } catch (error) {
      if ((error as Error).message.includes('not configured'))
        return operationsRequestError(
          409,
          'inbound_policy_missing',
          'Inbound policy is not configured',
        );
      throw error;
    }
    await audit(principal, 'operations.inbound.decide', 'inbound_call', callId, {
      decision: decision.kind,
    });
    return reply.code(201).send(decision);
  });

  app.get('/v1/operations/inbound/routes', async (request, reply) => {
    const principal = requireRole(request, 'viewer'),
      operations = use(reply, principal);
    if (!operations) return;
    const query = schemas.suppressionPage.parse(request.query);
    const items = await operations.inboundRoutes.list(query.limit, query.cursor);
    return operationsPage(items, query.limit);
  });

  app.put('/v1/operations/inbound/routes/:phoneNumber', async (request, reply) => {
    const principal = requireRole(request, 'admin'),
      operations = use(reply, principal);
    if (!operations) return;
    const { phoneNumber } = schemas.inboundRouteParams.parse(request.params);
    const body = schemas.inboundRoute.parse(request.body);
    const release = await store.getRelease(principal.workspaceId, body.releaseId);
    if (!release)
      return reply
        .code(404)
        .send({ error: { code: 'release_not_found', message: 'Release not found' } });
    const validation = validateReleaseVariables(release.config.variables, body.variables);
    if (!validation.valid)
      return reply.code(422).send({
        error: {
          code: 'invalid_inbound_route_variables',
          message: 'Inbound route variables do not satisfy the release schema',
          details: validation.errors,
        },
      });
    try {
      await validateInboundCarrier(
        operations,
        principal.workspaceId,
        body.carrierPluginId,
        body.carrierBindingId,
        store,
      );
    } catch (error) {
      return reply.code(422).send({
        error: { code: 'inbound_carrier_invalid', message: (error as Error).message },
      });
    }
    const route = await operations.inboundRoutes.put({
      phoneNumber,
      releaseId: release.id,
      variables: body.variables,
      enabled: body.enabled,
      expectedVersion: body.expectedVersion,
      carrierPluginId: body.carrierPluginId ?? null,
      carrierBindingId: body.carrierBindingId ?? null,
    });
    if (!route)
      return reply.code(409).send({
        error: { code: 'inbound_route_conflict', message: 'Inbound route state changed' },
        current: await operations.inboundRoutes.get(phoneNumber),
      });
    const resourceId = createHash('sha256').update(phoneNumber).digest('hex');
    await audit(principal, 'operations.inbound.route.put', 'inbound_route', resourceId, {
      releaseId: route.releaseId,
      version: route.version,
      enabled: route.enabled,
    });
    return route;
  });

  app.delete('/v1/operations/inbound/routes/:phoneNumber', async (request, reply) => {
    const principal = requireRole(request, 'admin'),
      operations = use(reply, principal);
    if (!operations) return;
    const { phoneNumber } = schemas.inboundRouteParams.parse(request.params);
    const { expectedVersion } = schemas.inboundRouteDelete.parse(request.query);
    if (!(await operations.inboundRoutes.remove(phoneNumber, expectedVersion)))
      return reply.code(409).send({
        error: { code: 'inbound_route_conflict', message: 'Inbound route state changed' },
        current: await operations.inboundRoutes.get(phoneNumber),
      });
    await audit(
      principal,
      'operations.inbound.route.delete',
      'inbound_route',
      createHash('sha256').update(phoneNumber).digest('hex'),
    );
    return reply.code(204).send();
  });
}
