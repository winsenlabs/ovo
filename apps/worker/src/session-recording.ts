import {
  LiveRecordingCapture,
  type LiveRecordingService,
} from '@winsendotai/ovo-plugin-recordings';
import type { WorkerMediaSession } from '@winsendotai/ovo-plugin-media';

type StartRecording = typeof LiveRecordingCapture.start;

export async function prepareSessionRecording(
  input: {
    enabled: boolean;
    service?: LiveRecordingService;
    media: WorkerMediaSession;
    workspaceId: string;
    callId: string;
    retentionDays: number;
  },
  start: StartRecording = LiveRecordingCapture.start,
): Promise<{ media: WorkerMediaSession | LiveRecordingCapture; capture?: LiveRecordingCapture }> {
  if (!input.enabled) return { media: input.media };
  if (!input.service) throw new Error('production live recording service is not composed');
  const capture = await start({
    service: input.service,
    media: input.media,
    workspaceId: input.workspaceId,
    callId: input.callId,
    retentionDays: input.retentionDays,
  });
  return { media: capture, capture };
}
