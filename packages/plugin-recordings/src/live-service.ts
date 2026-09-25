import { createHash, randomUUID } from 'node:crypto';
import type { ObjectBackend } from './backend.ts';
import type { RecordingRepository } from './repository.ts';
import { RecordingUnavailableError } from './repository.ts';
import type {
  LiveRecording,
  RecordingManifest,
  RecordingSegment,
  RecordingTimelineEvent,
  RecordingTrack,
} from './types.ts';

const SEGMENT = /^[a-zA-Z0-9_-]{1,100}$/;

export interface CreateLiveRecording {
  workspaceId: string;
  callId: string;
  retentionDays: number;
  segmentBytes?: number;
}

export class LiveRecordingService {
  constructor(
    readonly repository: RecordingRepository,
    readonly objects: ObjectBackend,
    private readonly clock: () => number = Date.now,
  ) {}

  now(): number {
    return this.clock();
  }

  async create(input: CreateLiveRecording): Promise<LiveRecording> {
    validateSegment(input.workspaceId, 'workspaceId');
    validateSegment(input.callId, 'callId');
    if (
      !Number.isInteger(input.retentionDays) ||
      input.retentionDays < 1 ||
      input.retentionDays > 365
    )
      throw new Error('Retention days must be from 1 to 365');
    const segmentBytes = input.segmentBytes ?? 5 * 1024 * 1024;
    if (
      !Number.isInteger(segmentBytes) ||
      segmentBytes < 64 * 1024 ||
      segmentBytes > 8 * 1024 * 1024
    )
      throw new Error('Segment bytes must be from 64 KiB to 8 MiB');
    const at = this.clock();
    const recording: LiveRecording = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      callId: input.callId,
      source: 'carrier',
      state: 'starting',
      createdAt: new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + input.retentionDays * 86_400_000).toISOString(),
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      channels: 2,
      segmentBytes,
    };
    await this.repository.create(recording);
    return recording;
  }

  async state(id: string, state: LiveRecording['state'], failure?: string): Promise<void> {
    await this.repository.setState(id, state, new Date(this.clock()).toISOString(), failure);
  }

  async writeSegment(input: {
    recording: LiveRecording;
    track: RecordingTrack;
    sequence: number;
    bytes: Uint8Array;
    startMs: number;
    endMs: number;
  }): Promise<RecordingSegment> {
    if (!Number.isInteger(input.sequence) || input.sequence < 0 || input.sequence >= 10_000)
      throw new Error('Recording segment sequence exceeds manifest bound');
    if (!input.bytes.byteLength || input.bytes.byteLength > input.recording.segmentBytes)
      throw new Error('Recording segment exceeds configured bound');
    const suffix = `${input.sequence.toString().padStart(8, '0')}-${randomUUID()}`;
    const objectKey = `recordings/${input.recording.workspaceId}/${input.recording.callId}/${input.recording.id}/${input.track}/${suffix}.mulaw`;
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    try {
      await this.objects.put(objectKey, input.bytes, 'audio/basic');
    } catch (error) {
      await this.repository
        .appendSegment({
          artifactId: input.recording.id,
          track: input.track,
          sequence: input.sequence,
          state: 'failed',
          bytes: input.bytes.byteLength,
          startMs: input.startMs,
          endMs: input.endMs,
          timestampEvidence:
            input.track === 'inbound' ? 'provider-media-timestamp' : 'worker-send-resolved',
          error: safeError(error),
        })
        .catch(() => undefined);
      throw error;
    }
    const segment: RecordingSegment = {
      artifactId: input.recording.id,
      track: input.track,
      sequence: input.sequence,
      state: 'available',
      objectKey,
      sha256,
      bytes: input.bytes.byteLength,
      startMs: input.startMs,
      endMs: input.endMs,
      timestampEvidence:
        input.track === 'inbound' ? 'provider-media-timestamp' : 'worker-send-resolved',
    };
    try {
      await this.repository.appendSegment(segment);
    } catch (error) {
      try {
        await this.objects.delete(objectKey);
      } catch {
        await this.repository
          .recordCleanupObject(input.recording.id, objectKey)
          .catch(() => undefined);
      }
      throw error;
    }
    return segment;
  }

  async timeline(event: RecordingTimelineEvent): Promise<void> {
    await this.repository.appendTimeline(event);
  }

  async manifest(workspaceId: string, callId: string, artifactId: string) {
    return this.repository.manifest(workspaceId, callId, artifactId);
  }

  async readSegment(
    workspaceId: string,
    callId: string,
    artifactId: string,
    track: RecordingTrack,
    sequence: number,
    options?: { signal?: AbortSignal },
  ): Promise<{ metadata: RecordingSegment; bytes: Uint8Array }> {
    options?.signal?.throwIfAborted();
    const manifest = await this.manifest(workspaceId, callId, artifactId);
    if (!['available', 'partial'].includes(manifest.state)) throw new RecordingUnavailableError();
    const metadata = manifest.segments.find(
      (item) => item.track === track && item.sequence === sequence && item.state === 'available',
    );
    if (!metadata?.objectKey || !metadata.sha256) throw new RecordingUnavailableError();
    const bytes = await this.objects.get(metadata.objectKey, options);
    options?.signal?.throwIfAborted();
    if (await this.repository.getTombstone(artifactId)) throw new RecordingUnavailableError();
    if (
      bytes.byteLength !== metadata.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== metadata.sha256
    )
      throw new Error('Recording segment integrity check failed');
    return { metadata, bytes };
  }

  async list(workspaceId: string, callId: string, limit = 100) {
    validateSegment(workspaceId, 'workspaceId');
    validateSegment(callId, 'callId');
    return this.repository.list(workspaceId, callId, limit);
  }

  async delete(
    workspaceId: string,
    callId: string,
    artifactId: string,
    reason: 'retention' | 'operator',
  ) {
    return this.repository.tombstone(
      workspaceId,
      callId,
      artifactId,
      reason,
      new Date(this.clock()).toISOString(),
    );
  }
}

export function validateManifestIntegrity(manifest: RecordingManifest): void {
  const identities = new Set<string>();
  for (const segment of manifest.segments) {
    const identity = `${segment.track}:${segment.sequence}`;
    if (identities.has(identity)) throw new Error('Duplicate recording segment');
    identities.add(identity);
    if (segment.endMs < segment.startMs) throw new Error('Invalid recording segment timeline');
  }
}

function validateSegment(value: string, label: string): void {
  if (!SEGMENT.test(value)) throw new Error(`Invalid ${label}`);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Recording upload failed').slice(0, 500);
}
