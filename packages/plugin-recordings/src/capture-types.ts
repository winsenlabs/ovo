import { MULAW_8K, type AudioFormat, type VoiceMediaTransport } from '@winsendotai/ovo-contracts';
import type { LiveRecording, RecordingTimelineEvent, RecordingTrack } from './types.ts';

/** One track's audio not yet written as a segment. */
export interface PendingTrack {
  bytes: Uint8Array[];
  byteLength: number;
  sequence: number;
  startMs?: number;
  endMs?: number;
}

/** What a capture's artifact holds: `partial` when audio was lost on the way. */
export interface CaptureOutcome {
  state: 'available' | 'partial';
  /** Bytes per track durably written as available segments. */
  bytes: Readonly<Record<RecordingTrack, number>>;
}

/** What a call's evidence says about its recording: started, then what the artifact holds. */
export type CaptureStatus =
  | { state: 'recording'; artifactId: string; expiresAt: string }
  | {
      state: CaptureOutcome['state'];
      artifactId: string;
      inboundBytes: number;
      outboundBytes: number;
    };

export function startedStatus(recording: LiveRecording): CaptureStatus {
  return { state: 'recording', artifactId: recording.id, expiresAt: recording.expiresAt };
}

export function settledStatus(artifactId: string, outcome: CaptureOutcome): CaptureStatus {
  const { inbound, outbound } = outcome.bytes;
  return { state: outcome.state, artifactId, inboundBytes: inbound, outboundBytes: outbound };
}

/** The track's buffered audio as one segment, leaving the buffer empty for the next. */
export function takeSegment(track: PendingTrack): {
  bytes: Uint8Array;
  startMs: number;
  endMs: number;
} {
  const bytes = new Uint8Array(track.byteLength);
  let cursor = 0;
  for (const chunk of track.bytes) {
    bytes.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  const startMs = track.startMs ?? 0;
  const endMs = track.endMs ?? startMs;
  track.bytes = [];
  track.byteLength = 0;
  track.startMs = undefined;
  track.endMs = undefined;
  return { bytes, startMs, endMs };
}

export function captureError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Recording capture failed').slice(0, 500);
}

/** The format `media` is recorded in; throws for media a capture cannot record. */
export function recordingFormat(media: RecordingMediaTransport): AudioFormat {
  const format = media.format ?? MULAW_8K;
  if (!supportedRecordingFormat(format))
    throw new Error('Live recording requires μ-law 8 kHz or PCM16 8/16 kHz media');
  if (
    media.codec !== (format.encoding === 'mulaw' ? 'audio/x-mulaw' : 'audio/pcm') ||
    media.sampleRate !== format.sampleRate
  )
    throw new Error('Live recording media format and codec disagree');
  return format;
}

export function schedulerEvidence(
  evidence: 'generated' | 'simulated' | 'estimated' | 'confirmed',
): RecordingTimelineEvent['evidence'] {
  if (evidence === 'confirmed') return 'scheduler-confirmed';
  return evidence === 'estimated' ? 'scheduler-estimated' : 'scheduler-generated';
}

export function supportedRecordingFormat(format: AudioFormat): boolean {
  return (
    format.channels === 1 &&
    ((format.encoding === 'mulaw' && format.sampleRate === 8_000) ||
      (format.encoding === 'pcm_s16le' &&
        (format.sampleRate === 8_000 || format.sampleRate === 16_000)))
  );
}

export function recordingBytesPerSecond(format: AudioFormat): number {
  return format.sampleRate * (format.encoding === 'pcm_s16le' ? 2 : 1);
}

export interface RecordingMediaTransport extends VoiceMediaTransport {
  readonly identity?: unknown;
  readonly format?: AudioFormat;
  readonly codec: 'audio/x-mulaw' | 'audio/pcm';
  readonly sampleRate: 8000 | 16000;
}

export interface PlaybackEvidenceSource {
  subscribe(
    listener: (event: {
      segmentId: string;
      phase: string;
      at: number;
      evidence: 'generated' | 'simulated' | 'estimated' | 'confirmed';
    }) => void,
  ): () => void;
}
