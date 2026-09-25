import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { RecordingUnavailableError } from '../repository.ts';
import type {
  LiveRecording,
  RecordingManifest,
  RecordingSegment,
  RecordingTimelineEvent,
  RecordingTombstone,
  RetentionCursor,
  RetentionPage,
} from '../types.ts';
import { recording, tombstone } from './rows.ts';

export class PostgresRecordingArtifacts {
  constructor(private readonly pool: Pool) {}

  async create(item: LiveRecording) {
    await this.pool.query(
      `INSERT INTO ovo_recording_artifacts
      (id,workspace_id,call_id,source,state,created_at,updated_at,expires_at,codec,sample_rate,channels,segment_bytes,failure)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        item.id,
        item.workspaceId,
        item.callId,
        item.source,
        item.state,
        item.createdAt,
        item.updatedAt,
        item.expiresAt,
        item.codec,
        item.sampleRate,
        item.channels,
        item.segmentBytes,
        item.failure ?? null,
      ],
    );
  }

  async get(workspaceId: string, callId: string, id: string) {
    const result = await this.pool.query(
      `SELECT a.* FROM ovo_recording_artifacts a
       WHERE a.workspace_id=$1 AND a.call_id=$2 AND a.id=$3
       AND NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones t WHERE t.artifact_id=a.id)`,
      [workspaceId, callId, id],
    );
    return result.rows[0] ? recording(result.rows[0]) : undefined;
  }

  async findByArtifact(workspaceId: string, id: string) {
    const result = await this.pool.query(
      `SELECT a.* FROM ovo_recording_artifacts a
       WHERE a.workspace_id=$1 AND a.id=$2
       AND NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones t WHERE t.artifact_id=a.id)`,
      [workspaceId, id],
    );
    return result.rows[0] ? recording(result.rows[0]) : undefined;
  }

  async list(workspaceId: string, callId: string, limit = 100) {
    const result = await this.pool.query(
      `SELECT a.* FROM ovo_recording_artifacts a
       WHERE a.workspace_id=$1 AND a.call_id=$2
       AND NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones t WHERE t.artifact_id=a.id)
       ORDER BY a.created_at,a.id LIMIT $3`,
      [workspaceId, callId, cap(limit)],
    );
    return result.rows.map(recording);
  }

  async setState(id: string, state: LiveRecording['state'], updatedAt: string, failure?: string) {
    const result = await this.pool.query(
      `UPDATE ovo_recording_artifacts SET state=$2,updated_at=$3,failure=$4 WHERE id=$1
       AND NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones WHERE artifact_id=$1)`,
      [id, state, updatedAt, failure ?? null],
    );
    if (result.rowCount !== 1) throw new RecordingUnavailableError();
  }

  async appendSegment(segment: RecordingSegment) {
    await this.withLiveArtifact(segment.artifactId, (client) =>
      client.query(
        `INSERT INTO ovo_recording_segments
         (artifact_id,track,sequence,state,object_key,sha256,bytes,start_ms,end_ms,timestamp_evidence,error)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          segment.artifactId,
          segment.track,
          segment.sequence,
          segment.state,
          segment.objectKey ?? null,
          segment.sha256 ?? null,
          segment.bytes,
          segment.startMs,
          segment.endMs,
          segment.timestampEvidence,
          segment.error ?? null,
        ],
      ),
    );
  }

  async appendTimeline(event: RecordingTimelineEvent) {
    await this.withLiveArtifact(event.artifactId, (client) =>
      client.query(
        `INSERT INTO ovo_recording_timeline(artifact_id,sequence,at_ms,type,evidence,reference,phase)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          event.artifactId,
          event.sequence,
          event.atMs,
          event.type,
          event.evidence,
          event.reference,
          event.phase ?? null,
        ],
      ),
    );
  }

  async manifest(workspaceId: string, callId: string, id: string): Promise<RecordingManifest> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const artifact = await client.query(
        `SELECT a.* FROM ovo_recording_artifacts a
         WHERE a.workspace_id=$1 AND a.call_id=$2 AND a.id=$3
         AND NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones t WHERE t.artifact_id=a.id)
         FOR SHARE`,
        [workspaceId, callId, id],
      );
      if (!artifact.rows[0]) throw new RecordingUnavailableError();
      const segments = await client.query(
        'SELECT * FROM ovo_recording_segments WHERE artifact_id=$1 ORDER BY track,sequence LIMIT 10000',
        [id],
      );
      const timeline = await client.query(
        'SELECT * FROM ovo_recording_timeline WHERE artifact_id=$1 ORDER BY sequence LIMIT 20000',
        [id],
      );
      await client.query('COMMIT');
      return {
        ...recording(artifact.rows[0]),
        segments: segments.rows.map(segmentRow),
        timeline: timeline.rows.map(timelineRow),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async pageExpired(
    now: string,
    cursor: RetentionCursor | undefined,
    limit: number,
  ): Promise<RetentionPage> {
    const result = await this.pool.query(
      `SELECT a.* FROM ovo_recording_artifacts a WHERE a.expires_at<=$1 AND a.state!='expired'
       AND NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones t WHERE t.artifact_id=a.id)
       AND ($2::timestamptz IS NULL OR (a.expires_at,a.id)>($2::timestamptz,$3::uuid))
       ORDER BY a.expires_at,a.id LIMIT $4`,
      [now, cursor?.expiresAt ?? null, cursor?.artifactId ?? null, cap(limit)],
    );
    const items = result.rows.map(recording),
      last = items.at(-1);
    return {
      items,
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
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const item = await client.query(
        'SELECT id FROM ovo_recording_artifacts WHERE workspace_id=$1 AND call_id=$2 AND id=$3 FOR UPDATE',
        [workspaceId, callId, id],
      );
      if (!item.rows[0]) throw new RecordingUnavailableError();
      await client.query(
        `INSERT INTO ovo_recording_tombstones(artifact_id,workspace_id,call_id,requested_at,reason,cleanup_state)
         VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT(artifact_id) DO NOTHING`,
        [id, workspaceId, callId, at, reason],
      );
      await client.query(
        "UPDATE ovo_recording_artifacts SET state='expired',updated_at=$2 WHERE id=$1",
        [id, at],
      );
      await client.query(
        "UPDATE ovo_recording_exports SET state='cancelled',updated_at=$2 WHERE artifact_id=$1 AND state IN ('queued','running')",
        [id, at],
      );
      const row = await client.query(
        'SELECT * FROM ovo_recording_tombstones WHERE artifact_id=$1',
        [id],
      );
      await client.query('COMMIT');
      return tombstone(row.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getTombstone(id: string) {
    const result = await this.pool.query(
      'SELECT * FROM ovo_recording_tombstones WHERE artifact_id=$1',
      [id],
    );
    return result.rows[0] ? tombstone(result.rows[0]) : undefined;
  }

  async pendingTombstones(limit: number) {
    const result = await this.pool.query(
      "SELECT * FROM ovo_recording_tombstones WHERE cleanup_state!='complete' ORDER BY requested_at,artifact_id LIMIT $1",
      [cap(limit)],
    );
    return result.rows.map(tombstone);
  }

  async recordCleanupObject(id: string, objectKey: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ovo_recording_cleanup_objects(artifact_id,object_key) VALUES($1,$2)
         ON CONFLICT(artifact_id,object_key) DO NOTHING`,
        [id, objectKey],
      );
      await client.query(
        `UPDATE ovo_recording_tombstones SET cleanup_state='pending',completed_at=NULL,
         attempts=attempts+1
         WHERE artifact_id=$1`,
        [id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async objectKeysForDeletion(id: string) {
    const result = await this.pool.query(
      `SELECT object_key AS key FROM ovo_recording_segments WHERE artifact_id=$1 AND object_key IS NOT NULL
       UNION SELECT output_key AS key FROM ovo_recording_exports WHERE artifact_id=$1 AND output_key IS NOT NULL
       UNION SELECT object_key AS key FROM ovo_recording_cleanup_objects WHERE artifact_id=$1`,
      [id],
    );
    return result.rows.map((row) => String(row.key));
  }

  async recordCleanup(id: string, at: string, error: string | undefined, expectedAttempts: number) {
    const result = await this.pool.query(
      `UPDATE ovo_recording_tombstones SET attempts=attempts+1,cleanup_state=$2,last_error=$3,completed_at=$4
       WHERE artifact_id=$1 AND attempts=$5`,
      [id, error ? 'failed' : 'complete', error ?? null, error ? null : at, expectedAttempts],
    );
    return result.rowCount === 1;
  }

  private async withLiveArtifact<T>(
    id: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const artifact = await client.query(
        'SELECT id FROM ovo_recording_artifacts WHERE id=$1 FOR SHARE',
        [id],
      );
      if (!artifact.rows[0]) throw new RecordingUnavailableError();
      const deleted = await client.query(
        'SELECT 1 FROM ovo_recording_tombstones WHERE artifact_id=$1',
        [id],
      );
      if (deleted.rows[0]) throw new RecordingUnavailableError();
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function segmentRow(row: QueryResultRow): RecordingSegment {
  return {
    artifactId: String(row.artifact_id),
    track: row.track,
    sequence: Number(row.sequence),
    state: row.state,
    objectKey: row.object_key ?? undefined,
    sha256: row.sha256 ?? undefined,
    bytes: Number(row.bytes),
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    timestampEvidence: row.timestamp_evidence,
    error: row.error ?? undefined,
  };
}
function timelineRow(row: QueryResultRow): RecordingTimelineEvent {
  return {
    artifactId: String(row.artifact_id),
    sequence: Number(row.sequence),
    atMs: Number(row.at_ms),
    type: row.type,
    evidence: row.evidence,
    reference: String(row.reference),
    phase: row.phase ?? undefined,
  };
}
function cap(value: number) {
  return Math.min(100, Math.max(1, value));
}
