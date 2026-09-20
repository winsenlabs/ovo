import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  decodeCursor,
  encodeCursor,
  pageLimit,
  releaseEvaluationFingerprint,
  type PostgresEvaluationService,
} from '@winsendotai/ovo-plugin-evaluations';
import type { ControlStore, Role } from '@winsendotai/ovo-plugin-storage';

interface Principal {
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

const Id = z.string().trim().min(1).max(200);
const PageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2_000).optional(),
  })
  .strict();
const DatasetBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).default(''),
  })
  .strict();
const DatasetParams = z.object({ datasetId: Id }).strict();
const VersionParams = z
  .object({ datasetId: Id, version: z.coerce.number().int().positive() })
  .strict();
const RunParams = z.object({ runId: Id }).strict();
const ImportBody = z.object({ cases: z.array(z.unknown()).min(1).max(1_000) }).strict();
const RunBody = z
  .object({
    datasetId: Id,
    datasetVersion: z.number().int().positive(),
    releaseId: Id,
    idempotencyKey: Id,
    maxAttempts: z.number().int().min(1).max(5).default(3),
    executorKind: z.enum(['fixture', 'provider']).default('fixture'),
    providerBindingVersion: Id.optional(),
    budgetAuthorizationId: Id.optional(),
  })
  .strict();
const CompareBody = z.object({ baselineRunId: Id, candidateRunId: Id }).strict();

export function registerEvaluationDatasetRoutes(
  dependencies: EvaluationDatasetRouteDependencies,
): void {
  const { app, requireRole, store } = dependencies;
  app.post('/v1/evaluation-datasets', async (request, reply) => {
    const principal = requireRole(request, 'editor'),
      service = configured(dependencies, reply);
    if (!service) return;
    const dataset = await service.datasets.create({
      workspaceId: principal.workspaceId,
      ...DatasetBody.parse(request.body),
    });
    await audit(store, principal, 'evaluation.dataset.create', dataset.id);
    return reply.code(201).send(dataset);
  });
  app.get('/v1/evaluation-datasets', async (request, reply) => {
    const principal = requireRole(request, 'viewer'),
      service = configured(dependencies, reply);
    if (!service) return;
    const query = PageQuery.parse(request.query);
    return service.datasets.list(principal.workspaceId, query.limit, query.cursor);
  });
  app.get('/v1/evaluation-datasets/:datasetId', async (request, reply) => {
    const principal = requireRole(request, 'viewer'),
      service = configured(dependencies, reply);
    if (!service) return;
    const { datasetId } = DatasetParams.parse(request.params),
      item = await service.datasets.get(principal.workspaceId, datasetId);
    return (
      item ?? reply.code(404).send({ error: 'not_found', message: 'Evaluation dataset not found' })
    );
  });
  app.patch('/v1/evaluation-datasets/:datasetId', async (request, reply) => {
    const principal = requireRole(request, 'editor'),
      service = configured(dependencies, reply);
    if (!service) return;
    const { datasetId } = DatasetParams.parse(request.params),
      item = await service.datasets.update(
        principal.workspaceId,
        datasetId,
        DatasetBody.parse(request.body),
      );
    if (!item)
      return reply.code(404).send({ error: 'not_found', message: 'Evaluation dataset not found' });
    await audit(store, principal, 'evaluation.dataset.update', datasetId);
    return item;
  });
  app.delete('/v1/evaluation-datasets/:datasetId', async (request, reply) => {
    const principal = requireRole(request, 'admin'),
      service = configured(dependencies, reply);
    if (!service) return;
    const { datasetId } = DatasetParams.parse(request.params);
    if (!(await service.datasets.archive(principal.workspaceId, datasetId)))
      return reply.code(404).send({ error: 'not_found', message: 'Evaluation dataset not found' });
    await audit(store, principal, 'evaluation.dataset.archive', datasetId);
    return reply.code(204).send();
  });
  app.post('/v1/evaluation-datasets/:datasetId/versions', async (request, reply) => {
    const principal = requireRole(request, 'editor'),
      service = configured(dependencies, reply);
    if (!service) return;
    const { datasetId } = DatasetParams.parse(request.params),
      body = ImportBody.parse(request.body);
    const version = await service.datasets.importVersion({
      workspaceId: principal.workspaceId,
      datasetId,
      cases: body.cases,
      createdBy: principal.identityId,
    });
    await audit(
      store,
      principal,
      'evaluation.dataset.version.import',
      `${datasetId}:${version.version}`,
    );
    return reply.code(201).send(version);
  });
  app.get('/v1/evaluation-datasets/:datasetId/versions', async (request, reply) => {
    const principal = requireRole(request, 'viewer'),
      service = configured(dependencies, reply);
    if (!service) return;
    const { datasetId } = DatasetParams.parse(request.params),
      query = PageQuery.parse(request.query);
    return service.datasets.listVersions(
      principal.workspaceId,
      datasetId,
      query.limit,
      query.cursor,
    );
  });
  app.get('/v1/evaluation-datasets/:datasetId/versions/:version', async (request, reply) => {
    const principal = requireRole(request, 'viewer'),
      service = configured(dependencies, reply);
    if (!service) return;
    const params = VersionParams.parse(request.params),
      version = await service.datasets.getVersion(
        principal.workspaceId,
        params.datasetId,
        params.version,
      );
    return (
      version ??
      reply.code(404).send({ error: 'not_found', message: 'Evaluation dataset version not found' })
    );
  });
  app.get('/v1/evaluation-datasets/:datasetId/versions/:version/cases', async (request, reply) => {
    const principal = requireRole(request, 'viewer'),
      service = configured(dependencies, reply);
    if (!service) return;
    const params = VersionParams.parse(request.params),
      query = PageQuery.parse(request.query);
    const version = await service.datasets.getVersion(
      principal.workspaceId,
      params.datasetId,
      params.version,
    );
    if (!version)
      return reply
        .code(404)
        .send({ error: 'not_found', message: 'Evaluation dataset version not found' });
    const start = Number(decodeCursor(query.cursor) || 0),
      limit = pageLimit(query.limit);
    if (!Number.isInteger(start) || start < 0 || start > version.cases.length)
      return reply.code(400).send({ error: 'invalid_cursor', message: 'Invalid cursor' });
    const items = version.cases.slice(start, start + limit),
      next = start + items.length;
    return {
      items,
      nextCursor: next < version.cases.length ? encodeCursor(String(next)) : undefined,
    };
  });
  registerRunRoutes(dependencies);
}

function registerRunRoutes(dependencies: EvaluationDatasetRouteDependencies) {
  const { app, requireRole, store } = dependencies;
  app.post('/v1/evaluation-runs', async (request, reply) => {
    const principal = requireRole(request, 'editor'),
      service = configured(dependencies, reply);
    if (!service) return;
    const body = RunBody.parse(request.body),
      release = await store.getRelease(principal.workspaceId, body.releaseId);
    if (!release) return reply.code(404).send({ error: 'not_found', message: 'Release not found' });
    const fixtureBindingVersion =
      body.executorKind === 'fixture'
        ? dependencies.fixtureBindingVersion
        : body.providerBindingVersion;
    if (!fixtureBindingVersion || (body.executorKind === 'provider' && !body.budgetAuthorizationId))
      return reply.code(400).send({
        error: 'provider_authorization_required',
        message: 'Provider evaluation requires authorized binding and budget versions',
      });
    const run = await service.createRun({
      ...body,
      workspaceId: principal.workspaceId,
      releaseFingerprint: releaseEvaluationFingerprint(release),
      fixtureBindingVersion,
    });
    await audit(store, principal, 'evaluation.run.create', run.id);
    return reply.code(202).send(run);
  });
  app.get('/v1/evaluation-runs', async (request, reply) => {
    const principal = requireRole(request, 'viewer'),
      service = configured(dependencies, reply);
    if (!service) return;
    const query = PageQuery.parse(request.query);
    return service.runs.list(principal.workspaceId, query.limit, query.cursor);
  });
  app.get('/v1/evaluation-runs/:runId', async (request, reply) => {
    const principal = requireRole(request, 'viewer'),
      service = configured(dependencies, reply);
    if (!service) return;
    const { runId } = RunParams.parse(request.params),
      run = await service.runs.get(principal.workspaceId, runId);
    return run ?? reply.code(404).send({ error: 'not_found', message: 'Evaluation run not found' });
  });
  app.get('/v1/evaluation-runs/:runId/cases', async (request, reply) => {
    const principal = requireRole(request, 'viewer'),
      service = configured(dependencies, reply);
    if (!service) return;
    const { runId } = RunParams.parse(request.params),
      query = PageQuery.parse(request.query);
    if (!(await service.runs.get(principal.workspaceId, runId)))
      return reply.code(404).send({ error: 'not_found', message: 'Evaluation run not found' });
    return service.runs.listResults(principal.workspaceId, runId, query.limit, query.cursor);
  });
  app.post('/v1/evaluation-runs/:runId/cancel', async (request, reply) => {
    const principal = requireRole(request, 'editor'),
      service = configured(dependencies, reply);
    if (!service) return;
    const { runId } = RunParams.parse(request.params),
      run = await service.runs.cancel(principal.workspaceId, runId);
    if (!run)
      return reply.code(404).send({ error: 'not_found', message: 'Evaluation run not found' });
    await audit(store, principal, 'evaluation.run.cancel', runId);
    return run;
  });
  app.post('/v1/evaluation-runs/compare', async (request, reply) => {
    const principal = requireRole(request, 'viewer'),
      service = configured(dependencies, reply);
    if (!service) return;
    const body = CompareBody.parse(request.body);
    return service.runs.compare(principal.workspaceId, body.baselineRunId, body.candidateRunId);
  });
}

function configured(
  dependencies: EvaluationDatasetRouteDependencies,
  reply: { code(value: number): { send(value: unknown): unknown } },
) {
  if (dependencies.evaluations) return dependencies.evaluations;
  reply
    .code(503)
    .send({ error: 'evaluations_unavailable', message: 'Evaluation service is not configured' });
  return undefined;
}
async function audit(
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
