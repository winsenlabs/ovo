import type { Pool } from 'pg';
import { RecordingUnavailableError } from '../repository.ts';
import type { RecordingExportJob } from '../types.ts';
import { exportJob } from './rows.ts';

export class PostgresRecordingExports {
  constructor(private readonly pool: Pool) {}

  async create(job: RecordingExportJob): Promise<RecordingExportJob> {
    const result = await this.pool.query(
      `INSERT INTO ovo_recording_exports
       (id,workspace_id,artifact_id,idempotency_key,state,created_at,updated_at,attempts,lease_epoch)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
       WHERE NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones WHERE artifact_id=$3)
       ON CONFLICT(workspace_id,idempotency_key) DO UPDATE SET idempotency_key=excluded.idempotency_key
       RETURNING *`,
      [
        job.id,
        job.workspaceId,
        job.artifactId,
        job.idempotencyKey,
        job.state,
        job.createdAt,
        job.updatedAt,
        job.attempts,
        job.leaseEpoch,
      ],
    );
    if (!result.rows[0]) throw new RecordingUnavailableError();
    const value = exportJob(result.rows[0]);
    if (value.artifactId !== job.artifactId)
      throw new Error('Export idempotency key belongs to a different artifact');
    return value;
  }

  async get(workspaceId: string, id: string): Promise<RecordingExportJob | undefined> {
    const result = await this.pool.query(
      `SELECT e.* FROM ovo_recording_exports e WHERE e.workspace_id=$1 AND e.id=$2
       AND NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones t WHERE t.artifact_id=e.artifact_id)`,
      [workspaceId, id],
    );
    return result.rows[0] ? exportJob(result.rows[0]) : undefined;
  }

  async claim(owner: string, now: string, leaseMs: number, limit: number) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `WITH candidates AS (
           SELECT e.id FROM ovo_recording_exports e
           WHERE (e.state='queued' OR (e.state='running' AND e.lease_expires_at<=$1))
           AND NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones t WHERE t.artifact_id=e.artifact_id)
           ORDER BY e.created_at,e.id FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE ovo_recording_exports e SET state='running',attempts=e.attempts+1,
           lease_owner=$3,lease_epoch=e.lease_epoch+1,
           lease_expires_at=$1::timestamptz+($4::text||' milliseconds')::interval,updated_at=$1
         FROM candidates WHERE e.id=candidates.id RETURNING e.*`,
        [now, Math.min(100, Math.max(1, limit)), owner, leaseMs],
      );
      await client.query('COMMIT');
      return result.rows.map(exportJob);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async settle(
    id: string,
    owner: string,
    epoch: number,
    at: string,
    result:
      | { state: 'succeeded'; outputKey: string; outputSha256: string; outputBytes: number }
      | { state: 'failed'; error: string },
  ) {
    const values =
      result.state === 'succeeded'
        ? [result.outputKey, result.outputSha256, result.outputBytes, null]
        : [null, null, null, result.error];
    const update = await this.pool.query(
      `UPDATE ovo_recording_exports e SET state=$5,updated_at=$4,lease_expires_at=NULL,
       output_key=$6,output_sha256=$7,output_bytes=$8,error=$9
       WHERE e.id=$1 AND e.state='running' AND e.lease_owner=$2 AND e.lease_epoch=$3
       AND e.lease_expires_at>CURRENT_TIMESTAMP
       AND NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones t WHERE t.artifact_id=e.artifact_id)`,
      [id, owner, epoch, at, result.state, ...values],
    );
    if (update.rowCount !== 1) throw new Error('Export lease lost or recording deleted');
  }
}
