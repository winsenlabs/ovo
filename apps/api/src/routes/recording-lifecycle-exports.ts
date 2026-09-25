import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RecordingUnavailableError, safeReplayPayload } from '@winsendotai/ovo-plugin-recordings';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { RecordingLifecycleRouteDependencies } from './recording-lifecycle.ts';
import { publicExport } from './recording-lifecycle-data.ts';

const RecordingParams = z.object({ callId: z.uuid(), recordingId: z.uuid() }).strict();
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
    const services = configured(dependencies, reply);
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
      const services = configured(dependencies, reply);
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
      const services = configured(dependencies, reply);
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
    const services = configured(dependencies, reply);
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

type ApiError = RecordingLifecycleRouteDependencies['error'];
type Principal = ReturnType<RecordingLifecycleRouteDependencies['requireRole']>;

function configured(dependencies: RecordingLifecycleRouteDependencies, reply: FastifyReply) {
  if (dependencies.recordings) return dependencies.recordings;
  dependencies.error(
    reply,
    503,
    'recordings_unavailable',
    'Production recording lifecycle is not configured',
  );
  return undefined;
}

async function recordingResult(
  reply: FastifyReply,
  error: ApiError,
  action: () => Promise<unknown>,
) {
  try {
    return await action();
  } catch (cause) {
    if (cause instanceof RecordingUnavailableError)
      return error(reply, 404, 'recording_not_found', 'Recording not found');
    if (cause instanceof Error && cause.message.includes('integrity'))
      return error(reply, 409, 'recording_integrity_failed', 'Recording integrity check failed');
    if (cause instanceof Error && cause.message === 'Recording export is unavailable')
      return error(reply, 409, 'recording_export_unavailable', cause.message);
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return error(reply, 404, 'recording_not_found', 'Recording not found');
    throw cause;
  }
}

function notFound(reply: FastifyReply, error: ApiError) {
  return error(reply, 404, 'not_found', 'Call or recording not found');
}

async function audit(
  store: Pick<ControlStore, 'audit'>,
  principal: Principal,
  action: string,
  resourceId: string,
  payload: Record<string, unknown>,
) {
  await store.audit({
    workspaceId: principal.workspaceId,
    actorId: principal.identityId,
    action,
    resourceType: 'recording',
    resourceId,
    payload,
  });
}
