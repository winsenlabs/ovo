import type { FastifyReply } from 'fastify';
import { RecordingUnavailableError } from '@winsendotai/ovo-plugin-recordings';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { RecordingAudioRequestError } from './recording-lifecycle-audio.ts';
import type {
  ApiError,
  Principal,
  RecordingLifecycleRouteDependencies,
} from './recording-lifecycle.ts';

export function configured(
  dependencies: RecordingLifecycleRouteDependencies,
  reply: FastifyReply,
  error: ApiError,
) {
  if (dependencies.recordings) return dependencies.recordings;
  error(reply, 503, 'recordings_unavailable', 'Production recording lifecycle is not configured');
  return undefined;
}

export async function recordingResult(
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

export function notFound(reply: FastifyReply, error: ApiError) {
  return error(reply, 404, 'not_found', 'Call or recording not found');
}

export async function audit(
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
