import type { PoolClient } from 'pg';

/** Only the old call-id-only application seam may omit both scope fields. */
export function assertCompleteCarrierScope(input: {
  organizationId?: string;
  carrierId?: string;
  carrierCallId?: string;
}): void {
  if (input.organizationId && input.carrierId) return;
  if (!input.organizationId && !input.carrierId && input.carrierCallId) return;
  throw new Error('Carrier correlation requires organizationId and carrierId');
}

/** Serialize all uses of one carrier call id across primary and stream-alias columns. */
export async function lockCarrierCallId(
  client: PoolClient,
  organizationId: string,
  carrierId: string,
  callId: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `carrier-call-id:${organizationId}:${carrierId}:${callId}`,
  ]);
}

export async function callIdAvailable(
  client: PoolClient,
  organizationId: string,
  carrierId: string,
  jobId: string,
  callId: string,
): Promise<boolean> {
  const collision = await client.query(
    `SELECT 1 FROM ovo_session_routes WHERE organization_id = $1 AND carrier_id = $2
       AND job_id <> $3 AND (carrier_call_id = $4 OR carrier_stream_call_id = $4) LIMIT 1`,
    [organizationId, carrierId, jobId, callId],
  );
  return collision.rowCount === 0;
}
