import { PageQuery } from './route-page-schema.ts';
import { z } from 'zod';
import type { PostgresEvaluationService } from '@winsendotai/ovo-plugin-evaluations';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';

import { audit, type EvaluationDatasetRouteDependencies } from './evaluation-route-support.ts';

type Dependencies = Omit<EvaluationDatasetRouteDependencies, 'store' | 'fixtureBindingVersion'> & {
  store: Pick<ControlStore, 'audit'>;
};

const Id = z.string().trim().min(1).max(200);

const AuthorizationParams = z.object({ authorizationId: Id }).strict();
const AuthorizationBody = z
  .object({
    releaseId: Id,
    maximumReservationPaise: z.string().regex(/^[1-9][0-9]{0,59}$/),
    idempotencyKey: Id,
  })
  .strict();

export function registerProviderEvaluationAuthorizationRoutes(dependencies: Dependencies): void {
  const { app, requireRole, store } = dependencies;
  app.post('/v1/evaluation-provider-authorizations', async (request, reply) => {
    const principal = requireRole(request, 'admin');
    const authorizations = configuredAuthorizations(dependencies.evaluations, reply);
    if (!authorizations) return;
    const authorization = await authorizations.createForRelease({
      workspaceId: principal.workspaceId,
      createdBy: principal.identityId,
      ...AuthorizationBody.parse(request.body),
    });
    await audit(store, principal, 'evaluation.provider-authorization.create', authorization.id);
    return reply.code(201).send(authorization);
  });
  app.get('/v1/evaluation-provider-authorizations', async (request, reply) => {
    const principal = requireRole(request, 'admin');
    const authorizations = configuredAuthorizations(dependencies.evaluations, reply);
    if (!authorizations) return;
    const query = PageQuery.parse(request.query);
    return authorizations.list(principal.workspaceId, query.limit, query.cursor);
  });
  app.post(
    '/v1/evaluation-provider-authorizations/:authorizationId/revoke',
    async (request, reply) => {
      const principal = requireRole(request, 'admin');
      const authorizations = configuredAuthorizations(dependencies.evaluations, reply);
      if (!authorizations) return;
      const { authorizationId } = AuthorizationParams.parse(request.params);
      const authorization = await authorizations.revoke(
        principal.workspaceId,
        authorizationId,
        principal.identityId,
      );
      if (!authorization)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'Provider evaluation authorization not found' });
      await audit(store, principal, 'evaluation.provider-authorization.revoke', authorizationId);
      return authorization;
    },
  );
}

function configuredAuthorizations(
  service: PostgresEvaluationService | undefined,
  reply: { code(value: number): { send(value: unknown): unknown } },
) {
  if (service?.providerAuthorizations) return service.providerAuthorizations;
  reply.code(503).send({
    error: 'provider_evaluations_unavailable',
    message: 'Provider evaluations are not enabled for this installation',
  });
  return undefined;
}
