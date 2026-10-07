import type { AudioFormat, VoiceMediaTransport } from '@winsendotai/ovo-contracts';
import type { RecordingTrack } from './types.ts';

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
