import { z } from 'zod';
import {
  PageQuery,
  configured,
  audit,
  type EvaluationDatasetRouteDependencies,
} from './evaluation-route-support.ts';
import { registerRunRoutes } from './evaluation-run-routes.ts';
import { DatasetParams, ImportBody, VersionParams } from './evaluation-run-schemas.ts';
import { decodeCursor, encodeCursor, pageLimit } from '@winsendotai/ovo-plugin-evaluations';
import { registerProviderEvaluationAuthorizationRoutes } from './evaluation-provider-authorizations.ts';

const DatasetBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).default(''),
  })
  .strict();
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
  registerProviderEvaluationAuthorizationRoutes(dependencies);
  registerRunRoutes(dependencies);
}
