import { z } from 'zod';
import { safeReplayPayload } from '@winsendotai/ovo-plugin-recordings';
import type { RecordingLifecycleRouteDependencies } from './recording-lifecycle.ts';
import { publicExport } from './recording-lifecycle-data.ts';
import { RecordingParams } from './recording-lifecycle-schemas.ts';
import { audit, configured, notFound, recordingResult } from './recording-lifecycle-support.ts';

const ExportParams = z
  .object({ callId: z.uuid(), recordingId: z.uuid(), exportId: z.uuid() })
  .strict();
const ExportBody = z.object({ idempotencyKey: z.string().min(1).max(200) }).strict();

export function registerRecordingExportRoutes(
  dependencies: RecordingLifecycleRouteDependencies,
): void {
  const { app, store, requireRole, error } = dependencies;

  app.post('/v1/calls/:callId/live-recordings/:recordingId/exports', async (request, reply) => {
    const principal = requireRole(request, 'editor');
    const params = RecordingParams.parse(request.params);
    if (!(await store.getCall(principal.workspaceId, params.callId))) return notFound(reply, error);
    const services = configured(dependencies, reply, error);
    if (!services) return;
    const body = ExportBody.parse(request.body);
    return recordingResult(reply, error, async () => {
      await services.live.manifest(principal.workspaceId, params.callId, params.recordingId);
      const job = await services.exports.request({
        workspaceId: principal.workspaceId,
        artifactId: params.recordingId,
        idempotencyKey: body.idempotencyKey,
      });
      await audit(store, principal, 'recording.export.request', job.id, {
        callId: params.callId,
        recordingId: params.recordingId,
      });
      return reply.code(202).send(publicExport(job));
    });
  });

  app.get(
    '/v1/calls/:callId/live-recordings/:recordingId/exports/:exportId',
    async (request, reply) => {
      const principal = requireRole(request, 'viewer');
      const params = ExportParams.parse(request.params);
      if (!(await store.getCall(principal.workspaceId, params.callId)))
        return notFound(reply, error);
      const services = configured(dependencies, reply, error);
      if (!services) return;
      return recordingResult(reply, error, async () => {
        await services.live.manifest(principal.workspaceId, params.callId, params.recordingId);
        const job = await services.exports.status(principal.workspaceId, params.exportId);
        if (!job || job.artifactId !== params.recordingId) return notFound(reply, error);
        return reply.send(publicExport(job));
      });
    },
  );

  app.get(
    '/v1/calls/:callId/live-recordings/:recordingId/exports/:exportId/download',
    async (request, reply) => {
      const principal = requireRole(request, 'viewer');
      const params = ExportParams.parse(request.params);
      if (!(await store.getCall(principal.workspaceId, params.callId)))
        return notFound(reply, error);
      const services = configured(dependencies, reply, error);
      if (!services) return;
      return recordingResult(reply, error, async () => {
        await services.live.manifest(principal.workspaceId, params.callId, params.recordingId);
        const job = await services.exports.status(principal.workspaceId, params.exportId);
        if (!job || job.artifactId !== params.recordingId) return notFound(reply, error);
        const result = await services.exports.read(principal.workspaceId, params.exportId);
        return reply
          .type('application/json')
          .header('content-length', String(result.bytes.byteLength))
          .header(
            'content-disposition',
            `attachment; filename="recording-export-${params.exportId}.json"`,
          )
          .send(Buffer.from(result.bytes));
      });
    },
  );

  app.get('/v1/calls/:callId/live-recordings/:recordingId/replay', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const params = RecordingParams.parse(request.params);
    if (!(await store.getCall(principal.workspaceId, params.callId))) return notFound(reply, error);
    const services = configured(dependencies, reply, error);
    if (!services) return;
    return recordingResult(reply, error, async () => {
      await services.live.manifest(principal.workspaceId, params.callId, params.recordingId);
      return reply.send({
        ...safeReplayPayload(params.recordingId),
        requiredEffects: {
          transport: 'synthetic',
          tools: 'stubbed',
          liveConnectors: false,
          productionWrites: false,
        },
      });
    });
  });
}
