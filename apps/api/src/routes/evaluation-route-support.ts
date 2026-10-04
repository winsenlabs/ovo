export { PageQuery } from './route-page-schema.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PostgresEvaluationService } from '@winsendotai/ovo-plugin-evaluations';
import type { ControlStore, Role } from '@winsendotai/ovo-plugin-storage';

export interface Principal {
  identityId: string;
  workspaceId: string;
  role: Role;
}
export interface EvaluationDatasetRouteDependencies {
  app: FastifyInstance;
  evaluations?: PostgresEvaluationService;
  store: Pick<ControlStore, 'getRelease' | 'audit'>;
  fixtureBindingVersion: string;
  requireRole(request: FastifyRequest, role: Role): Principal;
}

export function configured(
  dependencies: EvaluationDatasetRouteDependencies,
  reply: { code(value: number): { send(value: unknown): unknown } },
) {
  if (dependencies.evaluations) return dependencies.evaluations;
  reply
    .code(503)
    .send({ error: 'evaluations_unavailable', message: 'Evaluation service is not configured' });
  return undefined;
}
export async function audit(
  store: Pick<ControlStore, 'audit'>,
  principal: Principal,
  action: string,
  resourceId: string,
) {
  await store.audit({
    workspaceId: principal.workspaceId,
    actorId: principal.identityId,
    action,
    resourceType: 'evaluation',
    resourceId,
    payload: {},
  });
}
