import { CompareBody, RunBody, RunParams } from './evaluation-run-schemas.ts';
import { releaseEvaluationFingerprint } from '@winsendotai/ovo-plugin-evaluations';
import {
  PageQuery,
  configured,
  audit,
  type EvaluationDatasetRouteDependencies,
} from './evaluation-route-support.ts';

export function registerRunRoutes(dependencies: EvaluationDatasetRouteDependencies) {
  const { app, requireRole, store } = dependencies;
  app.post('/v1/evaluation-runs', async (request, reply) => {
    const principal = requireRole(request, 'editor');
    const service = configured(dependencies, reply);
    if (!service) return;
    const body = RunBody.parse(request.body),
      release = await store.getRelease(principal.workspaceId, body.releaseId);
    if (!release) return reply.code(404).send({ error: 'not_found', message: 'Release not found' });
    let fixtureBindingVersion = dependencies.fixtureBindingVersion;
    if (body.executorKind === 'provider') {
      const authorization = body.budgetAuthorizationId
        ? await service.providerAuthorizations?.get(body.budgetAuthorizationId)
        : undefined;
      if (!authorization || authorization.workspaceId !== principal.workspaceId)
        return reply.code(400).send({
          error: 'provider_authorization_required',
          message: 'Provider evaluation requires an active budget authorization',
        });
      if (
        body.providerBindingVersion &&
        body.providerBindingVersion !== authorization.bindingVersion
      )
        return reply.code(400).send({
          error: 'provider_authorization_mismatch',
          message: 'Provider binding version does not match the selected authorization',
        });
      fixtureBindingVersion = authorization.bindingVersion;
    }
    if (!fixtureBindingVersion)
      return reply.code(400).send({
        error: 'provider_authorization_required',
        message: 'Provider evaluation requires authorized binding and budget versions',
      });
    let run;
    try {
      run = await service.createRun({
        ...body,
        workspaceId: principal.workspaceId,
        releaseFingerprint: releaseEvaluationFingerprint(release),
        fixtureBindingVersion,
      });
    } catch (cause) {
      const refusal = cause as Error & { statusCode?: number; code?: string };
      if (body.executorKind !== 'provider' || !refusal.statusCode || refusal.statusCode >= 500)
        throw cause;
      return reply.code(refusal.statusCode).send({
        error: refusal.code ?? 'provider_evaluation_not_authorized',
        message: refusal.message,
      });
    }
    await audit(store, principal, 'evaluation.run.create', run.id);
    return reply.code(202).send(run);
  });
  app.get('/v1/evaluation-runs', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const service = configured(dependencies, reply);
    if (!service) return;
    const query = PageQuery.parse(request.query);
    return service.runs.list(principal.workspaceId, query.limit, query.cursor);
  });
  app.get('/v1/evaluation-runs/:runId', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const service = configured(dependencies, reply);
    if (!service) return;
    const { runId } = RunParams.parse(request.params),
      run = await service.runs.get(principal.workspaceId, runId);
    return run ?? reply.code(404).send({ error: 'not_found', message: 'Evaluation run not found' });
  });
  app.get('/v1/evaluation-runs/:runId/cases', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const service = configured(dependencies, reply);
    if (!service) return;
    const { runId } = RunParams.parse(request.params),
      query = PageQuery.parse(request.query);
    if (!(await service.runs.get(principal.workspaceId, runId)))
      return reply.code(404).send({ error: 'not_found', message: 'Evaluation run not found' });
    return service.runs.listResults(principal.workspaceId, runId, query.limit, query.cursor);
  });
  app.post('/v1/evaluation-runs/:runId/cancel', async (request, reply) => {
    const principal = requireRole(request, 'editor');
    const service = configured(dependencies, reply);
    if (!service) return;
    const { runId } = RunParams.parse(request.params),
      run = await service.runs.cancel(principal.workspaceId, runId);
    if (!run)
      return reply.code(404).send({ error: 'not_found', message: 'Evaluation run not found' });
    await audit(store, principal, 'evaluation.run.cancel', runId);
    return run;
  });
  app.post('/v1/evaluation-runs/compare', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const service = configured(dependencies, reply);
    if (!service) return;
    const body = CompareBody.parse(request.body);
    return service.runs.compare(principal.workspaceId, body.baselineRunId, body.candidateRunId);
  });
}
