import type { Pool } from 'pg';
import type { SessionRoute } from '../types.ts';
import { transaction } from './database.ts';
import { fromSessionRouteRow, sessionRouteColumns, type SessionRouteRow } from './session-model.ts';

export class SessionReleaseRepository {
  constructor(private readonly pool: Pool) {}

  async markFailed(input: {
    jobId: string;
    workerId: string;
    ownerEpoch: number;
    reason: string;
  }): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE ovo_jobs SET status = 'failed', last_error = $4,
           lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3
           AND status IN ('owned', 'dialing', 'reconcile_required') RETURNING id`,
        [input.jobId, input.workerId, input.ownerEpoch, input.reason],
      );
      if (result.rowCount !== 1) return false;
      await client.query(
        `UPDATE ovo_session_routes SET status = 'failed',
           terminal_at = COALESCE(terminal_at, now()),
           terminal_reason = COALESCE(terminal_reason, $2), updated_at = now()
         WHERE job_id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')`,
        [input.jobId, input.reason],
      );
      return true;
    });
  }

  async releaseTerminal(jobId: string): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT id FROM ovo_jobs WHERE id = $1 FOR UPDATE', [jobId]);
      const route = await client.query(
        `UPDATE ovo_session_routes SET released_at = now(), updated_at = now()
         WHERE job_id = $1 AND terminal_at IS NOT NULL AND released_at IS NULL
         RETURNING job_id`,
        [jobId],
      );
      if (route.rowCount !== 1) return false;
      await client.query(
        `UPDATE ovo_jobs SET owner_id = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND status IN ('completed', 'failed', 'cancelled')`,
        [jobId],
      );
      await client.query(
        `UPDATE ovo_job_attempts SET settled_at = COALESCE(settled_at, now()), state = 'released'
         WHERE job_id = $1 AND settled_at IS NULL`,
        [jobId],
      );
      return true;
    });
  }

  async releaseTerminalBatch(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    const rows = await this.pool.query<{ job_id: string }>(
      `SELECT job_id FROM ovo_session_routes
       WHERE terminal_at IS NOT NULL AND released_at IS NULL
       ORDER BY updated_at LIMIT $1`,
      [limit],
    );
    let released = 0;
    for (const row of rows.rows) if (await this.releaseTerminal(row.job_id)) released += 1;
    return released;
  }

  async listUnreleasedTerminal(limit: number): Promise<SessionRoute[]> {
    const result = await this.pool.query<SessionRouteRow>(
      `SELECT ${sessionRouteColumns}
       FROM ovo_session_routes
       WHERE terminal_at IS NOT NULL AND released_at IS NULL
       ORDER BY terminal_at, session_id
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(fromSessionRouteRow);
  }
}
