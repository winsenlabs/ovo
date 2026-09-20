import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuthenticatedSessionRoute, BeginDialSessionInput, SessionRoute } from '../types.ts';
import { transaction } from './database.ts';
import { fromSessionRouteRow, sessionRouteColumns, type SessionRouteRow } from './session-model.ts';

const terminalStatuses = ['completed', 'failed', 'cancelled'] as const;

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class SessionRepository {
  constructor(private readonly pool: Pool) {}

  async beginDial(input: BeginDialSessionInput): Promise<SessionRoute | undefined> {
    return transaction(this.pool, async (client) => {
      const owned = await client.query(
        `UPDATE ovo_jobs SET status = 'dialing', dial_request_id = $4, updated_at = now()
         WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND status = 'owned'
           AND lease_expires_at > now() AND dial_request_id IS NULL
         RETURNING id`,
        [input.jobId, input.workerId, input.ownerEpoch, input.dialRequestId],
      );
      if (owned.rowCount !== 1) return undefined;
      const inserted = await client.query<SessionRouteRow>(
        `INSERT INTO ovo_session_routes (
           session_id, job_id, organization_id, worker_id, worker_endpoint, owner_epoch,
           generation, dial_request_id, status, handshake_token_hash, handshake_expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'dialing', $9, $10)
         RETURNING ${sessionRouteColumns}`,
        [
          input.sessionId,
          input.jobId,
          input.organizationId,
          input.workerId,
          input.workerEndpoint,
          input.ownerEpoch,
          input.generation,
          input.dialRequestId,
          input.handshakeTokenHash,
          input.handshakeExpiresAt,
        ],
      );
      return fromSessionRouteRow(inserted.rows[0]!);
    });
  }

  async markDialAccepted(input: {
    jobId: string;
    workerId: string;
    ownerEpoch: number;
    dialRequestId: string;
    carrierCallId: string;
  }): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const job = await client.query(
        `UPDATE ovo_jobs SET status = 'accepted', carrier_call_id = $5, updated_at = now(), last_error = NULL
         WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND dial_request_id = $4
           AND status IN ('dialing', 'reconcile_required')
           AND (carrier_call_id IS NULL OR carrier_call_id = $5)
         RETURNING id`,
        [input.jobId, input.workerId, input.ownerEpoch, input.dialRequestId, input.carrierCallId],
      );
      if (job.rowCount !== 1) {
        const alreadyAccepted = await client.query(
          `SELECT id FROM ovo_jobs
           WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND dial_request_id = $4
             AND carrier_call_id = $5 AND status IN ('accepted', 'connected')`,
          [input.jobId, input.workerId, input.ownerEpoch, input.dialRequestId, input.carrierCallId],
        );
        if (alreadyAccepted.rowCount !== 1) return false;
      }
      const route = await client.query(
        `UPDATE ovo_session_routes SET carrier_call_id = $3,
           status = CASE WHEN status = 'dialing' THEN 'accepted' ELSE status END,
           accepted_at = COALESCE(accepted_at, now()), updated_at = now()
         WHERE job_id = $1 AND dial_request_id = $2
           AND (carrier_call_id IS NULL OR carrier_call_id = $3)
           AND status IN ('dialing', 'accepted', 'connected')`,
        [input.jobId, input.dialRequestId, input.carrierCallId],
      );
      if (route.rowCount !== 1) throw new Error('Dial acceptance has no matching session route');
      return true;
    });
  }

  async markDialUnknown(input: {
    jobId: string;
    workerId: string;
    ownerEpoch: number;
    dialRequestId: string;
    reason: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_jobs SET status = 'reconcile_required', last_error = $5, updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND dial_request_id = $4 AND status = 'dialing'`,
      [input.jobId, input.workerId, input.ownerEpoch, input.dialRequestId, input.reason],
    );
    return result.rowCount === 1;
  }

  async prepareReconciledTermination(input: {
    jobId: string;
    workerId: string;
    ownerEpoch: number;
    dialRequestId: string;
    carrierCallId: string;
    reason: string;
  }): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const job = await client.query(
        `UPDATE ovo_jobs SET carrier_call_id = $5, last_error = $6, updated_at = now()
         WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND dial_request_id = $4
           AND status = 'reconcile_required' AND (carrier_call_id IS NULL OR carrier_call_id = $5)
         RETURNING id`,
        [
          input.jobId,
          input.workerId,
          input.ownerEpoch,
          input.dialRequestId,
          input.carrierCallId,
          input.reason,
        ],
      );
      if (job.rowCount !== 1) return false;
      const route = await client.query(
        `UPDATE ovo_session_routes SET carrier_call_id = $3, status = 'terminating',
           accepted_at = COALESCE(accepted_at, now()), terminal_reason = COALESCE(terminal_reason, $4),
           updated_at = now()
         WHERE job_id = $1 AND dial_request_id = $2 AND terminal_at IS NULL
           AND (carrier_call_id IS NULL OR carrier_call_id = $3)`,
        [input.jobId, input.dialRequestId, input.carrierCallId, input.reason],
      );
      if (route.rowCount !== 1) throw new Error('Reconciled dial has no matching session route');
      return true;
    });
  }

  async getByJob(jobId: string): Promise<SessionRoute | undefined> {
    return this.one(`SELECT ${sessionRouteColumns} FROM ovo_session_routes WHERE job_id = $1`, [
      jobId,
    ]);
  }

  async resolve(input: {
    sessionId?: string;
    carrierCallId?: string;
  }): Promise<SessionRoute | undefined> {
    if (!input.sessionId && !input.carrierCallId)
      throw new Error('Route lookup requires correlation');
    return this.one(
      `SELECT ${sessionRouteColumns} FROM ovo_session_routes
       WHERE ($1::uuid IS NOT NULL AND session_id = $1)
          OR ($2::text IS NOT NULL AND carrier_call_id = $2)`,
      [input.sessionId ?? null, input.carrierCallId ?? null],
    );
  }

  async authenticate(
    sessionId: string,
    token: string,
  ): Promise<AuthenticatedSessionRoute | undefined> {
    const result = await this.pool.query<SessionRouteRow>(
      `UPDATE ovo_session_routes SET handshake_claimed_at = now(), updated_at = now()
       WHERE session_id = $1 AND handshake_token_hash = $2 AND handshake_expires_at > now()
         AND handshake_claimed_at IS NULL AND terminal_at IS NULL
       RETURNING ${sessionRouteColumns}`,
      [sessionId, tokenHash(token)],
    );
    const row = result.rows[0];
    return row ? fromSessionRouteRow(row) : undefined;
  }

  async releaseTerminal(jobId: string): Promise<boolean> {
    return transaction(this.pool, async (client) => {
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

  async requestTermination(input: {
    jobId: string;
    workerId: string;
    ownerEpoch: number;
    reason: string;
  }): Promise<{ carrierCallId?: string } | undefined> {
    return transaction(this.pool, async (client) => {
      const owner = await client.query(
        `SELECT id FROM ovo_jobs WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3
         AND status IN ('accepted', 'connected', 'reconcile_required') FOR UPDATE`,
        [input.jobId, input.workerId, input.ownerEpoch],
      );
      if (owner.rowCount !== 1) return undefined;
      const route = await client.query<{ carrier_call_id: string | null }>(
        `UPDATE ovo_session_routes SET status = 'terminating', terminal_reason = COALESCE(terminal_reason, $2),
           updated_at = now()
         WHERE job_id = $1 AND terminal_at IS NULL AND status <> 'terminating'
         RETURNING carrier_call_id`,
        [input.jobId, input.reason],
      );
      if (route.rowCount === 0) {
        const existing = await client.query<{ carrier_call_id: string | null }>(
          `SELECT carrier_call_id FROM ovo_session_routes
           WHERE job_id = $1 AND status = 'terminating' AND terminal_at IS NULL`,
          [input.jobId],
        );
        if (!existing.rows[0]) return undefined;
        return { carrierCallId: existing.rows[0].carrier_call_id ?? undefined };
      }
      return { carrierCallId: route.rows[0]!.carrier_call_id ?? undefined };
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

  async markFailed(input: {
    jobId: string;
    workerId: string;
    ownerEpoch: number;
    reason: string;
  }): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE ovo_jobs SET status = 'failed', last_error = $4, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3
           AND status IN ('owned', 'dialing', 'reconcile_required') RETURNING id`,
        [input.jobId, input.workerId, input.ownerEpoch, input.reason],
      );
      if (result.rowCount !== 1) return false;
      await client.query(
        `UPDATE ovo_session_routes SET status = 'failed', terminal_at = COALESCE(terminal_at, now()),
           terminal_reason = COALESCE(terminal_reason, $2), updated_at = now()
         WHERE job_id = $1 AND status <> ALL($3::text[])`,
        [input.jobId, input.reason, terminalStatuses],
      );
      return true;
    });
  }

  private async one(sql: string, values: unknown[]): Promise<SessionRoute | undefined> {
    const result = await this.pool.query<SessionRouteRow>(sql, values);
    return result.rows[0] ? fromSessionRouteRow(result.rows[0]) : undefined;
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
