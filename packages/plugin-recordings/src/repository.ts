import type {
  LiveRecording,
  RecordingExportJob,
  RecordingManifest,
  RecordingSegment,
  RecordingTimelineEvent,
  RecordingTombstone,
  RetentionCursor,
  RetentionPage,
} from './types.ts';

export interface RecordingRepository {
  create(recording: LiveRecording): Promise<void>;
  findByArtifact(workspaceId: string, artifactId: string): Promise<LiveRecording | undefined>;
  get(workspaceId: string, callId: string, artifactId: string): Promise<LiveRecording | undefined>;
  list(workspaceId: string, callId: string, limit?: number): Promise<LiveRecording[]>;
  setState(
    artifactId: string,
    state: LiveRecording['state'],
    updatedAt: string,
    failure?: string,
  ): Promise<void>;
  appendSegment(segment: RecordingSegment): Promise<void>;
  appendTimeline(event: RecordingTimelineEvent): Promise<void>;
  manifest(workspaceId: string, callId: string, artifactId: string): Promise<RecordingManifest>;
  /**
   * Settles up to `limit` artifacts created before `createdBefore` that never finalized (the
   * worker that captured them exited mid-call): `partial` when a segment is available, otherwise
   * `failed`. Returns how many it settled.
   */
  recoverAbandoned(createdBefore: string, at: string, limit: number): Promise<number>;
  pageExpired(
    now: string,
    cursor: RetentionCursor | undefined,
    limit: number,
  ): Promise<RetentionPage>;
  tombstone(
    workspaceId: string,
    callId: string,
    artifactId: string,
    reason: RecordingTombstone['reason'],
    at: string,
  ): Promise<RecordingTombstone>;
  getTombstone(artifactId: string): Promise<RecordingTombstone | undefined>;
  pendingTombstones(limit: number): Promise<RecordingTombstone[]>;
  recordCleanupObject(artifactId: string, objectKey: string): Promise<void>;
  objectKeysForDeletion(artifactId: string): Promise<string[]>;
  recordCleanup(
    artifactId: string,
    at: string,
    error: string | undefined,
    expectedAttempts: number,
  ): Promise<boolean>;
  createExport(job: RecordingExportJob): Promise<RecordingExportJob>;
  getExport(workspaceId: string, id: string): Promise<RecordingExportJob | undefined>;
  claimExports(
    owner: string,
    now: string,
    leaseMs: number,
    limit: number,
  ): Promise<RecordingExportJob[]>;
  settleExport(
    id: string,
    owner: string,
    epoch: number,
    at: string,
    result:
      | { state: 'succeeded'; outputKey: string; outputSha256: string; outputBytes: number }
      | { state: 'failed'; error: string },
  ): Promise<void>;
}

/** Why `recoverAbandoned` settled an artifact. */
export const ABANDONED_FAILURE = 'Capture stopped without finalizing (the worker exited mid-call)';

export class RecordingUnavailableError extends Error {
  constructor(message = 'Recording is unavailable') {
    super(message);
    this.name = 'RecordingUnavailableError';
  }
}
