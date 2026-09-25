import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from './database.ts';

interface Candidate {
  id: string;
  status: string;
  hint_count: number;
  dial_request_id: string | null;
}

/** Postgres remains the eligibility authority; SQS deliveries are disposable wake-up hints. */
export class JobHintRepository {
  constructor(private readonly pool: Pool) {}

  async sweep(limit = 100): Promise<{ hinted: number; poisoned: string[] }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Hint sweep limit must be between 1 and 100');
    return transaction(this.pool, async (client) => {
      const candidates = await client.query<Candidate>(
        `SELECT id, status, hint_count, dial_request_id FROM ovo_jobs
         WHERE (
           (status = 'queued' AND not_before <= now()) OR
           (status IN ('owned','dialing','reconcile_required','accepted','connected')
             AND (lease_expires_at IS NULL OR lease_expires_at < now()))
         )
           AND (hinted_at IS NULL OR hinted_at < now() - interval '150 seconds')
         ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      let hinted = 0;
      const poisoned: string[] = [];
      for (const row of candidates.rows) {
        if (row.hint_count >= 20 && row.dial_request_id === null &&
          (row.status === 'queued' || row.status === 'owned')) {
          await client.query(
            `UPDATE ovo_jobs SET status = 'failed', owner_id = NULL, lease_expires_at = NULL,
               last_error = 'hint_exhausted', hinted_at = now(), hint_count = hint_count + 1,
               updated_at = now() WHERE id = $1`,
            [row.id],
          );
          poisoned.push(row.id);
          continue;
        }
        await client.query(
          `UPDATE ovo_jobs SET hinted_at = now(), hint_count = hint_count + 1,
             updated_at = now() WHERE id = $1`,
          [row.id],
        );
        await client.query(
          `INSERT INTO ovo_outbox (id, topic, aggregate_id, payload)
           VALUES ($1, 'job.eligible', $2, $3::jsonb)`,
          [randomUUID(), row.id, JSON.stringify({ schemaVersion: 1, jobId: row.id })],
        );
        hinted += 1;
      }
      return { hinted, poisoned };
    });
  }

  async resetHint(jobId: string): Promise<void> {
    await this.pool.query('UPDATE ovo_jobs SET hinted_at = NULL WHERE id = $1', [jobId]);
  }
}
