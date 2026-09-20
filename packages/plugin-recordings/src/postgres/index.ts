import pg, { type PoolConfig } from 'pg';
import type { RecordingRepository } from '../repository.ts';
import type {
  LiveRecording,
  RecordingExportJob,
  RecordingSegment,
  RecordingTimelineEvent,
  RecordingTombstone,
  RetentionCursor,
} from '../types.ts';
import { PostgresRecordingArtifacts } from './artifacts.ts';
import { PostgresRecordingExports } from './exports.ts';
import { runRecordingMigrations } from './migrations.ts';

export class PostgresRecordingRepository implements RecordingRepository {
  readonly pool: pg.Pool;
  private readonly ownsPool: boolean;
  private readonly artifacts: PostgresRecordingArtifacts;
  private readonly exports: PostgresRecordingExports;

  constructor(config: PoolConfig | pg.Pool) {
    this.ownsPool = !(config instanceof pg.Pool);
    this.pool = config instanceof pg.Pool ? config : new pg.Pool(config);
    this.artifacts = new PostgresRecordingArtifacts(this.pool);
    this.exports = new PostgresRecordingExports(this.pool);
  }

  async migrate() {
    await runRecordingMigrations(this.pool);
  }

  create(item: LiveRecording) {
    return this.artifacts.create(item);
  }
  findByArtifact(workspaceId: string, id: string) {
    return this.artifacts.findByArtifact(workspaceId, id);
  }
  get(workspaceId: string, callId: string, id: string) {
    return this.artifacts.get(workspaceId, callId, id);
  }
  list(workspaceId: string, callId: string, limit?: number) {
    return this.artifacts.list(workspaceId, callId, limit);
  }
  setState(id: string, state: LiveRecording['state'], at: string, failure?: string) {
    return this.artifacts.setState(id, state, at, failure);
  }
  appendSegment(segment: RecordingSegment) {
    return this.artifacts.appendSegment(segment);
  }
  appendTimeline(event: RecordingTimelineEvent) {
    return this.artifacts.appendTimeline(event);
  }
  manifest(workspaceId: string, callId: string, id: string) {
    return this.artifacts.manifest(workspaceId, callId, id);
  }
  pageExpired(now: string, cursor: RetentionCursor | undefined, limit: number) {
    return this.artifacts.pageExpired(now, cursor, limit);
  }
  tombstone(
    workspaceId: string,
    callId: string,
    id: string,
    reason: RecordingTombstone['reason'],
    at: string,
  ) {
    return this.artifacts.tombstone(workspaceId, callId, id, reason, at);
  }
  getTombstone(id: string) {
    return this.artifacts.getTombstone(id);
  }
  pendingTombstones(limit: number) {
    return this.artifacts.pendingTombstones(limit);
  }
  recordCleanupObject(id: string, objectKey: string) {
    return this.artifacts.recordCleanupObject(id, objectKey);
  }
  objectKeysForDeletion(id: string) {
    return this.artifacts.objectKeysForDeletion(id);
  }
  recordCleanup(id: string, at: string, error: string | undefined, expectedAttempts: number) {
    return this.artifacts.recordCleanup(id, at, error, expectedAttempts);
  }
  createExport(job: RecordingExportJob) {
    return this.exports.create(job);
  }
  getExport(workspaceId: string, id: string) {
    return this.exports.get(workspaceId, id);
  }
  claimExports(owner: string, now: string, leaseMs: number, limit: number) {
    return this.exports.claim(owner, now, leaseMs, limit);
  }
  settleExport(
    id: string,
    owner: string,
    epoch: number,
    at: string,
    result: Parameters<PostgresRecordingExports['settle']>[4],
  ) {
    return this.exports.settle(id, owner, epoch, at, result);
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}
