import type { Pool, PoolClient } from 'pg';
import type { CarrierCallIdMismatchInput } from '../types.ts';

/** Persist the observed alias only after the route has actually bound both call ids. */
export async function recordCarrierCallIdMismatch(
  pool: Pool | PoolClient,
  input: CarrierCallIdMismatchInput,
): Promise<void> {
  const values = [
    input.sessionId,
    input.organizationId,
    input.carrierId,
    input.dialCallId,
    input.streamCallId,
  ];
  const inserted = await pool.query(
    `INSERT INTO ovo_orch_audit_events
       (session_id, organization_id, carrier_id, event_type, dial_call_id, stream_call_id)
     SELECT session_id, organization_id, carrier_id, 'carrier.call_id_mismatch', $4, $5
     FROM ovo_session_routes
     WHERE session_id = $1 AND organization_id = $2 AND carrier_id = $3
       AND carrier_call_id = $4 AND carrier_stream_call_id = $5
     ON CONFLICT DO NOTHING`,
    values,
  );
  if (inserted.rowCount === 1) return;
  const existing = await pool.query(
    `SELECT 1 FROM ovo_orch_audit_events WHERE session_id = $1
       AND organization_id = $2 AND carrier_id = $3
       AND event_type = 'carrier.call_id_mismatch'
       AND dial_call_id = $4 AND stream_call_id = $5`,
    values,
  );
  if (existing.rowCount === 0) throw new Error('Carrier call-id mismatch audit has no bound alias');
}
