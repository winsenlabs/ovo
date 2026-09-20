import type { Pool, QueryResultRow } from 'pg';
import { boundedLimit } from './database.ts';
import type { CampaignDialJob, CampaignJobPort, DispatchRecord } from './types.ts';

interface OutboxRow extends QueryResultRow {
  id: string;
  topic: 'campaign.dial.candidate';
  aggregate_id: string;
  dedup_key: string;
  payload: CampaignDialJob;
}

function fromRow(row: OutboxRow): DispatchRecord {
  return {
    id: row.id,
    topic: row.topic,
    aggregateId: row.aggregate_id,
    dedupKey: row.dedup_key,
    payload: row.payload,
  };
}

export class OperationsOutbox {
  constructor(private readonly pool: Pool) {}

  async claim(dispatcherId: string, limit = 25, leaseMs = 30_000): Promise<DispatchRecord[]> {
    const safeLimit = boundedLimit(limit);
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000)
      throw new Error('leaseMs is out of range');
    const result = await this.pool.query<OutboxRow>(
      `WITH candidates AS (
         SELECT id FROM ovo_ops_outbox
         WHERE sent_at IS NULL AND available_at <= now()
           AND (claimed_by IS NULL OR claim_expires_at <= now())
         ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE ovo_ops_outbox o SET claimed_by = $2,
         claim_expires_at = now() + $3 * interval '1 millisecond', attempts = attempts + 1
       FROM candidates c WHERE o.id = c.id
       RETURNING o.id, o.topic, o.aggregate_id, o.dedup_key, o.payload`,
      [safeLimit, dispatcherId, leaseMs],
    );
    return result.rows.map(fromRow);
  }

  async markSent(id: string, dispatcherId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_ops_outbox SET sent_at = now(), claimed_by = NULL, claim_expires_at = NULL, last_error = NULL
       WHERE id = $1 AND claimed_by = $2 AND sent_at IS NULL`,
      [id, dispatcherId],
    );
    return result.rowCount === 1;
  }

  async markFailed(
    id: string,
    dispatcherId: string,
    error: string,
    delayMs = 1_000,
  ): Promise<boolean> {
    if (!Number.isInteger(delayMs) || delayMs < 1 || delayMs > 3_600_000)
      throw new Error('delayMs is out of range');
    const result = await this.pool.query(
      `UPDATE ovo_ops_outbox SET claimed_by = NULL, claim_expires_at = NULL, last_error = $3,
         available_at = now() + $4 * interval '1 millisecond'
       WHERE id = $1 AND claimed_by = $2 AND sent_at IS NULL`,
      [id, dispatcherId, error.slice(0, 2_000), delayMs],
    );
    return result.rowCount === 1;
  }

  async getByJobId(jobId: string): Promise<DispatchRecord | undefined> {
    const result = await this.pool.query<OutboxRow>(
      `SELECT id, topic, aggregate_id, dedup_key, payload FROM ovo_ops_outbox
       WHERE aggregate_id = $1 AND topic = 'campaign.dial.candidate'`,
      [jobId],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }
}

export class OperationsOutboxDispatcher {
  constructor(
    private readonly dispatcherId: string,
    private readonly outbox: OperationsOutbox,
    private readonly jobs: CampaignJobPort,
  ) {}

  async flush(limit = 25): Promise<{ sent: number; failed: number }> {
    const records = await this.outbox.claim(this.dispatcherId, limit);
    let sent = 0;
    let failed = 0;
    for (const record of records) {
      try {
        await this.jobs.enqueue({
          jobId: record.aggregateId,
          idempotencyKey: record.dedupKey,
          payload: record.payload as unknown as Record<string, unknown>,
        });
        if (!(await this.outbox.markSent(record.id, this.dispatcherId)))
          throw new Error('Dispatch outbox ownership was lost after enqueue');
        sent += 1;
      } catch (error) {
        failed += 1;
        await this.outbox.markFailed(record.id, this.dispatcherId, (error as Error).message);
      }
    }
    return { sent, failed };
  }
}
