import {
  LiveRecordingCapture,
  type LiveRecordingService,
} from '@winsendotai/ovo-plugin-recordings';
import type { WorkerMediaSession } from '@winsendotai/ovo-plugin-media';
import type { VoiceSessionEngine } from '@winsendotai/ovo-contracts';
import { attachRecordingEvidence } from './recording-evidence.ts';

type StartRecording = typeof LiveRecordingCapture.start;
type Audit = (type: string, payload: Record<string, unknown>) => void;

/**
 * Live segments are written as they fill. A worker that exits mid-call loses at most this much
 * audio per track (about 33 s of 8 kHz mu-law); the default 5 MiB held a whole call in memory.
 */
export const LIVE_RECORDING_SEGMENT_BYTES = 256 * 1024;

export interface SessionRecording {
  media: WorkerMediaSession | LiveRecordingCapture;
  capture?: LiveRecordingCapture;
  /** Flushes the capture and records what the artifact holds; a no-op for an unrecorded call. */
  finish(): Promise<void>;
  /** Puts the engine's playback evidence on the recording's timeline; returns the detach. */
  attachEvidence(engine: Pick<VoiceSessionEngine, 'subscribe'>): () => void;
}

/**
 * Starts the call's recording when its release has `recording: true`. Every call's evidence says
 * whether it was recorded (`recording.status`): a live call that should have been recorded and
 * was not is visible without reading the release.
 *
 * A recording store that cannot start one (database or object store down) does not fail the call:
 * the caller is still answered, unrecorded, and the evidence says why. A worker composed without
 * the recording service is a deployment error and still refuses the call.
 */
export async function prepareSessionRecording(
  input: {
    enabled: boolean;
    service?: LiveRecordingService;
    media: WorkerMediaSession;
    workspaceId: string;
    callId: string;
    retentionDays: number;
    audit?: Audit;
  },
  start: StartRecording = LiveRecordingCapture.start,
): Promise<SessionRecording> {
  const audit: Audit = input.audit ?? (() => undefined);
  const unrecorded = {
    media: input.media,
    finish: async () => undefined,
    attachEvidence: () => () => undefined,
  };
  if (!input.enabled) {
    audit('recording.status', { state: 'off' });
    return unrecorded;
  }
  if (!input.service) throw new Error('production live recording service is not composed');
  let capture: LiveRecordingCapture;
  try {
    capture = await start({
      service: input.service,
      media: input.media,
      workspaceId: input.workspaceId,
      callId: input.callId,
      retentionDays: input.retentionDays,
      segmentBytes: LIVE_RECORDING_SEGMENT_BYTES,
    });
  } catch (error) {
    audit('recording.status', { state: 'unavailable', error: safeError(error) });
    return unrecorded;
  }
  const { id: artifactId, expiresAt } = capture.artifact;
  audit('recording.status', { state: 'recording', artifactId, expiresAt });
  return {
    media: capture,
    capture,
    attachEvidence: (engine) => attachRecordingEvidence(capture, engine),
    finish: async () => {
      await capture.finish();
      const { state, bytes } = capture.outcome;
      audit('recording.status', {
        state,
        artifactId,
        inboundBytes: bytes.inbound,
        outboundBytes: bytes.outbound,
      });
    },
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : 'Error').slice(0, 300);
}
