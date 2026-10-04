import type { Pool } from 'pg';
import type { JobReference, OutboxRecord } from '../types.ts';

export class OutboxRepository {
  constructor(private readonly pool: Pool) {}

  async claim(publisherId: string, limit = 25, claimMs = 30_000): Promise<OutboxRecord[]> {
    const result = await this.pool.query<{
      id: string;
      topic: string;
      aggregate_id: string;
      payload: JobReference;
    }>(
      `WITH candidates AS (
         SELECT id FROM ovo_outbox
         WHERE sent_at IS NULL AND (publishing_until IS NULL OR publishing_until < now())
         ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       UPDATE ovo_outbox o SET publishing_by = $1,
         publishing_until = now() + ($3 * interval '1 millisecond'), attempts = attempts + 1
       FROM candidates c WHERE o.id = c.id
       RETURNING o.id, o.topic, o.aggregate_id, o.payload`,
      [publisherId, limit, claimMs],
    );
    return result.rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      aggregateId: row.aggregate_id,
      payload: row.payload,
    }));
  }

  async markSent(id: string, publisherId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_outbox SET sent_at = now(), publishing_by = NULL, publishing_until = NULL, last_error = NULL
       WHERE id = $1 AND publishing_by = $2 AND sent_at IS NULL`,
      [id, publisherId],
    );
    return result.rowCount === 1;
  }

  async markFailed(id: string, publisherId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE ovo_outbox SET publishing_by = NULL, publishing_until = NULL, last_error = $3
       WHERE id = $1 AND publishing_by = $2 AND sent_at IS NULL`,
      [id, publisherId, error.slice(0, 2000)],
    );
  }
}
