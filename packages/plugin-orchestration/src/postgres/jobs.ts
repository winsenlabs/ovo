import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ClaimedJob, DurableJob, JobReference } from '../types.ts';
import { fromJobRow, jobColumns, transaction, type JobRow } from './database.ts';

export class JobRepository {
  constructor(private readonly pool: Pool) {}

  async enqueue(input: {
    id: string;
    workspaceId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    notBefore?: Date;
  }): Promise<{ job: DurableJob; created: boolean }> {
    return transaction(this.pool, async (client) => {
      const inserted = await client.query<JobRow>(
        `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status, not_before)
         VALUES ($1, $2, $3, $4::jsonb, 'queued', COALESCE($5, now()))
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING ${jobColumns}`,
        [
          input.id,
          input.workspaceId,
          input.idempotencyKey,
          JSON.stringify(input.payload),
          input.notBefore ?? null,
        ],
      );
      if (inserted.rowCount === 1) {
        const reference: JobReference = { schemaVersion: 1, jobId: input.id };
        await client.query(
          `INSERT INTO ovo_outbox (id, topic, aggregate_id, payload) VALUES ($1, 'job.eligible', $2, $3::jsonb)`,
          [randomUUID(), input.id, JSON.stringify(reference)],
        );
        return { job: fromJobRow(inserted.rows[0]!), created: true };
      }
      const existing = await client.query<JobRow>(
        `SELECT ${jobColumns} FROM ovo_jobs WHERE workspace_id = $1 AND idempotency_key = $2`,
        [input.workspaceId, input.idempotencyKey],
      );
      if (!existing.rows[0]) throw new Error('Idempotent job disappeared during enqueue');
      return { job: fromJobRow(existing.rows[0]), created: false };
    });
  }

  async claim(jobId: string, workerId: string, leaseMs: number): Promise<ClaimedJob | undefined> {
    if (!Number.isInteger(leaseMs) || leaseMs <= 0)
      throw new Error('leaseMs must be a positive integer');
    return transaction(this.pool, async (client) => {
      const result = await client.query<JobRow>(
        `UPDATE ovo_jobs SET status = 'owned', owner_id = $2, owner_epoch = owner_epoch + 1,
           lease_expires_at = now() + ($3 * interval '1 millisecond'), updated_at = now(), last_error = NULL
         WHERE id = $1 AND not_before <= now()
           AND (status = 'queued' OR (status = 'owned' AND lease_expires_at < now()))
         RETURNING ${jobColumns}`,
        [jobId, workerId, leaseMs],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      await client.query(
        `INSERT INTO ovo_job_attempts (job_id, epoch, worker_id, state) VALUES ($1, $2, $3, 'owned')`,
        [jobId, row.owner_epoch, workerId],
      );
      const job = fromJobRow(row);
      if (!job.ownerId || !job.leaseExpiresAt)
        throw new Error('Claim returned incomplete ownership');
      return { ...job, ownerId: job.ownerId, leaseExpiresAt: job.leaseExpiresAt };
    });
  }

  async heartbeat(
    jobId: string,
    workerId: string,
    epoch: number,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_jobs SET lease_expires_at = now() + ($4 * interval '1 millisecond'), updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND status IN ('owned', 'dialing', 'accepted', 'connected')`,
      [jobId, workerId, epoch, leaseMs],
    );
    return result.rowCount === 1;
  }

  async release(
    jobId: string,
    workerId: string,
    epoch: number,
    reason: string,
    notBefore = new Date(),
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_jobs SET status = 'queued', owner_id = NULL, lease_expires_at = NULL,
         last_error = $4, not_before = $5, updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND status = 'owned'`,
      [jobId, workerId, epoch, reason, notBefore],
    );
    return result.rowCount === 1;
  }

  async beginDial(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_jobs SET status = 'dialing', dial_request_id = $4, updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND status = 'owned'
         AND lease_expires_at > now() AND dial_request_id IS NULL`,
      [jobId, workerId, epoch, requestId],
    );
    return result.rowCount === 1;
  }

  async markDialAccepted(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    carrierCallId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_jobs SET status = 'accepted', carrier_call_id = $5, updated_at = now(), last_error = NULL
       WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND dial_request_id = $4
         AND status IN ('dialing', 'reconcile_required')`,
      [jobId, workerId, epoch, requestId, carrierCallId],
    );
    return result.rowCount === 1;
  }

  async markDialUnknown(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    reason: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_jobs SET status = 'reconcile_required', last_error = $5, updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND dial_request_id = $4 AND status = 'dialing'`,
      [jobId, workerId, epoch, requestId, reason],
    );
    return result.rowCount === 1;
  }

  async markFailed(
    jobId: string,
    workerId: string,
    epoch: number,
    reason: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_jobs SET status = 'failed', last_error = $4, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND status IN ('owned', 'dialing', 'reconcile_required')`,
      [jobId, workerId, epoch, reason],
    );
    return result.rowCount === 1;
  }

  async get(jobId: string): Promise<DurableJob | undefined> {
    const result = await this.pool.query<JobRow>(
      `SELECT ${jobColumns} FROM ovo_jobs WHERE id = $1`,
      [jobId],
    );
    return result.rows[0] ? fromJobRow(result.rows[0]) : undefined;
  }
}
