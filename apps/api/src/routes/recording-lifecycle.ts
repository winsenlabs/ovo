import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  RecordingUnavailableError,
  type LiveRecordingService,
  type RecordingExportService,
  type RecordingRetentionService,
  type RecordingTrack,
} from '@winsendotai/ovo-plugin-recordings';
import type { ControlStore, Role } from '@winsendotai/ovo-plugin-storage';
import { publicManifest, publicRecording, transcriptLine } from './recording-lifecycle-data.ts';
import { RecordingAudioRequestError, recordingWavResponse } from './recording-lifecycle-audio.ts';
import { registerRecordingExportRoutes } from './recording-lifecycle-exports.ts';
export { createRecordingExportInputLoader } from './recording-lifecycle-data.ts';

type ApiError = (reply: FastifyReply, status: number, code: string, message: string) => unknown;
type Principal = { identityId: string; workspaceId: string; role: Role };

export interface RecordingLifecycleServices {
  live: LiveRecordingService;
  retention: RecordingRetentionService;
  exports: RecordingExportService;
}

export interface RecordingLifecycleRouteDependencies {
  app: FastifyInstance;
  store: Pick<ControlStore, 'getCall' | 'listCallEvents' | 'audit'>;
  recordings?: RecordingLifecycleServices;
  requireRole(request: FastifyRequest, role: Role): Principal;
  error: ApiError;
}

const CallParams = z.object({ callId: z.uuid() }).strict();
const RecordingParams = z.object({ callId: z.uuid(), recordingId: z.uuid() }).strict();
const TrackParams = z
  .object({
    callId: z.uuid(),
    recordingId: z.uuid(),
    track: z.enum(['inbound', 'outbound']),
  })
  .strict();
const SegmentParams = z
  .object({
    callId: z.uuid(),
    recordingId: z.uuid(),
    track: z.enum(['inbound', 'outbound']),
    sequence: z.coerce.number().int().min(0).max(9_999),
  })
  .strict();
const LimitQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();
const PageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2_000).optional(),
  })
  .strict();
const SweepBody = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.object({ expiresAt: z.iso.datetime(), artifactId: z.uuid() }).strict().optional(),
  })
  .strict();

export function registerRecordingLifecycleRoutes(
  dependencies: RecordingLifecycleRouteDependencies,
): void {
  const { app, store, requireRole, error } = dependencies;
  registerRecordingExportRoutes(dependencies);

  app.get('/v1/calls/:callId/live-recordings', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const { callId } = CallParams.parse(request.params);
    if (!(await store.getCall(principal.workspaceId, callId))) return notFound(reply, error);
    const services = configured(dependencies, reply, error);
    if (!services) return;
    const query = LimitQuery.parse(request.query);
    return reply.send({
      items: (await services.live.list(principal.workspaceId, callId, query.limit)).map(
        publicRecording,
      ),
      nextCursor: null,
    });
  });

  app.get('/v1/calls/:callId/live-recordings/:recordingId/manifest', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const params = RecordingParams.parse(request.params);
    if (!(await store.getCall(principal.workspaceId, params.callId))) return notFound(reply, error);
    const services = configured(dependencies, reply, error);
    if (!services) return;
    return recordingResult(reply, error, async () =>
      publicManifest(
        await services.live.manifest(principal.workspaceId, params.callId, params.recordingId),
      ),
    );
  });

  app.get(
    '/v1/calls/:callId/live-recordings/:recordingId/segments/:track/:sequence/audio',
    async (request, reply) => {
      const principal = requireRole(request, 'viewer');
      const params = SegmentParams.parse(request.params);
      if (!(await store.getCall(principal.workspaceId, params.callId)))
        return notFound(reply, error);
      const services = configured(dependencies, reply, error);
      if (!services) return;
      return recordingResult(reply, error, async () => {
        const result = await services.live.readSegment(
          principal.workspaceId,
          params.callId,
          params.recordingId,
          params.track as RecordingTrack,
          params.sequence,
        );
        return reply
          .type('audio/x-mulaw;rate=8000;channels=1')
          .header('content-length', String(result.bytes.byteLength))
          .header('etag', `"${result.metadata.sha256}"`)
          .send(Buffer.from(result.bytes));
      });
    },
  );

  app.get('/v1/calls/:callId/live-recordings/:recordingId/audio/:track', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const params = TrackParams.parse(request.params);
    if (!(await store.getCall(principal.workspaceId, params.callId))) return notFound(reply, error);
    const services = configured(dependencies, reply, error);
    if (!services) return;
    return recordingResult(reply, error, async () => {
      const response = await recordingWavResponse(
        services.live,
        principal.workspaceId,
        params.callId,
        params.recordingId,
        params.track,
        request.headers.range,
      );
      const controller = new AbortController();
      const abort = () => controller.abort(new Error('Recording audio client disconnected'));
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      const body = (async function* () {
        try {
          yield* response.stream(controller.signal);
        } finally {
          request.raw.off('aborted', abort);
          reply.raw.off('close', abort);
        }
      })();
      for (const [name, value] of Object.entries(response.headers)) reply.header(name, value);
      return reply.code(response.statusCode).send(Readable.from(body));
    });
  });

  app.get('/v1/calls/:callId/live-recordings/:recordingId/alignment', async (request, reply) => {
    const principal = requireRole(request, 'viewer');
    const params = RecordingParams.parse(request.params);
    const call = await store.getCall(principal.workspaceId, params.callId);
    if (!call) return notFound(reply, error);
    const services = configured(dependencies, reply, error);
    if (!services) return;
    const query = PageQuery.parse(request.query);
    return recordingResult(reply, error, async () => {
      const [manifest, events] = await Promise.all([
        services.live.manifest(principal.workspaceId, params.callId, params.recordingId),
        store.listCallEvents(principal.workspaceId, params.callId, query.limit, query.cursor),
      ]);
      return reply.send({
        recordingId: params.recordingId,
        evidence: 'call-event-wall-clock-relative-to-call-start',
        precision: 'not-waveform-synchronized',
        humanHeard: false,
        segments: publicManifest(manifest).segments,
        playbackTimeline: manifest.timeline,
        transcript: events.items.flatMap((event) => transcriptLine(event, call.createdAt)),
        nextCursor: events.nextCursor,
      });
    });
  });

  app.delete('/v1/calls/:callId/live-recordings/:recordingId', async (request, reply) => {
    const principal = requireRole(request, 'editor');
    const params = RecordingParams.parse(request.params);
    if (!(await store.getCall(principal.workspaceId, params.callId))) return notFound(reply, error);
    const services = configured(dependencies, reply, error);
    if (!services) return;
    return recordingResult(reply, error, async () => {
      const tombstone = await services.live.delete(
        principal.workspaceId,
        params.callId,
        params.recordingId,
        'operator',
      );
      await audit(store, principal, 'recording.tombstone', params.recordingId, {
        callId: params.callId,
      });
      return reply.code(202).send(tombstone);
    });
  });

  app.post('/v1/recordings/retention/sweep', async (request, reply) => {
    const principal = requireRole(request, 'admin');
    const services = configured(dependencies, reply, error);
    if (!services) return;
    const body = SweepBody.parse(request.body ?? {});
    const result = await services.retention.sweep(body);
    await audit(store, principal, 'recording.retention.sweep', 'bounded-sweep', {
      limit: body.limit,
      examined: result.examined,
      tombstoned: result.tombstoned,
      cleaned: result.cleaned,
      failed: result.failed,
    });
    return reply.send(result);
  });
}

function configured(
  dependencies: RecordingLifecycleRouteDependencies,
  reply: FastifyReply,
  error: ApiError,
) {
  if (dependencies.recordings) return dependencies.recordings;
  error(reply, 503, 'recordings_unavailable', 'Production recording lifecycle is not configured');
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
    if (cause instanceof RecordingAudioRequestError) {
      if (cause.contentRange) reply.header('content-range', cause.contentRange);
      return error(reply, cause.statusCode, cause.code, cause.message);
    }
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
