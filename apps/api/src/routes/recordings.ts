import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RecordingArchive } from '@winsendotai/ovo-plugin-recordings';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { Principal } from '../types.ts';

const MAX_BASE64_WAV_LENGTH = 6_990_508;
const RECORDING_UPLOAD_BODY_LIMIT = 7 * 1024 * 1024;

type ApiError = (reply: FastifyReply, status: number, code: string, message: string) => unknown;

function archiveError(reply: FastifyReply, error: unknown, sendError: ApiError) {
  if (error instanceof Error && error.message === 'Recording expired')
    return sendError(reply, 410, 'recording_expired', 'Recording expired');
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const name = error instanceof Error ? error.name : '';
  if (code === 'ENOENT' || name === 'NoSuchKey' || name === 'NotFound')
    return sendError(reply, 404, 'recording_not_found', 'Recording not found');
  throw error;
}

export function registerRecordingRoutes(input: {
  app: FastifyInstance;
  store: ControlStore;
  recordings?: RecordingArchive;
  requireRole: (request: FastifyRequest, role: 'viewer' | 'editor') => Principal;
  error: ApiError;
}) {
  const { app, store, recordings, requireRole, error } = input;
  const params = z.object({ callId: z.uuid(), recordingId: z.uuid().optional() });

  app.get('/v1/calls/:callId/recordings', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer');
    const { callId } = params.parse(request.params);
    if (!(await store.getCall(principal.workspaceId, callId)))
      return error(reply, 404, 'not_found', 'Call not found');
    if (!recordings)
      return error(
        reply,
        503,
        'recordings_unavailable',
        'Fixture recording storage is not configured',
      );
    return { items: await recordings.list(principal.workspaceId, callId), nextCursor: null };
  });

  app.get(
    '/v1/calls/:callId/recordings/:recordingId/audio',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'viewer');
      const { callId, recordingId } = params.parse(request.params);
      if (!(await store.getCall(principal.workspaceId, callId)))
        return error(reply, 404, 'not_found', 'Call not found');
      if (!recordings)
        return error(
          reply,
          503,
          'recordings_unavailable',
          'Fixture recording storage is not configured',
        );
      try {
        const result = await recordings.read(principal.workspaceId, callId, recordingId!);
        return reply
          .type('audio/wav')
          .header('content-length', String(result.wav.byteLength))
          .send(Buffer.from(result.wav));
      } catch (cause) {
        return archiveError(reply, cause, error);
      }
    },
  );

  app.post(
    '/v1/calls/:callId/recordings',
    { bodyLimit: RECORDING_UPLOAD_BODY_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'editor');
      const { callId } = params.parse(request.params);
      const call = await store.getCall(principal.workspaceId, callId);
      if (!call) return error(reply, 404, 'not_found', 'Call not found');
      if (!recordings)
        return error(
          reply,
          503,
          'recordings_unavailable',
          'Fixture recording storage is not configured',
        );
      if (call.kind !== 'simulation')
        return error(
          reply,
          403,
          'fixture_only',
          'Recordings may be uploaded only to simulation calls',
        );
      const body = z
        .object({
          wavBase64: z.string().min(1).max(MAX_BASE64_WAV_LENGTH),
          retentionDays: z.number().int().min(1).max(365).default(30),
        })
        .parse(request.body);
      const wav = Buffer.from(body.wavBase64, 'base64');
      if (
        !wav.length ||
        wav.toString('base64').replace(/=+$/, '') !== body.wavBase64.replace(/=+$/, '')
      )
        return error(reply, 400, 'invalid_wav_base64', 'Invalid base64 WAV');
      const recording = await recordings.put({
        workspaceId: principal.workspaceId,
        callId,
        wav,
        retentionDays: body.retentionDays,
        source: 'fixture',
      });
      return reply.code(201).send(recording);
    },
  );
}
