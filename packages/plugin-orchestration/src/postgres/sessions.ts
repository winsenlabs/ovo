import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  AuthenticatedSessionRoute,
  BeginDialSessionInput,
  RouteLookup,
  SessionRoute,
} from '../types.ts';
import { transaction } from './database.ts';
import { fromSessionRouteRow, sessionRouteColumns, type SessionRouteRow } from './session-model.ts';

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class SessionRepository {
  constructor(private readonly pool: Pool) {}

  async beginDial(input: BeginDialSessionInput): Promise<SessionRoute | undefined> {
    return transaction(this.pool, async (client) => {
      const owned = await client.query<{ carrier_id: string }>(
        `UPDATE ovo_jobs SET status = 'dialing', dial_request_id = $4,
           carrier_id = COALESCE($5, carrier_id), binding_id = $6,
           carrier_request_id = $7, updated_at = now()
         WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND status = 'owned'
           AND lease_expires_at > now() AND dial_request_id IS NULL
         RETURNING carrier_id`,
        [
          input.jobId,
          input.workerId,
          input.ownerEpoch,
          input.dialRequestId,
          input.carrierId ?? null,
          input.bindingId ?? null,
          input.carrierRequestId ?? null,
        ],
      );
      if (owned.rowCount !== 1) return undefined;
      const slot = await client.query<{ ownership_epoch: string }>(
        `SELECT ownership_epoch FROM ovo_worker_slots
         WHERE worker_id = $1 AND lease_expires_at > now()`,
        [input.workerId],
      );
      const inserted = await client.query<SessionRouteRow>(
        `INSERT INTO ovo_session_routes (
           session_id, job_id, organization_id, worker_id, worker_endpoint, owner_epoch,
           generation, dial_request_id, carrier_id, binding_id, carrier_request_id,
           worker_slot_epoch,
           status, handshake_token_hash, handshake_expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $11, $12, $13, $14, 'dialing', $9, $10)
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
          owned.rows[0]!.carrier_id,
          input.bindingId ?? null,
          input.carrierRequestId ?? null,
          slot.rows[0]?.ownership_epoch ?? null,
        ],
      );
      return fromSessionRouteRow(inserted.rows[0]!);
    });
  }

  async getByJob(jobId: string): Promise<SessionRoute | undefined> {
    return this.one(`SELECT ${sessionRouteColumns} FROM ovo_session_routes WHERE job_id = $1`, [
      jobId,
    ]);
  }

  async resolve(input: RouteLookup): Promise<SessionRoute | undefined> {
    if (!input.sessionId && !input.carrierCallId && !input.dialRequestId && !input.carrierRequestId)
      throw new Error('Route lookup requires correlation');
    const result = await this.pool.query<SessionRouteRow>(
      `SELECT ${sessionRouteColumns} FROM ovo_session_routes
       WHERE ($1::uuid IS NULL OR session_id = $1)
         AND ($2::text IS NULL OR carrier_call_id = $2 OR carrier_stream_call_id = $2)
         AND ($3::text IS NULL OR dial_request_id = $3)
         AND ($4::text IS NULL OR carrier_request_id = $4) LIMIT 2`,
      [
        input.sessionId ?? null,
        input.carrierCallId ?? null,
        input.dialRequestId ?? null,
        input.carrierRequestId ?? null,
      ],
    );
    return result.rows.length === 1 ? fromSessionRouteRow(result.rows[0]!) : undefined;
  }

  async authenticate(
    sessionId: string,
    token: string,
  ): Promise<AuthenticatedSessionRoute | undefined> {
    const result = await this.pool.query<SessionRouteRow>(
      `UPDATE ovo_session_routes SET handshake_claimed_at = now(), updated_at = now(),
         worker_slot_epoch = COALESCE(worker_slot_epoch,
           (SELECT ownership_epoch FROM ovo_worker_slots
            WHERE worker_id = ovo_session_routes.worker_id AND lease_expires_at > now()))
       WHERE session_id = $1 AND handshake_token_hash = $2 AND handshake_expires_at > now()
         AND handshake_claimed_at IS NULL AND terminal_at IS NULL
         AND status IN ('dialing', 'accepted', 'connected')
       RETURNING ${sessionRouteColumns}`,
      [sessionId, tokenHash(token)],
    );
    const row = result.rows[0];
    return row ? fromSessionRouteRow(row) : undefined;
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
         AND status IN ('dialing', 'accepted', 'connected', 'reconcile_required') FOR UPDATE`,
        [input.jobId, input.workerId, input.ownerEpoch],
      );
      if (owner.rowCount !== 1) return undefined;
      const route = await client.query<{
        carrier_call_id: string | null;
        carrier_request_id: string | null;
      }>(
        `UPDATE ovo_session_routes SET status = 'terminating', terminal_reason = COALESCE(terminal_reason, $2),
           updated_at = now()
         WHERE job_id = $1 AND terminal_at IS NULL AND status <> 'terminating'
         RETURNING carrier_call_id, carrier_request_id`,
        [input.jobId, input.reason],
      );
      if (route.rowCount === 0) {
        const existing = await client.query<{
          carrier_call_id: string | null;
          carrier_request_id: string | null;
        }>(
          `SELECT carrier_call_id, carrier_request_id FROM ovo_session_routes
           WHERE job_id = $1 AND status = 'terminating' AND terminal_at IS NULL`,
          [input.jobId],
        );
        if (!existing.rows[0]) return undefined;
        return {
          carrierCallId: existing.rows[0].carrier_call_id ?? undefined,
          carrierRequestId: existing.rows[0].carrier_request_id ?? undefined,
        };
      }
      return {
        carrierCallId: route.rows[0]!.carrier_call_id ?? undefined,
        carrierRequestId: route.rows[0]!.carrier_request_id ?? undefined,
      };
    });
  }

  private async one(sql: string, values: unknown[]): Promise<SessionRoute | undefined> {
    const result = await this.pool.query<SessionRouteRow>(sql, values);
    return result.rows[0] ? fromSessionRouteRow(result.rows[0]) : undefined;
  }
}
