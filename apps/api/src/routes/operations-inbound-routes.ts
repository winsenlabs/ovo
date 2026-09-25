import { createHash } from 'node:crypto';
import {
  operationsApiSchemas as schemas,
  operationsPage,
  validateReleaseVariables,
} from '@winsendotai/ovo-plugin-operations';
import type { RealtimeRouteDependencies } from './operations-realtime.ts';

export function registerOperationsInboundRouteManagement(input: RealtimeRouteDependencies): void {
  const { app, store, requireRole, use, audit } = input;

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
    const route = await operations.inboundRoutes.put({
      phoneNumber,
      releaseId: release.id,
      variables: body.variables,
      enabled: body.enabled,
      expectedVersion: body.expectedVersion,
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
