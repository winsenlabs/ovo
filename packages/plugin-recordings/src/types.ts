export type RecordingState =
  'starting' | 'active' | 'paused' | 'finalizing' | 'available' | 'partial' | 'failed' | 'expired';

export type RecordingTrack = 'inbound' | 'outbound';

export interface LiveRecording {
  id: string;
  workspaceId: string;
  callId: string;
  source: 'carrier';
  state: RecordingState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  codec: 'audio/x-mulaw';
  sampleRate: 8000;
  channels: 2;
  segmentBytes: number;
  failure?: string;
}

export interface RecordingSegment {
  artifactId: string;
  track: RecordingTrack;
  sequence: number;
  state: 'available' | 'failed';
  objectKey?: string;
  sha256?: string;
  bytes: number;
  startMs: number;
  endMs: number;
  timestampEvidence: 'provider-media-timestamp' | 'worker-send-resolved';
  error?: string;
}

export interface RecordingTimelineEvent {
  artifactId: string;
  sequence: number;
  atMs: number;
  type: 'playback-sent' | 'playback-mark-confirmed' | 'speech-evidence';
  evidence:
    | 'worker-send-resolved'
    | 'carrier-mark-confirmed-not-human-heard'
    | 'scheduler-generated'
    | 'scheduler-estimated'
    | 'scheduler-confirmed';
  reference: string;
  phase?: string;
}

export interface RecordingManifest extends LiveRecording {
  segments: RecordingSegment[];
  timeline: RecordingTimelineEvent[];
}

export interface RecordingTombstone {
  artifactId: string;
  workspaceId: string;
  callId: string;
  requestedAt: string;
  reason: 'retention' | 'operator';
  cleanupState: 'pending' | 'complete' | 'failed';
  attempts: number;
  lastError?: string;
  completedAt?: string;
}

export interface RetentionCursor {
  expiresAt: string;
  artifactId: string;
}

export interface RetentionPage {
  items: LiveRecording[];
  nextCursor?: RetentionCursor;
}

export type ExportState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RecordingExportJob {
  id: string;
  workspaceId: string;
  artifactId: string;
  idempotencyKey: string;
  state: ExportState;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  leaseOwner?: string;
  leaseEpoch: number;
  leaseExpiresAt?: string;
  outputKey?: string;
  outputSha256?: string;
  outputBytes?: number;
  error?: string;
}

export interface RedactedExportInput {
  transcript: Array<{
    speaker: 'customer' | 'agent';
    text: string;
    startMs?: number;
    endMs?: number;
    playback?: 'confirmed' | 'estimated' | 'unplayed';
  }>;
  events: Array<{ atMs: number; type: string; payload?: unknown }>;
}

export interface ExportRedactionPolicy {
  replacement?: string;
  redactPatterns?: string[];
  includeUnplayedAgentText?: boolean;
}
