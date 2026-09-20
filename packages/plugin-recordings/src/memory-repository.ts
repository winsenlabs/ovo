import type { RecordingRepository } from './repository.ts';
import { RecordingUnavailableError } from './repository.ts';
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

/** Deterministic local/fault-test repository. Production uses PostgresRecordingRepository. */
export class MemoryRecordingRepository implements RecordingRepository {
  private readonly recordings = new Map<string, LiveRecording>();
  private readonly segments = new Map<string, RecordingSegment[]>();
  private readonly timeline = new Map<string, RecordingTimelineEvent[]>();
  private readonly tombstones = new Map<string, RecordingTombstone>();
  private readonly cleanupObjects = new Map<string, Set<string>>();
  private readonly exports = new Map<string, RecordingExportJob>();

  async create(recording: LiveRecording): Promise<void> {
    if (this.recordings.has(recording.id)) throw new Error('Recording already exists');
    this.recordings.set(recording.id, structuredClone(recording));
  }

  async findByArtifact(workspaceId: string, id: string): Promise<LiveRecording | undefined> {
    if (this.tombstones.has(id)) return undefined;
    const item = this.recordings.get(id);
    return item?.workspaceId === workspaceId ? structuredClone(item) : undefined;
  }

  async get(workspaceId: string, callId: string, id: string): Promise<LiveRecording | undefined> {
    if (this.tombstones.has(id)) return undefined;
    const item = this.recordings.get(id);
    return item?.workspaceId === workspaceId && item.callId === callId
      ? structuredClone(item)
      : undefined;
  }

  async list(workspaceId: string, callId: string, limit = 100): Promise<LiveRecording[]> {
    return [...this.recordings.values()]
      .filter(
        (item) =>
          item.workspaceId === workspaceId &&
          item.callId === callId &&
          !this.tombstones.has(item.id),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, Math.min(100, Math.max(1, limit)))
      .map((item) => structuredClone(item));
  }

  async setState(id: string, state: LiveRecording['state'], updatedAt: string, failure?: string) {
    const item = this.recordings.get(id);
    if (!item) throw new RecordingUnavailableError();
    this.recordings.set(id, { ...item, state, updatedAt, failure });
  }

  async appendSegment(segment: RecordingSegment) {
    if (this.tombstones.has(segment.artifactId)) throw new RecordingUnavailableError();
    if (segment.sequence < 0 || segment.sequence >= 10_000)
      throw new Error('Recording segment sequence exceeds manifest bound');
    const items = this.segments.get(segment.artifactId) ?? [];
    if (items.some((item) => item.track === segment.track && item.sequence === segment.sequence))
      throw new Error('Recording segment already exists');
    items.push(structuredClone(segment));
    this.segments.set(segment.artifactId, items);
  }

  async appendTimeline(event: RecordingTimelineEvent) {
    if (this.tombstones.has(event.artifactId)) throw new RecordingUnavailableError();
    const items = this.timeline.get(event.artifactId) ?? [];
    if (items.length >= 20_000) throw new Error('Recording timeline limit reached');
    items.push(structuredClone(event));
    this.timeline.set(event.artifactId, items);
  }

  async manifest(workspaceId: string, callId: string, id: string): Promise<RecordingManifest> {
    const item = await this.get(workspaceId, callId, id);
    if (!item) throw new RecordingUnavailableError();
    return {
      ...item,
      segments: structuredClone(this.segments.get(id) ?? []),
      timeline: structuredClone(this.timeline.get(id) ?? []),
    };
  }

  async pageExpired(
    now: string,
    cursor: RetentionCursor | undefined,
    limit: number,
  ): Promise<RetentionPage> {
    const items = [...this.recordings.values()]
      .filter((item) => item.expiresAt <= now && !this.tombstones.has(item.id))
      .filter(
        (item) =>
          !cursor ||
          item.expiresAt > cursor.expiresAt ||
          (item.expiresAt === cursor.expiresAt && item.id > cursor.artifactId),
      )
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.id.localeCompare(b.id))
      .slice(0, Math.min(100, Math.max(1, limit)));
    const last = items.at(-1);
    return {
      items: structuredClone(items),
      nextCursor:
        items.length === limit && last
          ? { expiresAt: last.expiresAt, artifactId: last.id }
          : undefined,
    };
  }

  async tombstone(
    workspaceId: string,
    callId: string,
    id: string,
    reason: RecordingTombstone['reason'],
    at: string,
  ): Promise<RecordingTombstone> {
    const existing = this.tombstones.get(id);
    if (existing) return structuredClone(existing);
    const item = this.recordings.get(id);
    if (!item || item.workspaceId !== workspaceId || item.callId !== callId)
      throw new RecordingUnavailableError();
    const row: RecordingTombstone = {
      artifactId: id,
      workspaceId,
      callId,
      requestedAt: at,
      reason,
      cleanupState: 'pending',
      attempts: 0,
    };
    this.tombstones.set(id, row);
    this.recordings.set(id, { ...item, state: 'expired', updatedAt: at });
    for (const job of this.exports.values()) {
      if (job.artifactId === id && ['queued', 'running'].includes(job.state)) {
        this.exports.set(job.id, { ...job, state: 'cancelled', updatedAt: at });
      }
    }
    return structuredClone(row);
  }

  async getTombstone(id: string) {
    const item = this.tombstones.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async pendingTombstones(limit: number) {
    return [...this.tombstones.values()]
      .filter((item) => item.cleanupState !== 'complete')
      .slice(0, Math.min(100, Math.max(1, limit)))
      .map((item) => structuredClone(item));
  }

  async recordCleanupObject(id: string, objectKey: string) {
    const keys = this.cleanupObjects.get(id) ?? new Set<string>();
    keys.add(objectKey);
    this.cleanupObjects.set(id, keys);
    const tombstone = this.tombstones.get(id);
    if (tombstone)
      this.tombstones.set(id, {
        ...tombstone,
        attempts: tombstone.attempts + 1,
        cleanupState: 'pending',
        completedAt: undefined,
      });
  }

  async objectKeysForDeletion(id: string) {
    const segmentKeys = (this.segments.get(id) ?? []).flatMap((item) =>
      item.objectKey ? [item.objectKey] : [],
    );
    const exportKeys = [...this.exports.values()].flatMap((item) =>
      item.artifactId === id && item.outputKey ? [item.outputKey] : [],
    );
    return [...new Set([...segmentKeys, ...exportKeys, ...(this.cleanupObjects.get(id) ?? [])])];
  }

  async recordCleanup(id: string, at: string, error: string | undefined, expectedAttempts: number) {
    const item = this.tombstones.get(id);
    if (!item) throw new Error('Recording tombstone not found');
    if (item.attempts !== expectedAttempts) return false;
    this.tombstones.set(id, {
      ...item,
      attempts: item.attempts + 1,
      cleanupState: error ? 'failed' : 'complete',
      lastError: error,
      completedAt: error ? undefined : at,
    });
    return true;
  }

  async createExport(job: RecordingExportJob) {
    const existing = [...this.exports.values()].find(
      (item) => item.workspaceId === job.workspaceId && item.idempotencyKey === job.idempotencyKey,
    );
    if (existing) return structuredClone(existing);
    if (this.tombstones.has(job.artifactId)) throw new RecordingUnavailableError();
    this.exports.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async getExport(workspaceId: string, id: string) {
    const item = this.exports.get(id);
    if (!item || item.workspaceId !== workspaceId || this.tombstones.has(item.artifactId))
      return undefined;
    return structuredClone(item);
  }

  async claimExports(owner: string, now: string, leaseMs: number, limit: number) {
    const current = Date.parse(now);
    const eligible = [...this.exports.values()]
      .filter(
        (item) =>
          !this.tombstones.has(item.artifactId) &&
          (item.state === 'queued' ||
            (item.state === 'running' && Date.parse(item.leaseExpiresAt ?? '') <= current)),
      )
      .slice(0, Math.min(100, Math.max(1, limit)));
    return eligible.map((item) => {
      const claimed: RecordingExportJob = {
        ...item,
        state: 'running',
        attempts: item.attempts + 1,
        leaseOwner: owner,
        leaseEpoch: item.leaseEpoch + 1,
        leaseExpiresAt: new Date(current + leaseMs).toISOString(),
        updatedAt: now,
      };
      this.exports.set(item.id, claimed);
      return structuredClone(claimed);
    });
  }

  async settleExport(
    id: string,
    owner: string,
    epoch: number,
    at: string,
    result:
      | { state: 'succeeded'; outputKey: string; outputSha256: string; outputBytes: number }
      | { state: 'failed'; error: string },
  ) {
    const item = this.exports.get(id);
    if (
      !item ||
      item.state !== 'running' ||
      item.leaseOwner !== owner ||
      item.leaseEpoch !== epoch ||
      Date.parse(item.leaseExpiresAt ?? '') <= Date.parse(at)
    )
      throw new Error('Export lease lost');
    if (this.tombstones.has(item.artifactId)) throw new RecordingUnavailableError();
    this.exports.set(id, { ...item, ...result, updatedAt: at, leaseExpiresAt: undefined });
  }
}
