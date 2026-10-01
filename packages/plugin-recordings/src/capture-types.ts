import type { AudioFormat, VoiceMediaTransport } from '@winsendotai/ovo-contracts';

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
