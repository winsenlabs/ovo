import type { RecordingTrackSegment } from './production-track-player';
export type LiveRecording = {
  id: string;
  state:
    | 'starting'
    | 'active'
    | 'paused'
    | 'finalizing'
    | 'available'
    | 'partial'
    | 'failed'
    | 'expired';
  source: 'carrier';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  codec: 'audio/x-mulaw';
  sampleRate: 8000;
  channels: 2;
  segmentBytes: number;
};
export type Segment = RecordingTrackSegment & {
  timestampEvidence?: string;
  sha256?: string;
};
export type Manifest = LiveRecording & { segments: Segment[]; timeline?: unknown };
export type DetailState = { manifest: Manifest; alignment: unknown };
