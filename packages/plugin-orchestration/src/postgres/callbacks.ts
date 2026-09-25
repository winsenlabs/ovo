import type { Pool, PoolClient } from 'pg';
import type {
  CarrierCallbackCorrelationInput,
  CarrierCallbackResult,
  SessionRouteStatus,
} from '../types.ts';
import { transaction } from './database.ts';
import { assertCompleteCarrierScope, callIdAvailable, lockCarrierCallId } from './call-identity.ts';
import { recordCarrierCallIdMismatch } from './carrier-audit.ts';
import { fromSessionRouteRow, sessionRouteColumns, type SessionRouteRow } from './session-model.ts';

const terminal = new Set<SessionRouteStatus>(['completed', 'failed', 'cancelled']);

function projectedStatus(status: CarrierCallbackCorrelationInput['status']): SessionRouteStatus {
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

async function auditLateDialId(
  client: PoolClient,
  row: SessionRouteRow,
  primaryCallId: string | null,
): Promise<void> {
  if (!primaryCallId || !row.carrier_stream_call_id || primaryCallId === row.carrier_stream_call_id)
    return;
  await recordCarrierCallIdMismatch(client, {
    sessionId: row.session_id,
    organizationId: row.organization_id,
    carrierId: row.carrier_id,
    dialCallId: primaryCallId,
    streamCallId: row.carrier_stream_call_id,
  });
}

async function currentRoute(
  client: PoolClient,
  input: CarrierCallbackCorrelationInput,
  lock = false,
) {
  const result = await client.query<SessionRouteRow>(
    `SELECT ${sessionRouteColumns} FROM ovo_session_routes
     WHERE (($1::text IS NOT NULL AND dial_request_id = $1)
        OR ($2::text IS NOT NULL AND carrier_request_id = $2)
        OR ($3::text IS NOT NULL AND (carrier_call_id = $3 OR carrier_stream_call_id = $3)))
       AND ($4::text IS NULL OR organization_id = $4)
       AND ($5::text IS NULL OR carrier_id = $5)
     LIMIT 2 ${lock ? 'FOR UPDATE' : ''}`,
    [
      input.dialRequestId ?? null,
      input.carrierRequestId ?? null,
      input.carrierCallId ?? null,
      input.organizationId ?? null,
      input.carrierId ?? null,
    ],
  );
  return result.rows;
}

export class CarrierCallbackRepository {
  constructor(private readonly pool: Pool) {}

  async apply(input: CarrierCallbackCorrelationInput): Promise<CarrierCallbackResult> {
    assertCompleteCarrierScope(input);
    return transaction(this.pool, async (client) => {
      const preview = await currentRoute(client, input);
      if (!preview[0]) return { kind: 'unmatched' };
      if (preview.length > 1)
        return { kind: 'correlation_conflict', route: fromSessionRouteRow(preview[0]) };
      await client.query('SELECT id FROM ovo_jobs WHERE id = $1 FOR UPDATE', [preview[0].job_id]);
      if (input.carrierCallId)
        await lockCarrierCallId(
          client,
          preview[0].organization_id,
          preview[0].carrier_id,
          input.carrierCallId,
        );
      const matches = await currentRoute(client, input, true);
      const row = matches[0];
      if (!row) return { kind: 'unmatched' };
      if (matches.length > 1 || row.session_id !== preview[0].session_id)
        return { kind: 'correlation_conflict', route: fromSessionRouteRow(row) };
      if (
        (input.dialRequestId && row.dial_request_id !== input.dialRequestId) ||
        (input.carrierRequestId &&
          row.carrier_request_id &&
          row.carrier_request_id !== input.carrierRequestId) ||
        (input.carrierCallId &&
          row.carrier_call_id &&
          row.carrier_call_id !== input.carrierCallId &&
          row.carrier_stream_call_id !== input.carrierCallId) ||
        (input.carrierCallId &&
          !(await callIdAvailable(
            client,
            row.organization_id,
            row.carrier_id,
            row.job_id,
            input.carrierCallId,
          )))
      ) {
        return { kind: 'correlation_conflict', route: fromSessionRouteRow(row) };
      }
      const primaryCallId =
        row.carrier_call_id ??
        (input.carrierCallId === row.carrier_stream_call_id ? null : (input.carrierCallId ?? null));
      const event = await client.query(
        `INSERT INTO ovo_carrier_callbacks (
           provider, event_id, session_id, dial_request_id, carrier_call_id, status, occurred_at,
           payload, organization_id, carrier_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         ON CONFLICT (organization_id, carrier_id, provider, event_id) DO NOTHING`,
        [
          input.provider,
          input.eventId,
          row.session_id,
          input.dialRequestId ?? null,
          input.carrierCallId ?? null,
          input.status,
          input.occurredAt,
          JSON.stringify(input.payload ?? {}),
          row.organization_id,
          row.carrier_id,
        ],
      );
      if (event.rowCount !== 1) {
        return { kind: 'duplicate', route: fromSessionRouteRow(row) };
      }

      const next = projectedStatus(input.status);
      if (!advances(row.status, next)) {
        if (!row.carrier_call_id && primaryCallId) {
          await client.query(
            `UPDATE ovo_session_routes SET carrier_call_id = $2,
               carrier_request_id = COALESCE(carrier_request_id, $3), updated_at = now()
             WHERE session_id = $1 AND carrier_call_id IS NULL`,
            [row.session_id, primaryCallId, input.carrierRequestId ?? null],
          );
          await client.query(
            `UPDATE ovo_jobs SET carrier_call_id = $2,
               carrier_request_id = COALESCE(carrier_request_id, $3), updated_at = now()
             WHERE id = $1 AND carrier_call_id IS NULL`,
            [row.job_id, primaryCallId, input.carrierRequestId ?? null],
          );
          row.carrier_call_id = primaryCallId;
          await auditLateDialId(client, row, primaryCallId);
        }
        return { kind: 'ignored_out_of_order', route: fromSessionRouteRow(row) };
      }

      const terminalStatus = terminal.has(next);
      const updated = await client.query<SessionRouteRow>(
        `UPDATE ovo_session_routes SET carrier_call_id = COALESCE(carrier_call_id, $2),
           carrier_request_id = COALESCE(carrier_request_id, $6), status = $3,
           accepted_at = CASE WHEN $3 IN ('accepted', 'connected') THEN COALESCE(accepted_at, now()) ELSE accepted_at END,
           connected_at = CASE WHEN $3 = 'connected' THEN COALESCE(connected_at, now()) ELSE connected_at END,
           terminal_at = CASE WHEN $4 THEN COALESCE(terminal_at, now()) ELSE terminal_at END,
           terminal_reason = CASE WHEN $4 THEN COALESCE(terminal_reason, $5) ELSE terminal_reason END,
           updated_at = now()
         WHERE session_id = $1 RETURNING ${sessionRouteColumns}`,
        [
          row.session_id,
          primaryCallId,
          next,
          terminalStatus,
          `carrier:${input.status}`,
          input.carrierRequestId ?? null,
        ],
      );
      await client.query(
        `UPDATE ovo_jobs SET
           status = CASE
             WHEN $2 IN ('completed', 'failed', 'cancelled') THEN $2
             WHEN owner_id = $5 AND owner_epoch = $6 AND lease_expires_at > now() THEN $2
             ELSE status
           END,
           carrier_call_id = COALESCE(carrier_call_id, $3),
           carrier_request_id = COALESCE(carrier_request_id, $7),
           last_error = CASE WHEN $2 IN ('failed', 'cancelled') THEN $4 ELSE last_error END,
           updated_at = now()
         WHERE id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')`,
        [
          row.job_id,
          next,
          primaryCallId,
          `carrier:${input.status}`,
          row.worker_id,
          row.owner_epoch,
          input.carrierRequestId ?? null,
        ],
      );
      await auditLateDialId(client, row, primaryCallId);
      return { kind: 'applied', route: fromSessionRouteRow(updated.rows[0]!) };
    });
  }
}
