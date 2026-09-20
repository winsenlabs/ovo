import type { Pool, PoolClient } from 'pg';
import type {
  CarrierCallbackInput,
  CarrierCallbackResult,
  SessionRouteStatus,
} from '../types.ts';
import { transaction } from './database.ts';
import { fromSessionRouteRow, sessionRouteColumns, type SessionRouteRow } from './session-model.ts';

const terminal = new Set<SessionRouteStatus>(['completed', 'failed', 'cancelled']);

function projectedStatus(status: CarrierCallbackInput['status']): SessionRouteStatus {
  switch (status) {
    case 'initiated':
    case 'ringing':
      return 'accepted';
    case 'answered':
      return 'connected';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'busy':
    case 'failed':
    case 'no_answer':
      return 'failed';
  }
}

function advances(current: SessionRouteStatus, next: SessionRouteStatus): boolean {
  if (terminal.has(current)) return false;
  if (next === 'completed' || next === 'failed' || next === 'cancelled') return true;
  if (current === 'terminating') return false;
  if (next === 'connected') return current === 'dialing' || current === 'accepted';
  return current === 'dialing' && next === 'accepted';
}

async function currentRoute(client: PoolClient, input: CarrierCallbackInput) {
  const result = await client.query<SessionRouteRow>(
    `SELECT ${sessionRouteColumns} FROM ovo_session_routes
     WHERE ($1::text IS NOT NULL AND dial_request_id = $1)
        OR ($2::text IS NOT NULL AND carrier_call_id = $2)
     FOR UPDATE`,
    [input.dialRequestId ?? null, input.carrierCallId],
  );
  return result.rows[0];
}

export class CarrierCallbackRepository {
  constructor(private readonly pool: Pool) {}

  async apply(input: CarrierCallbackInput): Promise<CarrierCallbackResult> {
    return transaction(this.pool, async (client) => {
      const row = await currentRoute(client, input);
      if (!row) return { kind: 'unmatched' };
      if (row.carrier_call_id && row.carrier_call_id !== input.carrierCallId) {
        return { kind: 'correlation_conflict', route: fromSessionRouteRow(row) };
      }
      const event = await client.query(
        `INSERT INTO ovo_carrier_callbacks (
           provider, event_id, session_id, dial_request_id, carrier_call_id, status, occurred_at, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (provider, event_id) DO NOTHING`,
        [
          input.provider,
          input.eventId,
          row.session_id,
          input.dialRequestId ?? null,
          input.carrierCallId,
          input.status,
          input.occurredAt,
          JSON.stringify(input.payload ?? {}),
        ],
      );
      if (event.rowCount !== 1) {
        return { kind: 'duplicate', route: fromSessionRouteRow(row) };
      }

      const next = projectedStatus(input.status);
      if (!advances(row.status, next)) {
        if (!row.carrier_call_id) {
          await client.query(
            `UPDATE ovo_session_routes SET carrier_call_id = $2, updated_at = now()
             WHERE session_id = $1 AND carrier_call_id IS NULL`,
            [row.session_id, input.carrierCallId],
          );
          await client.query(
            `UPDATE ovo_jobs SET carrier_call_id = $2, updated_at = now()
             WHERE id = $1 AND carrier_call_id IS NULL`,
            [row.job_id, input.carrierCallId],
          );
          row.carrier_call_id = input.carrierCallId;
        }
        return { kind: 'ignored_out_of_order', route: fromSessionRouteRow(row) };
      }

      const terminalStatus = terminal.has(next);
      const updated = await client.query<SessionRouteRow>(
        `UPDATE ovo_session_routes SET carrier_call_id = $2, status = $3,
           accepted_at = CASE WHEN $3 IN ('accepted', 'connected') THEN COALESCE(accepted_at, now()) ELSE accepted_at END,
           connected_at = CASE WHEN $3 = 'connected' THEN COALESCE(connected_at, now()) ELSE connected_at END,
           terminal_at = CASE WHEN $4 THEN COALESCE(terminal_at, now()) ELSE terminal_at END,
           terminal_reason = CASE WHEN $4 THEN COALESCE(terminal_reason, $5) ELSE terminal_reason END,
           updated_at = now()
         WHERE session_id = $1 RETURNING ${sessionRouteColumns}`,
        [row.session_id, input.carrierCallId, next, terminalStatus, `carrier:${input.status}`],
      );
      await client.query(
        `UPDATE ovo_jobs SET
           status = CASE
             WHEN $2 IN ('completed', 'failed', 'cancelled') THEN $2
             WHEN owner_id = $5 AND owner_epoch = $6 AND lease_expires_at > now() THEN $2
             ELSE status
           END,
           carrier_call_id = $3,
           last_error = CASE WHEN $2 IN ('failed', 'cancelled') THEN $4 ELSE last_error END,
           updated_at = now()
         WHERE id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')`,
        [
          row.job_id,
          next,
          input.carrierCallId,
          `carrier:${input.status}`,
          row.worker_id,
          row.owner_epoch,
        ],
      );
      return { kind: 'applied', route: fromSessionRouteRow(updated.rows[0]!) };
    });
  }
}
