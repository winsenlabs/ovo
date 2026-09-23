import type { Pool, PoolClient } from 'pg';
import type { MarkDialAcceptedInput } from '../types.ts';
import { transaction } from './database.ts';
import { callIdAvailable, lockCarrierCallId } from './call-identity.ts';
import { recordCarrierCallIdMismatch } from './carrier-audit.ts';

async function routeScope(client: PoolClient, jobId: string) {
  const route = await client.query<{ organization_id: string; carrier_id: string }>(
    'SELECT organization_id, carrier_id FROM ovo_session_routes WHERE job_id = $1',
    [jobId],
  );
  return route.rows[0];
}

export class SessionDialRepository {
  constructor(private readonly pool: Pool) {}

  async markDialAccepted(input: MarkDialAcceptedInput): Promise<boolean> {
    if (!input.carrierCallId && !input.carrierRequestId)
      throw new Error('Dial acceptance requires a carrier call or request id');
    return transaction(this.pool, async (client) => {
      const owner = await client.query(
        `SELECT id FROM ovo_jobs WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3
           AND dial_request_id = $4 FOR UPDATE`,
        [input.jobId, input.workerId, input.ownerEpoch, input.dialRequestId],
      );
      if (!owner.rowCount) return false;
      if (input.carrierCallId) {
        const scope = await routeScope(client, input.jobId);
        if (!scope) return false;
        await lockCarrierCallId(
          client,
          scope.organization_id,
          scope.carrier_id,
          input.carrierCallId,
        );
        if (
          !(await callIdAvailable(
            client,
            scope.organization_id,
            scope.carrier_id,
            input.jobId,
            input.carrierCallId,
          ))
        )
          return false;
      }
      const job = await client.query(
        `UPDATE ovo_jobs SET status = CASE WHEN status IN ('dialing', 'reconcile_required')
             THEN 'accepted' ELSE status END, carrier_call_id = COALESCE(carrier_call_id, $5),
           carrier_request_id = COALESCE(carrier_request_id, $6), updated_at = now(), last_error = NULL
         WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3 AND dial_request_id = $4
           AND status IN ('dialing', 'reconcile_required', 'accepted', 'connected')
           AND ($5::text IS NULL OR carrier_call_id IS NULL OR carrier_call_id = $5)
           AND ($6::text IS NULL OR carrier_request_id IS NULL OR carrier_request_id = $6)
         RETURNING id`,
        [
          input.jobId,
          input.workerId,
          input.ownerEpoch,
          input.dialRequestId,
          input.carrierCallId ?? null,
          input.carrierRequestId ?? null,
        ],
      );
      if (job.rowCount !== 1) return false;
      const route = await client.query<{
        session_id: string;
        organization_id: string;
        carrier_id: string;
        carrier_call_id: string | null;
        carrier_stream_call_id: string | null;
      }>(
        `UPDATE ovo_session_routes SET carrier_call_id = COALESCE(carrier_call_id, $3),
           carrier_request_id = COALESCE(carrier_request_id, $4),
           status = CASE WHEN status = 'dialing' THEN 'accepted' ELSE status END,
           accepted_at = COALESCE(accepted_at, now()), updated_at = now()
         WHERE job_id = $1 AND dial_request_id = $2
           AND ($3::text IS NULL OR carrier_call_id IS NULL OR carrier_call_id = $3)
           AND ($4::text IS NULL OR carrier_request_id IS NULL OR carrier_request_id = $4)
           AND status IN ('dialing', 'accepted', 'connected')
         RETURNING session_id, organization_id, carrier_id, carrier_call_id,
           carrier_stream_call_id`,
        [
          input.jobId,
          input.dialRequestId,
          input.carrierCallId ?? null,
          input.carrierRequestId ?? null,
        ],
      );
      if (route.rowCount !== 1) throw new Error('Dial acceptance has no matching session route');
      const bound = route.rows[0]!;
      if (
        input.carrierCallId &&
        bound.carrier_call_id === input.carrierCallId &&
        bound.carrier_stream_call_id &&
        bound.carrier_stream_call_id !== input.carrierCallId
      )
        await recordCarrierCallIdMismatch(client, {
          sessionId: bound.session_id,
          organizationId: bound.organization_id,
          carrierId: bound.carrier_id,
          dialCallId: input.carrierCallId,
          streamCallId: bound.carrier_stream_call_id,
        });
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
      const owner = await client.query(
        `SELECT id FROM ovo_jobs WHERE id = $1 AND owner_id = $2 AND owner_epoch = $3
           AND dial_request_id = $4 FOR UPDATE`,
        [input.jobId, input.workerId, input.ownerEpoch, input.dialRequestId],
      );
      if (!owner.rowCount) return false;
      const scope = await routeScope(client, input.jobId);
      if (!scope) return false;
      await lockCarrierCallId(client, scope.organization_id, scope.carrier_id, input.carrierCallId);
      if (
        !(await callIdAvailable(
          client,
          scope.organization_id,
          scope.carrier_id,
          input.jobId,
          input.carrierCallId,
        ))
      )
        return false;
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
}
